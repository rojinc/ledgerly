import type { Groups, Identities, Members, Persons, Shares } from '@ledgerly/core/generated/rows'
import { type MergeMembers, mergeMembersSchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { logProblem } from '@ledgerly/server/http/log'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { Query } from 'node-appwrite'
import {
  IntoDeleted,
  intoDeleted,
  joinedHere,
  memberOf,
  moveIdentities,
  moveMembers,
  moveReminders,
  moveShares,
  moveSubjects,
  subjectsOf,
} from './merge'
import { cursorsOf, moveInputs, moveTemplates } from './merge-inputs'
import { getRowOrNull, isAppwriteError } from './rows'
import type { Services } from './services'

// identity-and-invites.md#merging-two-persons, steps 2–4, run by /claim (and bootstrap's claim).
// Logs hold IDs and counts only (security-and-privacy.md).

/** How long one claim spends on merges: well inside the function's 15 s timeout. */
export const MERGE_BUDGET_MS = 9_000

const PAGE = 100

/** What the merges did: the groups U joined, and how many merges finished. */
export type MergesResult = { joined: string[]; finished: string[] }

/**
 * Carries on with every merge into U (`idx_mergedInto`) that isn't finished, until `deadline`
 * (epoch ms). A merge moves P's identities last, once everything else is done, so P still
 * having an identity is what marks it unfinished: P had one to be merged at all, and
 * `resolvePerson()` adds any new one for U. So does `mergeResumeAt`: U has since joined one of
 * P's groups, and the merge carries on there, even one that had finished (#358).
 */
export async function finishMerges(
  services: Services,
  userId: string,
  intoId: string,
  deadline: number,
): Promise<MergesResult> {
  const result: MergesResult = { joined: [], finished: [] }
  for (const placeholder of await mergedInto(services.db, intoId)) {
    if (Date.now() >= deadline) break
    // Only a placeholder is ever merged: one with an account, or deleted, is left alone.
    if (placeholder.userId || placeholder.deletedAt) continue
    if (!placeholder.mergeResumeAt && !(await hasIdentity(services.db, placeholder.$id))) continue
    try {
      // A deletion ends every merge into U (step 2), one with only unguarded writes left too.
      if (await intoDeleted(services.db, intoId)) throw new IntoDeleted()
      const { joined, finished } = await runSteps(services, userId, placeholder, intoId, deadline)
      result.joined.push(...joined)
      if (finished) result.finished.push(placeholder.$id)
    } catch (error) {
      if (!(error instanceof IntoDeleted)) throw error
      logProblem('merge_stopped_into_deleted', { personId: placeholder.$id, intoPersonId: intoId })
      break
    }
  }
  return result
}

/**
 * Steps 2 and 3 for P, one group at a time: P's member row there, then, where U is joined, the
 * group's templates, inputs, activity subjects and shares, before the next group. A cut-off then
 * leaves at most one group part done, and a group that can't go on now (a statement being
 * finalized) waits whole. One whose finalize starts after its member row moved waits part done,
 * and a later claim finishes it first. Then reminders, and P's identities once nothing else names
 * P (step 4).
 */
async function runSteps(
  services: Services,
  userId: string,
  placeholder: Persons,
  intoId: string,
  deadline: number,
): Promise<{ joined: string[]; finished: boolean }> {
  const { db, now } = services
  const fromId = placeholder.$id
  const merge = { from: fromId, into: intoId }
  const ids = { personId: fromId, intoPersonId: intoId }
  const kept = new Set<string>()
  const joined: string[] = []
  const putOff = new Set<string>()
  const moved = { inputs: 0, voided: 0, shares: 0, subjects: 0, skipped: 0 }
  const recorded = memberDatesOf(placeholder) ?? []
  const cursors = cursorsOf(placeholder)
  // Step 3 never plans a posted row's items without step 1's dates (#301), so a group without
  // them waits whole, P's row included, and keeps the merge open. A kept group needs none.
  const ready = (groupId: string) => {
    if (recorded.some((entry) => entry.groupId === groupId)) return true
    logProblem('merge_no_member_dates', { personId: fromId, groupId })
    return false
  }
  let done = true
  // Only P's groups can name P; never U's others, so a merge costs what P had. A group P has no
  // row in any more comes first: step 2 is done there, so it may be part done, and a later claim
  // finishes it before starting another, even after one was put off. Then the rest, in the order
  // step 1 listed them. P's member rows count too, in case an add landed outside the list.
  const listed = placeholder.mergeGroupIds ?? []
  const own = await groupsOf(db, fromId)
  const groupIds = new Set([
    ...listed.filter((groupId) => !own.includes(groupId)),
    ...listed,
    ...own,
  ])
  for (const groupId of groupIds) {
    if (Date.now() >= deadline) {
      done = false
      break
    }
    const members = await moveMembers(services, userId, fromId, intoId, [groupId], deadline, ready)
    joined.push(...members.joined)
    if (members.kept.size > 0) {
      kept.add(groupId)
      continue
    }
    if (members.putOff.length > 0) {
      putOff.add(groupId)
      continue
    }
    if (!members.done) {
      done = false
      break
    }
    // Inputs, templates and activity rows come to name U only where U is joined (#338, #347).
    // Elsewhere they'd link the placeholder to U's account (D-016), so they stay on P, logged by
    // ID, and don't hold the merge open; P's shares there still do (`stray()`).
    if (!(await joinedHere(db, groupId, intoId))) {
      logProblem('merge_left_inputs', { ...ids, groupId })
      const left = await subjectsOf(db, fromId, groupId)
      if (left > 0) logProblem('merge_left_subjects', { ...ids, groupId, count: left })
      // Shares wait too: a share batch that saw U join meanwhile would move them while the
      // inputs still name P, and nothing would come back to rename them.
      continue
    }
    // Templates first, so an expansion from now on names U.
    const templates = await moveTemplates(db, merge, [groupId], deadline)
    moved.inputs += templates.rewritten
    moved.skipped += templates.skipped
    if (templates.putOff.length > 0) {
      putOff.add(groupId)
      continue
    }
    const inputs = await moveInputs(db, merge, [groupId], now, deadline, recorded, cursors)
    moved.inputs += inputs.rewritten
    moved.voided += inputs.voided
    moved.skipped += inputs.skipped
    if (inputs.putOff.length > 0) {
      putOff.add(groupId)
      continue
    }
    if (templates.cutOff || inputs.cutOff) {
      done = false
      break
    }
    // Rows left as they are keep the merge open, but their group's shares can still move.
    if (!templates.done || !inputs.done) done = false
    // Activity rows about P are about U from now on (#257): the feed names U, not "A former
    // member".
    const subjects = await moveSubjects(db, fromId, intoId, [groupId], deadline)
    moved.subjects += subjects.moved
    if (!subjects.done) {
      done = false
      break
    }
    // U's row was removed since the check: a share moved to U would be one with no member row
    // (I-3), so P's stay, and `stray()` keeps the merge open while one is left.
    if (!(await memberOf(db, groupId, intoId))) continue
    // Shares last: the rule for a posted row needs P's share to tell the row was P's.
    const shares = await moveShares(db, fromId, intoId, [groupId], deadline)
    moved.shares += shares.moved
    if (shares.putOff.length > 0) putOff.add(groupId)
    else if (!shares.done) {
      done = false
      break
    }
  }
  const reminders = await moveReminders(db, fromId, intoId, kept, deadline)
  const counts = {
    groupsJoined: joined.length,
    inputs: moved.inputs,
    voided: moved.voided,
    shares: moved.shares,
    subjects: moved.subjects,
    reminders: reminders.moved,
    leftAsTheyAre: moved.skipped,
  }
  if (
    done &&
    putOff.size === 0 &&
    reminders.done &&
    Date.now() < deadline &&
    !(await stray(db, fromId, intoId, kept))
  ) {
    const identities = await moveIdentities(db, fromId, intoId, deadline)
    logProblem('merge_finished', { ...ids, counts: { ...counts, identities } })
    // A later join's mark goes with them, unless a newer one landed meanwhile (#358). Cut off
    // partway, some identities are still P's, and the next claim moves the rest.
    const unmarked = await clearResume(db, placeholder)
    return { joined, finished: unmarked && !(await hasIdentity(db, fromId)) }
  }
  logProblem('merge_carries_on', { ...ids, counts: { ...counts, groupsPutOff: putOff.size } })
  return { joined, finished: false }
}

/**
 * Whether P still has a member row or a share outside the kept groups once each group was seen
 * to: in a group this claim didn't list (a row added since, or a share whose member row was
 * removed). It's logged by ID and keeps the merge open, so no share of P's is moved to a U with
 * no member row there (I-3).
 */
async function stray(
  db: Db,
  fromId: string,
  intoId: string,
  kept: ReadonlySet<string>,
): Promise<boolean> {
  for (const tableId of [TABLES.members, TABLES.shares]) {
    const { rows } = await db.listRows<Members | Shares>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        Query.equal('personId', fromId),
        ...[...kept].map((groupId) => Query.notEqual('groupId', groupId)),
        Query.limit(1),
      ],
      total: false,
    })
    const row = rows[0]
    if (row) {
      logProblem('merge_left_stray_row', {
        personId: fromId,
        intoPersonId: intoId,
        groupId: row.groupId,
        table: tableId === TABLES.members ? 'members' : 'shares',
        rowId: row.$id,
      })
      return true
    }
  }
  return false
}

/** The member dates step 1 recorded for P (#242 B2); undefined if there are none it can read. */
function memberDatesOf(placeholder: Persons): MergeMembers | undefined {
  if (placeholder.mergeMembersJson === null) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(placeholder.mergeMembersJson)
  } catch {
    raw = undefined
  }
  const parsed = mergeMembersSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  logProblem('merge_member_dates_unreadable', { personId: placeholder.$id })
  return undefined
}

/** The persons merged into U. */
async function mergedInto(db: Db, intoId: string): Promise<Persons[]> {
  const found: Persons[] = []
  let cursor: string | undefined
  for (;;) {
    const { rows } = await db.listRows<Persons>({
      databaseId: DATABASE_ID,
      tableId: TABLES.persons,
      queries: [
        Query.equal('mergedInto', intoId),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    found.push(...rows)
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return found
    cursor = last.$id
  }
}

/**
 * Clears P's `mergeResumeAt` (#358), staged and then checked: only if P's mark and `rev` are still as
 * read with P (each mark writes a fresh `rev`), so a join that marked P again meanwhile isn't lost.
 * True once P has no mark.
 */
export async function clearResume(db: Db, placeholder: Persons): Promise<boolean> {
  // Read without one: a join (another merge's step 2, say) may have marked P since.
  if (!placeholder.mergeResumeAt) {
    return !(await getRowOrNull<Persons>(db, TABLES.persons, placeholder.$id))?.mergeResumeAt
  }
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: placeholder.$id,
        data: { mergeResumeAt: null },
      })
      const stored = await getRowOrNull<Persons>(db, TABLES.persons, placeholder.$id)
      if (stored?.mergeResumeAt !== placeholder.mergeResumeAt || stored.rev !== placeholder.rev) {
        throw new Raced()
      }
    })
    return true
  } catch (error) {
    if (error instanceof Raced || isAppwriteError(error, 409)) return false
    throw error
  }
}

async function hasIdentity(db: Db, personId: string): Promise<boolean> {
  const { rows } = await db.listRows<Identities>({
    databaseId: DATABASE_ID,
    tableId: TABLES.identities,
    queries: [Query.equal('personId', personId), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}

/**
 * Every group the person has a member row in (`idx_person_status`), archived ones too, but a
 * personal group: a placeholder is never in one (`add-member` refuses), so nothing there names P.
 */
async function groupsOf(db: Db, personId: string): Promise<string[]> {
  const groupIds: string[] = []
  let cursor: string | undefined
  for (;;) {
    const { rows } = await db.listRows<Members>({
      databaseId: DATABASE_ID,
      tableId: TABLES.members,
      queries: [
        Query.equal('personId', personId),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    groupIds.push(...rows.map((row) => row.groupId))
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return notPersonal(db, groupIds)
    cursor = last.$id
  }
}

async function notPersonal(db: Db, groupIds: readonly string[]): Promise<string[]> {
  const personal = new Set<string>()
  for (let start = 0; start < groupIds.length; start += PAGE) {
    const { rows } = await db.listRows<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      queries: [
        Query.equal('$id', groupIds.slice(start, start + PAGE)),
        Query.equal('type', 'personal'),
        Query.limit(PAGE),
      ],
      total: false,
    })
    for (const row of rows) personal.add(row.$id)
  }
  return groupIds.filter((groupId) => !personal.has(groupId))
}
