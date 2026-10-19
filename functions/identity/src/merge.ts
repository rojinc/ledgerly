import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type {
  Balances,
  Groups,
  Identities,
  Members,
  Persons,
  Shares,
  Statements,
} from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { type Tx, type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { leftOnTheirOwn } from '@ledgerly/server/auth/left-on-their-own'
import { randomId } from '@ledgerly/server/identity/random-id'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { ID, Permission, Query, Role } from 'node-appwrite'
import { getRowOrNull, isAppwriteError, tryAgain } from './rows'
import type { Services } from './services'

// identity-and-invites.md#merging-two-persons: placeholder P is merged into U in steps that are
// each safe to repeat. Logs hold IDs and counts only (security-and-privacy.md). Every loop stops
// once `deadline` (epoch ms) has passed, so a claim never runs into the function's timeout.

/** Thrown inside a transaction when P turned out not to be U's to merge. */
class NotOurs extends Error {}

/**
 * Step 1: marks P as merged into U. It stages `mergedInto`, then reads P's stored row, so of
 * two adoptions or merges at once only one wins. True when P is U's to merge: marked now, or
 * already by an earlier call that was cut off.
 */
export async function markMerged(db: Db, placeholderId: string, intoId: string): Promise<boolean> {
  const stored = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
  if (!stored || stored.userId || stored.deletedAt) return false
  if (stored.mergedInto) return stored.mergedInto === intoId
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: placeholderId,
        data: { mergedInto: intoId },
      })
      // Stage, then check: read the stored row, not this transaction's view of it. A claim for U
      // that marked it first leaves it U's all the same.
      const current = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
      if (
        !current ||
        current.userId ||
        current.deletedAt ||
        (current.mergedInto && current.mergedInto !== intoId)
      ) {
        throw new NotOurs()
      }
    })
    return true
  } catch (error) {
    if (error instanceof NotOurs) return false
    // P changed after it was staged: whoever changed it decides.
    if (isAppwriteError(error, 409)) {
      const current = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
      return current?.mergedInto === intoId && !current.userId
    }
    throw error
  }
}

/**
 * What step 2 did: the kept groups (U left them on their own), the groups U joined, where U had
 * no joined row before (`linkedGroupIds`), and whether every row of P's was seen to.
 */
export type MembersResult = { kept: Set<string>; joined: string[]; done: boolean }

/**
 * Step 2: P's member rows, one at a time (`idx_person_status`). U joins each of P's groups,
 * archived ones too, except where U left on their own, or where U is already in a pair or
 * employer group: there P keeps its row and its shares (the kept groups), since merging would
 * leave a pair of one, or an employer group paying itself. A row is finished once it no longer
 * points at P, so a retry carries on.
 */
export async function moveMembers(
  services: Services,
  userId: string,
  fromId: string,
  intoId: string,
  deadline: number,
): Promise<MembersResult> {
  const { db } = services
  const kept = new Set<string>()
  const joined: string[] = []
  for (;;) {
    if (Date.now() >= deadline) return { kept, joined, done: false }
    const { rows } = await db.listRows<Members>({
      databaseId: DATABASE_ID,
      tableId: TABLES.members,
      queries: [
        Query.equal('personId', fromId),
        ...[...kept].map((groupId) => Query.notEqual('groupId', groupId)),
        Query.limit(1),
      ],
      total: false,
    })
    const theirs = rows[0]
    if (!theirs) return { kept, joined, done: true }
    const own = await memberOf(db, theirs.groupId, intoId)
    if (
      own &&
      ((await twoSided(db, own.groupId)) ||
        (await leftOnTheirOwn(db, own.groupId, intoId, own.$createdAt)))
    ) {
      kept.add(theirs.groupId)
    } else if (
      (await moveMember(services, userId, theirs, own, intoId)) &&
      (!own || own.status === 'placeholder')
    ) {
      joined.push(theirs.groupId)
    }
  }
}

/** Whether the group is a pair or an employer group, where both sides must stay two people. */
async function twoSided(db: Db, groupId: string): Promise<boolean> {
  const group = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
  return group?.type === 'pair' || group?.type === 'employer'
}

/** The person's member row in the group (`uniq_group_person`), or undefined. */
async function memberOf(db: Db, groupId: string, personId: string): Promise<Members | undefined> {
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', groupId), Query.equal('personId', personId), Query.limit(1)],
    total: false,
  })
  return rows[0]
}

/**
 * One of P's rows: U joins the team first ("already a member" counts as done), then in one
 * transaction U's own row is kept (with the earlier `joinedOn`) and P's deleted, or P's row is
 * repointed to U, with the status as in joining and `member.joined` by U. Each write carries a
 * fresh `rev`, so it's a real change that guards the row (ledger.md#concurrency) even when
 * nothing else on it changes. True if this call moved it; false if a merge running at the same
 * time did.
 */
async function moveMember(
  { db, teams, now }: Services,
  userId: string,
  theirs: Members,
  own: Members | undefined,
  intoId: string,
): Promise<boolean> {
  await addToTeam(teams, theirs.groupId, userId)
  const kept = own
    ? { ...own, joinedOn: theirs.joinedOn < own.joinedOn ? theirs.joinedOn : own.joinedOn }
    : { ...theirs, personId: intoId }
  try {
    await withTransaction(db, async (tx) => {
      await tx.write(
        ...(own
          ? [
              {
                action: 'update' as const,
                tableId: TABLES.members,
                rowId: own.$id,
                data: { joinedOn: kept.joinedOn, status: statusOf(kept), rev: randomId() },
              },
              { action: 'delete' as const, tableId: TABLES.members, rowId: theirs.$id },
            ]
          : [
              {
                action: 'update' as const,
                tableId: TABLES.members,
                rowId: theirs.$id,
                data: { personId: intoId, status: statusOf(kept), rev: randomId() },
              },
            ]),
      )
      // Stage, then check: both rows as stored, not this transaction's view of them.
      const storedTheirs = await getRowOrNull<Members>(db, TABLES.members, theirs.$id)
      const storedOwn = own ? await getRowOrNull<Members>(db, TABLES.members, own.$id) : null
      if (!sameMember(storedTheirs, theirs) || (own && !sameMember(storedOwn, own))) {
        throw new Raced()
      }
      await tx.write({
        action: 'create',
        tableId: TABLES.activity,
        rowId: ID.unique(),
        data: {
          groupId: kept.groupId,
          actorPersonId: intoId,
          action: 'member.joined',
          summary: `${kept.displayName} joined`,
          at: now.toISOString(),
        },
        permissions: [Permission.read(Role.team(kept.groupId))],
      })
    })
  } catch (error) {
    // Take back the team membership, unless U has a joined row there that they didn't leave on
    // their own (a leave of U's that landed meanwhile is final).
    if (!(await joinedHere(db, theirs.groupId, intoId))) {
      await removeFromTeam(teams, theirs.groupId, userId)
    }
    const current = await getRowOrNull<Members>(db, TABLES.members, theirs.$id)
    if (current?.personId === theirs.personId) {
      throw error instanceof Raced || isAppwriteError(error, 409) ? tryAgain() : error
    }
    // P's row is gone or U's now: a merge running at the same time moved it.
    return false
  }
  // As in joinGroup: a parallel failure may have taken back the membership just before this
  // commit, and the row is joined now. Read it again after: a leave of U's own that landed since
  // takes the membership away for good.
  await addToTeam(teams, theirs.groupId, userId)
  if (!(await joinedHere(db, theirs.groupId, intoId))) {
    await removeFromTeam(teams, theirs.groupId, userId)
  }
  return true
}

/** Whether the person has a joined row in the group (`active` or `left`) they didn't leave on their own. */
async function joinedHere(db: Db, groupId: string, personId: string): Promise<boolean> {
  const row = await memberOf(db, groupId, personId)
  if (!row || row.status === 'placeholder') return false
  return !(await leftOnTheirOwn(db, groupId, personId, row.$createdAt))
}

// `left` if they moved out, so a former housemate can still see and settle up (as in joining).
function statusOf(member: Members): 'active' | 'left' {
  return member.leftOn ? 'left' : 'active'
}

/**
 * True when the stored row still says what was read: same person, status, role, dates and `rev`.
 * The `rev` catches a leave of U's own after U had moved out, which changes nothing else on the
 * row but makes leaving final.
 */
function sameMember(stored: Members | null, read: Members): boolean {
  return (
    stored?.rev === read.rev &&
    stored?.personId === read.personId &&
    stored.status === read.status &&
    stored.role === read.role &&
    stored.joinedOn === read.joinedOn &&
    stored.leftOn === read.leftOn
  )
}

/**
 * Step 3, identities: repoints P's identities to U, a batch at a time (`idx_personId`). Each
 * batch is staged, then read again, so one that changed meanwhile (another merge, say) is never
 * overwritten: the batch runs again from a fresh list. Returns how many moved.
 */
export async function moveIdentities(
  db: Db,
  fromId: string,
  intoId: string,
  deadline: number,
): Promise<number> {
  let moved = 0
  for (;;) {
    if (Date.now() >= deadline) return moved
    const { rows } = await db.listRows<Identities>({
      databaseId: DATABASE_ID,
      tableId: TABLES.identities,
      queries: [Query.equal('personId', fromId), Query.limit(MAX_OPS_PER_DB_TRANSACTION)],
      total: false,
    })
    if (rows.length === 0) return moved
    const ids = rows.map((row) => row.$id)
    try {
      await withTransaction(db, async (tx) => {
        await tx.write(
          ...ids.map((rowId) => ({
            action: 'update' as const,
            tableId: TABLES.identities,
            rowId,
            data: { personId: intoId },
          })),
        )
        const { rows: current } = await db.listRows<Identities>({
          databaseId: DATABASE_ID,
          tableId: TABLES.identities,
          queries: [Query.equal('$id', ids), Query.limit(ids.length)],
          total: false,
        })
        if (current.length !== ids.length || current.some((row) => row.personId !== fromId)) {
          throw new Raced()
        }
      })
      moved += ids.length
    } catch (error) {
      // A row changed before or after it was staged: list again.
      if (!(error instanceof Raced || isAppwriteError(error, 409))) throw error
    }
  }
}

/**
 * Shares moved per transaction: each may take two writes (combine), plus the group's guard and
 * the delete of its `balances` row.
 */
const SHARES_PER_BATCH = Math.floor((MAX_OPS_PER_DB_TRANSACTION - 2) / 2)

/** What became of the groups whose shares a call looked at. `done`: P has none left there. */
export type SharesResult = { moved: number; putOff: string[]; done: boolean }

/**
 * Step 3, shares: repoints P's shares to U, a group at a time, skipping `kept` groups (U left
 * them on their own, so P keeps its shares there). Where U already has a share in the same
 * transaction, the two become U's one share (I-5), locked ones included (I-7's merge exception):
 * no total changes, so every group still sums to 0 after each batch (I-1).
 *
 * Each batch stages a fresh `rev` on the group row first, so a ledger write or a `/balances`
 * read that overlaps it runs again (ledger.md#concurrency), then checks that no statement of the
 * group is `finalizing`. If one is, the group is put off until the next `/claim`. It stops
 * starting batches once `deadline` (epoch ms) has passed.
 */
export async function moveShares(
  db: Db,
  fromId: string,
  intoId: string,
  kept: ReadonlySet<string>,
  deadline: number,
): Promise<SharesResult> {
  const skip = new Set(kept)
  const putOff: string[] = []
  let moved = 0
  for (;;) {
    if (Date.now() >= deadline) return { moved, putOff, done: false }
    const { rows } = await db.listRows<Shares>({
      databaseId: DATABASE_ID,
      tableId: TABLES.shares,
      queries: [
        Query.equal('personId', fromId),
        ...[...skip].map((groupId) => Query.notEqual('groupId', groupId)),
        Query.limit(1),
      ],
      total: false,
    })
    const groupId = rows[0]?.groupId
    if (groupId === undefined) return { moved, putOff, done: putOff.length === 0 }
    const batch = await moveShareBatch(db, fromId, intoId, groupId, deadline)
    if (batch === 'cutOff') return { moved, putOff, done: false }
    if (batch === 'putOff') {
      skip.add(groupId)
      putOff.push(groupId)
    } else {
      moved += batch
    }
  }
}

/** Thrown inside a batch when the group has a statement being finalized. */
export class Finalizing extends Error {}

/**
 * One batch of P's shares in one group: the number moved, `putOff` while it's finalizing, or
 * `cutOff` past the deadline. The group's guard is staged before the shares are read, so a share
 * written meanwhile (another merge into U, a ledger edit) is either read here or fails this
 * batch's commit: two merges can't each give U a share in one transaction (I-5).
 */
async function moveShareBatch(
  db: Db,
  fromId: string,
  intoId: string,
  groupId: string,
  deadline: number,
): Promise<number | 'putOff' | 'cutOff'> {
  for (;;) {
    if (Date.now() >= deadline) return 'cutOff'
    try {
      return await withTransaction(db, async (tx) => {
        // The guard first (ledger.md#concurrency), then the finalizing check, then the reads.
        await tx.write({
          action: 'update',
          tableId: TABLES.groups,
          rowId: groupId,
          data: { rev: randomId() },
        })
        if (await isFinalizing(db, groupId)) throw new Finalizing()
        const { rows: theirs } = await db.listRows<Shares>({
          databaseId: DATABASE_ID,
          tableId: TABLES.shares,
          queries: [
            Query.equal('groupId', groupId),
            Query.equal('personId', fromId),
            Query.limit(SHARES_PER_BATCH),
          ],
          total: false,
        })
        // Another merge of P moved them meanwhile.
        if (theirs.length === 0) return 0
        await dropBalances(tx, db, groupId)
        const transactionIds = theirs.map((share) => share.transactionId)
        const { rows: ours } = await db.listRows<Shares>({
          databaseId: DATABASE_ID,
          tableId: TABLES.shares,
          queries: [
            Query.equal('transactionId', transactionIds),
            Query.equal('personId', intoId),
            Query.limit(transactionIds.length),
          ],
          total: false,
        })
        await tx.write(...combined(theirs, ours, intoId))
        // Stage, then check: both sides as stored, for a writer that doesn't write the guard.
        if (!(await unchanged(db, [...theirs, ...ours]))) throw new Raced()
        return theirs.length
      })
    } catch (error) {
      if (error instanceof Finalizing) return 'putOff'
      if (!(error instanceof Raced || isAppwriteError(error, 409))) throw error
    }
  }
}

/** P's shares repointed to U, or added to U's own share in the same transaction (I-5). */
function combined(theirs: readonly Shares[], ours: readonly Shares[], intoId: string): Write[] {
  const oursByTransaction = new Map(ours.map((share) => [share.transactionId, share]))
  return theirs.flatMap((share): Write[] => {
    const own = oursByTransaction.get(share.transactionId)
    if (!own) {
      return [
        { action: 'update', tableId: TABLES.shares, rowId: share.$id, data: { personId: intoId } },
      ]
    }
    const givenCents = own.givenCents + share.givenCents
    const receivedCents = own.receivedCents + share.receivedCents
    // An adjustment's two shares can cancel out: like buildShares, keep no share at 0/0.
    if (givenCents === 0 && receivedCents === 0) {
      return [
        { action: 'delete', tableId: TABLES.shares, rowId: own.$id },
        { action: 'delete', tableId: TABLES.shares, rowId: share.$id },
      ]
    }
    return [
      {
        action: 'update',
        tableId: TABLES.shares,
        rowId: own.$id,
        data: { givenCents, receivedCents },
      },
      { action: 'delete', tableId: TABLES.shares, rowId: share.$id },
    ]
  })
}

/**
 * Stages the delete of the group's `balances` row, if it has one (ledger.md#balances): a merge
 * renames a person, which that cache can't follow share by share, so `/balances` sums the shares
 * until the nightly check builds it again. Read after the group's guard, so a row rebuilt
 * meanwhile fails this commit, and one deleted meanwhile fails the delete (409): the batch runs
 * again either way.
 */
export async function dropBalances(tx: Tx, db: Db, groupId: string): Promise<void> {
  if (await getRowOrNull<Balances>(db, TABLES.balances, groupId)) {
    await tx.write({ action: 'delete', tableId: TABLES.balances, rowId: groupId })
  }
}

/** Whether a statement of the group is `finalizing` (statements.md#2-finalize). */
export async function isFinalizing(db: Db, groupId: string): Promise<boolean> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', groupId), Query.equal('status', 'finalizing'), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}

/** True when every share is still stored as it was read: same person and amounts. */
async function unchanged(db: Db, shares: readonly Shares[]): Promise<boolean> {
  const { rows } = await db.listRows<Shares>({
    databaseId: DATABASE_ID,
    tableId: TABLES.shares,
    queries: [
      Query.equal(
        '$id',
        shares.map((share) => share.$id),
      ),
      Query.limit(shares.length),
    ],
    total: false,
  })
  const stored = new Map(rows.map((row) => [row.$id, row]))
  return shares.every((share) => {
    const now = stored.get(share.$id)
    return (
      now?.personId === share.personId &&
      now.givenCents === share.givenCents &&
      now.receivedCents === share.receivedCents
    )
  })
}
