import type { Groups, Identities, Members, Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'
import { moveIdentities, moveMembers, moveShares } from './merge'
import { moveInputs, moveTemplates } from './merge-inputs'
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
    if (!(await hasIdentity(services.db, placeholder.$id))) continue
    const { joined, finished } = await runMerge(services, userId, placeholder.$id, intoId, deadline)
    result.joined.push(...joined)
    if (finished) result.finished += 1
  }
  return result
}

/** Steps 2 and 3 for P, then its identities once nothing else names P (step 4). */
async function runMerge(
  services: Services,
  userId: string,
  fromId: string,
  intoId: string,
  deadline: number,
): Promise<{ joined: string[]; finished: boolean }> {
  const { db, now } = services
  const merge = { from: fromId, into: intoId }
  const members = await moveMembers(services, userId, fromId, intoId, deadline)
  // P's groups are U's now, so every group of U's but the kept ones may still name P.
  const groupIds = (await groupsOf(db, intoId)).filter((groupId) => !members.kept.has(groupId))
  // Templates first, so an expansion from now on names U.
  const templates = await moveTemplates(db, merge, groupIds, deadline)
  const inputs = await moveInputs(db, merge, groupIds, now, deadline)
  const shares = await moveShares(db, fromId, intoId, members.kept, deadline)
  const counts = `${members.joined.length} groups joined, ${templates.rewritten + inputs.rewritten} inputs, ${inputs.voided} voided, ${shares.moved} shares, ${templates.skipped + inputs.skipped} left as they are`
  if (members.done && templates.done && inputs.done && shares.done && Date.now() < deadline) {
    const identities = await moveIdentities(db, fromId, intoId, deadline)
    console.log(`merge ${fromId} into ${intoId}: ${counts}, ${identities} identities`)
    // Cut off partway, some identities are still P's, and the next claim moves the rest.
    return { joined: members.joined, finished: !(await hasIdentity(db, fromId)) }
  }
  const putOff = new Set([...templates.putOff, ...inputs.putOff, ...shares.putOff])
  console.log(
    `merge ${fromId} into ${intoId} carries on next claim: ${counts}, ${putOff.size} groups put off`,
  )
  return { joined: members.joined, finished: false }
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
 * Every group U has a member row in (`idx_person_status`), archived ones too, but U's personal
 * group: a placeholder is never in one (`add-member` refuses), so nothing there names P.
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
