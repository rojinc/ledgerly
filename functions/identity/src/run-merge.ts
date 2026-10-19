import type { Groups, Identities, Members, Persons, Shares } from '@ledgerly/core/generated/rows'
import { type MergeMembers, mergeMembersSchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'
import { memberOf, moveIdentities, moveMembers, moveReminders, moveShares } from './merge'
import { cursorsOf, moveInputs, moveTemplates } from './merge-inputs'
import type { Services } from './services'

// identity-and-invites.md#merging-two-persons, steps 2–4, run by /claim (and bootstrap's claim).
// Logs hold IDs and counts only (security-and-privacy.md).

/** How long one claim spends on merges: well inside the function's 15 s timeout. */
export const MERGE_BUDGET_MS = 9_000

const PAGE = 100

/** What the merges did: the groups U joined, and how many merges finished. */
export type MergesResult = { joined: string[]; finished: number }

/**
 * Carries on with every merge into U (`idx_mergedInto`) that isn't finished, until `deadline`
 * (epoch ms). A merge moves P's identities last, once everything else is done, so P still
 * having an identity is what marks it unfinished: P had one to be merged at all, and
 * `resolvePerson()` adds any new one for U.
 */
export async function finishMerges(
  services: Services,
  userId: string,
  intoId: string,
  deadline: number,
): Promise<MergesResult> {
  const result: MergesResult = { joined: [], finished: 0 }
  for (const placeholder of await mergedInto(services.db, intoId)) {
    if (Date.now() >= deadline) break
    // Only a placeholder is ever merged: one with an account, or deleted, is left alone.
    if (placeholder.userId || placeholder.deletedAt) continue
    if (!(await hasIdentity(services.db, placeholder.$id))) continue
    const { joined, finished } = await runMerge(services, userId, placeholder, intoId, deadline)
    result.joined.push(...joined)
    if (finished) result.finished += 1
  }
  return result
}

/**
 * Steps 2 and 3 for P, one group at a time: P's member row there, then the group's templates,
 * inputs and shares, before the next group. A cut-off then leaves at most one group part done,
 * and a group that can't go on now (a statement being finalized) waits whole. One whose finalize
 * starts after its member row moved waits part done, and a later claim finishes it first. Then
 * reminders, and P's identities once nothing else names P (step 4).
 */
async function runMerge(
  services: Services,
  userId: string,
  placeholder: Persons,
  intoId: string,
  deadline: number,
): Promise<{ joined: string[]; finished: boolean }> {
  const { db, now } = services
  const fromId = placeholder.$id
  const merge = { from: fromId, into: intoId }
  const kept = new Set<string>()
  const joined: string[] = []
  const putOff = new Set<string>()
  const moved = { inputs: 0, voided: 0, shares: 0, skipped: 0 }
  const recorded = memberDatesOf(placeholder) ?? []
  const cursors = cursorsOf(placeholder)
  // Step 3 never plans a posted row's items without step 1's dates (#301), so a group without
  // them waits whole, P's row included, and keeps the merge open. A kept group needs none.
  const ready = (groupId: string) => {
    if (recorded.some((entry) => entry.groupId === groupId)) return true
    console.error(`merge ${fromId}: no recorded member dates for group ${groupId}`)
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
    // Neither has a row here (U's, once P's, was removed since): a share moved to U would be one
    // with no member row (I-3), so P's stay, and `stray()` keeps the merge open while one is left.
    // An input naming P names a non-member already, so renaming it changed nothing there.
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
  const counts = `${joined.length} groups joined, ${moved.inputs} inputs, ${moved.voided} voided, ${moved.shares} shares, ${reminders.moved} reminders, ${moved.skipped} left as they are`
  if (
    done &&
    putOff.size === 0 &&
    reminders.done &&
    Date.now() < deadline &&
    !(await stray(db, fromId, intoId, kept))
  ) {
    const identities = await moveIdentities(db, fromId, intoId, deadline)
    console.log(`merge ${fromId} into ${intoId}: ${counts}, ${identities} identities`)
    // Cut off partway, some identities are still P's, and the next claim moves the rest.
    return { joined, finished: !(await hasIdentity(db, fromId)) }
  }
  console.log(
    `merge ${fromId} into ${intoId} carries on next claim: ${counts}, ${putOff.size} groups put off`,
  )
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
      console.warn(
        `merge ${fromId} into ${intoId} left ${tableId} row ${row.$id} in group ${row.groupId} for a later claim`,
      )
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
  console.error(`merge ${placeholder.$id}: its recorded member dates are unreadable`)
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
