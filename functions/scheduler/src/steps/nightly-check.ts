import { addDays } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Persons, Shares, Transactions } from '@ledgerly/core/generated/rows'
import { assertShareInvariants } from '@ledgerly/core/ledger/invariants'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import type { BalancesPeople } from '@ledgerly/core/schemas/ledger'
import { balancesFromShares } from '@ledgerly/core/settle/balances'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { leftOnTheirOwn } from '@ledgerly/server/auth/left-on-their-own'
import { randomId } from '@ledgerly/server/identity/random-id'
import { readBalances } from '@ledgerly/server/ledger/balances'
import { AppwriteException, type Models, Query } from 'node-appwrite'
import { allRows, pages } from '../pages'
import type { Services } from '../services'
import { describe } from './auto-post'

/**
 * What step 5 did: groups checked to the end, groups left for the next run because writes kept
 * landing while they were read, error lines logged, shares of merged persons, `balances` rows
 * written (backfills included), team memberships removed, and groups that failed.
 */
export type CheckCounts = {
  checked: number
  busy: number
  findings: number
  merging: number
  repaired: number
  removed: number
  failed: number
}

const READS = 3
const PAGE = 100
// Joining and merging add the team membership before the member row.
const MEMBERSHIP_GRACE_MS = 60 * 60 * 1000
const CHECK_HOUR = 3

/**
 * Step 5 (scheduling.md#step-5-nightly-check): checks every group that is due, archived ones
 * too: its `balances` row against a fresh sum, its shares against the invariants, and its team
 * against its member rows. It repairs only the row and stale memberships. Logs hold IDs only.
 */
export async function nightlyCheck(services: Services): Promise<CheckCounts> {
  const counts = {
    checked: 0,
    busy: 0,
    findings: 0,
    merging: 0,
    repaired: 0,
    removed: 0,
    failed: 0,
  }
  // idx_nextCheckAt: never checked (the backfill), then due.
  const due = [
    Query.isNull('nextCheckAt'),
    Query.lessThanEqual('nextCheckAt', services.now.toISOString()),
  ]
  for (const query of due) {
    for await (const group of pages<Groups>(services, TABLES.groups, [query])) {
      try {
        await checkGroup(services, group, counts)
      } catch (error) {
        counts.failed += 1
        console.error(`scheduler: nightly check failed for group ${group.$id}: ${describe(error)}`)
      }
    }
  }
  return counts
}

async function checkGroup(services: Services, group: Groups, counts: CheckCounts): Promise<void> {
  const { db } = services
  const groupId = group.$id
  const report = (finding: string) => {
    counts.findings += 1
    console.error(`scheduler: nightly check of group ${groupId}: ${finding}`)
  }
  const whole = await readWhole(db, groupId)
  if (!whole) {
    counts.busy += 1
    return
  }
  counts.merging += await checkShares(db, whole, report)

  const fresh = balancesFromShares(whole.shares)
  if (whole.balances === undefined || !same(whole.balances, fresh)) {
    if (whole.balances !== undefined) report('balances row wrong')
    if (!(await rebuildBalances(db, groupId))) {
      counts.busy += 1
      return
    }
    counts.repaired += 1
  }
  counts.removed += await reconcileTeam(services, groupId, whole.members, report)

  // Cut off by the budget: the next run checks it from the start.
  if (services.outOfTime()) return
  if (!(await setNextCheck(db, group, services.now))) {
    counts.busy += 1
    return
  }
  counts.checked += 1
}

type Whole = {
  members: Members[]
  posted: Transactions[]
  shares: Shares[]
  balances: BalancesPeople | null | undefined
}

/**
 * The group's members, posted transactions (idx_group_status_date), shares and `balances` row,
 * read whole: every write of shares changes the group's `rev`, so the same `rev` before and after
 * means none landed in between. Undefined when one landed during each of 3 reads.
 */
async function readWhole(db: Db, groupId: string): Promise<Whole | undefined> {
  for (let read = 0; read < READS; read++) {
    const before = await revOf(db, groupId)
    const [members, posted, shares, balances] = await Promise.all([
      allRows<Members>(db, TABLES.members, [Query.equal('groupId', groupId)]),
      allRows<Transactions>(db, TABLES.transactions, [
        Query.equal('groupId', groupId),
        Query.equal('status', 'posted'),
      ]),
      allRows<Shares>(db, TABLES.shares, [Query.equal('groupId', groupId)]),
      readBalances(db, groupId),
    ])
    if ((await revOf(db, groupId)) === before) return { members, posted, shares, balances }
  }
  return undefined
}

async function revOf(db: Db, groupId: string): Promise<string | null> {
  const group = await db.getRow<Groups>({
    databaseId: DATABASE_ID,
    tableId: TABLES.groups,
    rowId: groupId,
  })
  return group.rev
}

/**
 * Reports every posted transaction that breaks I-1, I-2, I-4 or I-5, every share of a
 * transaction that isn't a posted one of this group (I-6), and every share whose person has no
 * member row here (I-3). Returns how many shares belong to persons being merged, which aren't
 * broken: a merge cut off partway leaves shares on P.
 */
async function checkShares(
  db: Db,
  { members, posted, shares }: Whole,
  report: (finding: string) => void,
): Promise<number> {
  const byTransaction = new Map<string, Shares[]>()
  for (const share of shares) {
    byTransaction.set(share.transactionId, [
      ...(byTransaction.get(share.transactionId) ?? []),
      share,
    ])
  }
  for (const transaction of posted) {
    const own = byTransaction.get(transaction.$id) ?? []
    try {
      // I-3 is checked below, where merged persons are told apart.
      assertShareInvariants(
        transaction,
        own,
        own.map((share) => share.personId),
      )
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error
      report(`transaction ${transaction.$id} breaks ${ruleOf(error)}`)
    }
  }
  const postedIds = new Set(posted.map((transaction) => transaction.$id))
  for (const transactionId of byTransaction.keys()) {
    if (!postedIds.has(transactionId)) report(`transaction ${transactionId} breaks I-6`)
  }
  const memberIds = new Set(members.map((member) => member.personId))
  const strangers = shares.filter((share) => !memberIds.has(share.personId))
  const merged = await mergedPersons(
    db,
    strangers.map((share) => share.personId),
  )
  const broken = strangers.filter((share) => !merged.has(share.personId))
  for (const share of broken) report(`transaction ${share.transactionId} breaks I-3`)
  return strangers.length - broken.length
}

function ruleOf(error: LedgerError): string {
  return /I-\d/.exec(error.message)?.[0] ?? 'an invariant'
}

/** The persons among `personIds` that were merged into someone else. */
async function mergedPersons(db: Db, personIds: readonly string[]): Promise<Set<string>> {
  const merged = new Set<string>()
  const unique = [...new Set(personIds)]
  for (let start = 0; start < unique.length; start += PAGE) {
    const rows = await allRows<Persons>(db, TABLES.persons, [
      Query.equal('$id', unique.slice(start, start + PAGE)),
      Query.isNotNull('mergedInto'),
    ])
    for (const row of rows) merged.add(row.$id)
  }
  return merged
}

function same(a: BalancesPeople | null, b: BalancesPeople): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Writes the group's `balances` row from its shares, summed after the group's guard write is
 * staged, so a write of shares that lands meanwhile fails one of the two commits. False when this
 * one lost: the next run tries again.
 */
async function rebuildBalances(db: Db, groupId: string): Promise<boolean> {
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: groupId,
        data: { rev: randomId() },
      })
      const shares = await allRows<Shares>(db, TABLES.shares, [Query.equal('groupId', groupId)])
      const peopleJson = JSON.stringify(balancesFromShares(shares))
      await tx.write({
        action: 'upsert',
        tableId: TABLES.balances,
        rowId: groupId,
        data: { peopleJson },
      })
    })
    return true
  } catch (error) {
    if (conflict(error)) return false
    throw error
  }
}

/**
 * Removes each team membership over an hour old that no joined member row backs: no `active` or
 * `left` row for the user's person, or only one they left on their own. It reads the rows again
 * just before removing. Returns how many it removed; one already gone counts as removed.
 */
async function reconcileTeam(
  { db, teams, now }: Services,
  groupId: string,
  members: readonly Members[],
  report: (finding: string) => void,
): Promise<number> {
  const old = (await membershipsOf(teams, groupId)).filter(
    (membership) => now.getTime() - Date.parse(membership.$createdAt) > MEMBERSHIP_GRACE_MS,
  )
  if (old.length === 0) return 0
  const personOf = await personsOf(
    db,
    old.map((membership) => membership.userId),
  )
  let removed = 0
  for (const membership of old) {
    const personId = personOf.get(membership.userId)
    if (await backed(db, groupId, personId, members)) continue
    // Again, just before removing: a join that has landed since keeps it.
    const again = (await personsOf(db, [membership.userId])).get(membership.userId)
    if (await backed(db, groupId, again, await memberRows(db, groupId, again))) continue
    try {
      await teams.deleteMembership({ teamId: groupId, membershipId: membership.$id })
    } catch (error) {
      if (!(error instanceof AppwriteException && error.code === 404)) throw error
    }
    removed += 1
    report(`removed team membership ${membership.$id}`)
  }
  return removed
}

type Membership = Pick<Models.Membership, '$id' | 'userId' | '$createdAt'>

/** Every membership of the group's team; none when the team is gone. */
async function membershipsOf(
  teams: Pick<TeamsApi, 'listMemberships'>,
  teamId: string,
): Promise<Membership[]> {
  const found: Membership[] = []
  try {
    for (;;) {
      const { memberships } = await teams.listMemberships({
        teamId,
        queries: [Query.limit(PAGE), Query.offset(found.length)],
      })
      found.push(...memberships)
      if (memberships.length < PAGE) return found
    }
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return []
    throw error
  }
}

/** Each user's person, by user ID (idx_userId). */
async function personsOf(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const personOf = new Map<string, string>()
  for (let start = 0; start < userIds.length; start += PAGE) {
    const rows = await allRows<Persons>(db, TABLES.persons, [
      Query.equal('userId', userIds.slice(start, start + PAGE)),
    ])
    for (const row of rows) if (row.userId) personOf.set(row.userId, row.$id)
  }
  return personOf
}

async function memberRows(
  db: Db,
  groupId: string,
  personId: string | undefined,
): Promise<Members[]> {
  if (personId === undefined) return []
  return allRows<Members>(db, TABLES.members, [
    Query.equal('groupId', groupId),
    Query.equal('personId', personId),
  ])
}

/** Whether the person has a joined row in the group that they didn't leave on their own. */
async function backed(
  db: Db,
  groupId: string,
  personId: string | undefined,
  members: readonly Members[],
): Promise<boolean> {
  for (const row of members.filter((member) => member.personId === personId)) {
    if (row.status === 'active') return true
    if (
      row.status === 'left' &&
      !(await leftOnTheirOwn(db, groupId, row.personId, row.$createdAt))
    ) {
      return true
    }
  }
  return false
}

/**
 * `nextCheckAt` = 03:00 tomorrow in the group's time zone. False when a write to the group row
 * landed meanwhile: the next run checks it again.
 */
async function setNextCheck(db: Db, group: Groups, now: Date): Promise<boolean> {
  const tomorrow = addDays(localToday(group.timezone, now), 1)
  const nextCheckAt = localTimeToUtc(tomorrow, CHECK_HOUR, group.timezone)
  try {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: group.$id,
        data: { nextCheckAt },
      }),
    )
    return true
  } catch (error) {
    if (conflict(error)) return false
    throw error
  }
}

function conflict(error: unknown): boolean {
  return error instanceof AppwriteException && error.code === 409
}
