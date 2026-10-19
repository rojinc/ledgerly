import { addDays } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type {
  Groups,
  Identities,
  Members,
  Persons,
  Shares,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { assertShareInvariants } from '@ledgerly/core/ledger/invariants'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { type BalancesPeople, balancesPeopleSchema } from '@ledgerly/core/schemas/ledger'
import { balancesFromShares } from '@ledgerly/core/settle/balances'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import { readBalances } from '@ledgerly/server/ledger/balances'
import { AppwriteException, Query } from 'node-appwrite'
import { allRows, pages } from '../pages'
import type { Services } from '../services'
import { describe } from './auto-post'

/**
 * What step 6 did: groups checked to the end, groups left for the next run because writes kept
 * landing while they were read, groups the budget cut off, groups skipped because their team is
 * gone, error lines logged, shares of merged persons, `balances` rows written (backfills
 * included), and groups that failed.
 */
export type CheckCounts = {
  checked: number
  busy: number
  cutOff: number
  skipped: number
  findings: number
  merging: number
  repaired: number
  failed: number
}

const READS = 3
const PAGE = 100
const CHECK_HOUR = 3
const PUT_OFF_MS = 60 * 60 * 1000

/**
 * Step 6 (scheduling.md#step-6-nightly-check): checks every group that is due, archived ones
 * too, until the run's budget is used: its `balances` row against a fresh sum, and its shares
 * against the invariants. It repairs only the row. Groups it doesn't reach stay due. Logs hold
 * IDs only.
 */
export async function nightlyCheck(services: Services): Promise<CheckCounts> {
  const counts = {
    checked: 0,
    busy: 0,
    cutOff: 0,
    skipped: 0,
    findings: 0,
    merging: 0,
    repaired: 0,
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
  // A purge in progress deletes the team first (identity-and-invites.md#deleting-an-account-m4),
  // then the group's rows: they're left alone, and the group stays due.
  if (!(await teamExists(services.teams, groupId))) {
    counts.skipped += 1
    return
  }
  const tomorrow = localTimeToUtc(
    addDays(localToday(group.timezone, services.now), 1),
    CHECK_HOUR,
    group.timezone,
  )
  // Writes landed meanwhile: a run soon tries again. If this write loses too, the group stays due.
  const busy = async () => {
    counts.busy += 1
    await setNextCheck(db, groupId, new Date(services.now.getTime() + PUT_OFF_MS).toISOString())
  }
  // Tomorrow's check starts it again, so it can't hold up the groups after it on every run.
  const cutOff = async () => {
    counts.cutOff += 1
    console.warn(`scheduler: nightly check of group ${groupId} cut off by the budget`)
    await setNextCheck(db, groupId, tomorrow)
  }
  const whole = await readWhole(db, groupId)
  if (!whole) return busy()
  if (services.outOfTime()) return cutOff()
  counts.merging += await checkShares(db, whole, report)

  const fresh = balancesFromShares(whole.shares)
  if (whole.balances === undefined || !same(whole.balances, fresh)) {
    if (whole.balances !== undefined) report('balances row wrong')
    if (!(await rebuildBalances(db, groupId))) return busy()
    counts.repaired += 1
  }

  if (!(await setNextCheck(db, groupId, tomorrow))) return busy()
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
  for (const transactionId of new Set(broken.map((share) => share.transactionId))) {
    report(`transaction ${transactionId} breaks I-3`)
  }
  return strangers.length - broken.length
}

function ruleOf(error: LedgerError): string {
  return /I-\d/.exec(error.message)?.[0] ?? 'an invariant'
}

/**
 * The persons among `personIds` whose merge into someone else isn't finished: `mergedInto` set,
 * and still an identity (a merge moves P's identities last, identity-and-invites.md). Or one that
 * never will be: merged into a person who deleted their account, since deletion deletes P's
 * identities and nobody carries the merge on (scheduling.md#step-6-nightly-check).
 */
async function mergedPersons(db: Db, personIds: readonly string[]): Promise<Set<string>> {
  const merging = new Set<string>()
  const unique = [...new Set(personIds)]
  for (let start = 0; start < unique.length; start += PAGE) {
    const merged = await allRows<Persons>(db, TABLES.persons, [
      Query.equal('$id', unique.slice(start, start + PAGE)),
      Query.isNotNull('mergedInto'),
    ])
    if (merged.length === 0) continue
    const identities = await allRows<Identities>(db, TABLES.identities, [
      Query.equal(
        'personId',
        merged.map((row) => row.$id),
      ),
    ])
    for (const identity of identities) merging.add(identity.personId)
    // Only a placeholder is merged, never a person with an account, so one step is the end.
    const deleted = await allRows<Persons>(db, TABLES.persons, [
      Query.equal('$id', [...new Set(merged.map((row) => row.mergedInto as string))]),
      Query.isNotNull('deletedAt'),
    ])
    const deletedIds = new Set(deleted.map((row) => row.$id))
    for (const row of merged) if (deletedIds.has(row.mergedInto as string)) merging.add(row.$id)
  }
  return merging
}

function same(a: BalancesPeople | null, b: BalancesPeople): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Writes the group's `balances` row from its shares, summed after the group's guard write is
 * staged, so a write of shares that lands meanwhile fails one of the two commits. False when this
 * one lost: the next run tries again. Throws, writing nothing, when the sum isn't a valid row.
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
      const people = balancesFromShares(shares)
      // A net past a safe integer, say: a bug, so the group fails until it's fixed by hand.
      if (!balancesPeopleSchema.safeParse(people).success) {
        throw new LedgerError('INVARIANT_VIOLATION', 'The shares make no valid balances row')
      }
      const peopleJson = JSON.stringify(people)
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

/** False when the group's team is gone. */
async function teamExists(
  teams: Pick<TeamsApi, 'listMemberships'>,
  teamId: string,
): Promise<boolean> {
  try {
    await teams.listMemberships({ teamId, queries: [Query.limit(1)] })
    return true
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return false
    throw error
  }
}

/** False when a write to the group row landed meanwhile: a later run checks it again. */
async function setNextCheck(db: Db, groupId: string, nextCheckAt: string): Promise<boolean> {
  try {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: groupId,
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
