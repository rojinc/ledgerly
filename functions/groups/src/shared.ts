import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { type PeriodCycle, periodFor } from '@ledgerly/core/dates/periods'
import { closeAtFor, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Persons, Shares } from '@ledgerly/core/generated/rows'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import type { MergingRefusal } from '@ledgerly/core/schemas/common'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import type { Tx, Write } from '@ledgerly/server/appwrite/transaction'
import { leftOnTheirOwn } from '@ledgerly/server/auth/left-on-their-own'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import {
  type PersonInput,
  type ResolvedPerson,
  resolvePerson,
} from '@ledgerly/server/identity/resolve-person'
import { AppwriteException, ID, type Models, Permission, Query, Role } from 'node-appwrite'

// Small helpers shared by the groups routes. identity has copies of the first few
// (functions/identity/src/rows.ts); they can move to packages/server once a third function needs them.

// The part of a zod schema this uses.
type Schema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } }
}

/** functions-api.md#validation: the body parsed with the route's schema, or VALIDATION_FAILED. */
export function parseBody<T>(schema: Schema<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'The request is not valid.', result.error.issues)
  }
  return result.data
}

/** VALIDATION_FAILED with one message, for rules the schema can't check. */
export function invalid(message: string): AppError {
  return new AppError('VALIDATION_FAILED', message)
}

/** A write clashed with another request's; the app can simply send it again. */
export function tryAgain(): AppError {
  return new AppError('CONFLICT', 'Something else changed this at the same time. Try again.')
}

/**
 * `resolvePerson` in `tx`, for an add (identity-and-invites.md#adding-someone-to-a-group): a
 * person it finds gets a guard write on `persons.rev`, then the keys are read again. A claim
 * that adopts or merges that person writes their row too, so one that commits after the guard
 * fails this commit, and one that committed before it and moved or removed the key is seen by
 * the second read: CONFLICT, and trying again finds who the key belongs to now. One-key
 * placeholders make this rarer, but it still covers placeholders made before them.
 * Throws resolvePerson's RangeError for an invalid email or phone.
 */
export async function resolveGuarded(
  tx: Tx,
  db: Db,
  input: PersonInput,
  region: string,
): Promise<ResolvedPerson> {
  const resolved = await resolvePerson(db, input, region, tx.id)
  // A new placeholder needs none: another add of the same key fails on identities.key.
  if (resolved.writes.length > 0) return resolved
  await tx.write({
    action: 'update',
    tableId: TABLES.persons,
    rowId: resolved.personId,
    data: { rev: randomId() },
  })
  const again = await resolvePerson(db, input, region, tx.id)
  if (again.personId !== resolved.personId) throw tryAgain()
  return resolved
}

export function isAppwriteError(error: unknown, code: number): boolean {
  return error instanceof AppwriteException && error.code === code
}

/** Runs `write`, turning a commit conflict (Appwrite's 409) into CONFLICT rather than INTERNAL. */
export async function conflictAsTryAgain<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isAppwriteError(error, 409)) throw tryAgain()
    throw error
  }
}

/** The row as stored, or null when there is none. */
export async function getRowOrNull<R extends Models.Row>(
  db: Db,
  tableId: TableId,
  rowId: string,
): Promise<R | null> {
  try {
    return await db.getRow<R>({ databaseId: DATABASE_ID, tableId, rowId })
  } catch (error) {
    if (isAppwriteError(error, 404)) return null
    throw error
  }
}

/** The first row matching `queries`, or undefined. */
export async function findFirst<R extends Models.Row>(
  db: Db,
  tableId: TableId,
  queries: string[],
): Promise<R | undefined> {
  const { rows } = await db.listRows<R>({
    databaseId: DATABASE_ID,
    tableId,
    queries: [...queries, Query.limit(1)],
    total: false,
  })
  return rows[0]
}

/** The group's member row with this ID, or NOT_FOUND (also for a member of another group). */
export async function getMemberOf(db: Db, groupId: string, memberId: string): Promise<Members> {
  const member = await getRowOrNull<Members>(db, TABLES.members, memberId)
  if (!member || member.groupId !== groupId) {
    throw new AppError('NOT_FOUND', "That member isn't in this group.")
  }
  return member
}

/**
 * The lead's rule on #21: `region` must be one date-holidays knows, or the scheduler would fail
 * for this group every hour. publicHolidayChecker throws a RangeError for an unknown one.
 */
export function checkRegion(region: string): void {
  try {
    publicHolidayChecker(region)
  } catch (error) {
    if (error instanceof RangeError) throw invalid('Unknown public holiday region')
    throw error
  }
}

/** Today in the group's time zone, the default for `joinedOn` and `leftOn`. */
export function today(group: Pick<Groups, 'timezone'>, now: Date): LocalDate {
  return localToday(group.timezone, now)
}

/**
 * groups.nextCloseAt (statements.md#periods): when the current period's statement is due. With
 * a weekly or fortnightly anchor in the future, the first period is the one that contains the
 * anchor, so nothing closes before the first real period. Monthly periods ignore the anchor.
 * Null when the group has no cycle.
 */
export function nextCloseAtFor(
  cycle: PeriodCycle | 'none',
  anchor: LocalDate | null,
  timeZone: string,
  now: Date,
): string | null {
  if (cycle === 'none') return null
  const todayHere = localToday(timeZone, now)
  const from = cycle !== 'monthly' && anchor !== null && anchor > todayHere ? anchor : todayHere
  return closeAtFor(periodFor(cycle, anchor, from).end, timeZone)
}

/** Read access for the group's team: every row of a group carries it (permissions.md). */
export function teamRead(groupId: string): string[] {
  return [Permission.read(Role.team(groupId))]
}

/**
 * An `activity` row (data-model.md#activity). Neither `summary` nor `changes` (`{ before, after }`)
 * ever holds a name: a `member.*` row names its person through `subjectPersonId`, and the app
 * shows their current name before the summary ("joined", "was removed").
 */
export function activityWrite(
  groupId: string,
  actorPersonId: string,
  action: string,
  summary: string,
  now: Date,
  {
    subjectPersonId,
    changes,
  }: { subjectPersonId?: string; changes?: { before: object; after: object } } = {},
): Write {
  return {
    action: 'create',
    tableId: TABLES.activity,
    rowId: ID.unique(),
    data: {
      groupId,
      actorPersonId,
      action,
      ...(subjectPersonId ? { subjectPersonId } : {}),
      summary: summary.slice(0, 255),
      // A change only to a name has nothing else to show, so no empty diff.
      ...(changes && (Object.keys(changes.before).length || Object.keys(changes.after).length)
        ? { changesJson: JSON.stringify(changes) }
        : {}),
      at: now.toISOString(),
    },
    permissions: teamRead(groupId),
  }
}

/** "an admin", "a member" or "a viewer", for a summary. */
export function aRole(role: Members['role']): string {
  return role === 'admin' ? 'an admin' : `a ${role}`
}

/**
 * The caller's balance in the group: Σ (given − received) over their shares (ledger.md#balances),
 * read in pages of 100 (scaling.md).
 */
export async function balanceOf(db: Db, groupId: string, personId: string): Promise<number> {
  let total = 0
  let cursor: string | undefined
  for (;;) {
    const { rows } = await db.listRows<Shares>({
      databaseId: DATABASE_ID,
      tableId: TABLES.shares,
      queries: [
        Query.equal('groupId', groupId),
        Query.equal('personId', personId),
        Query.orderAsc('$id'),
        Query.limit(100),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    })
    for (const share of rows) total += share.givenCents - share.receivedCents
    if (rows.length < 100) return total
    cursor = rows[rows.length - 1]?.$id
  }
}

/** Whether the person has any shares in the group (DELETE member needs none). */
export async function hasShares(db: Db, groupId: string, personId: string): Promise<boolean> {
  const share = await findFirst(db, TABLES.shares, [
    Query.equal('groupId', groupId),
    Query.equal('personId', personId),
  ])
  return share !== undefined
}

/**
 * Refuses, with CONFLICT and `merging`, while a merge into the person is open in the group
 * (identity-and-invites.md#while-a-merge-is-open-in-a-group): a P merged into them
 * (`idx_mergedInto`) lists the group in `mergeGroupIds`, has no member row here any more while
 * theirs is joined (step 2 gave P's place to them; a row they left on their own doesn't count, as
 * step 3 leaves P's rows on P there), and is still `named` here, which a leave or a
 * removal would count as someone else's. Per group, so a merge stuck elsewhere doesn't hold this one.
 *
 * Inside the transaction (`tx`), call it after staging the member row and before reading the
 * balance or shares: when such a P exists it stages a guard write on the group's row first, which
 * every merge batch also writes, so a batch that moves P's shares meanwhile fails one of the two
 * commits. Without `tx`, it's the early check only.
 */
export async function requireNoOpenMerge(
  db: Db,
  tx: Tx | undefined,
  groupId: string,
  personId: string,
  named: (placeholderId: string) => Promise<boolean>,
): Promise<void> {
  const merged = await allRows<Persons>(db, TABLES.persons, [Query.equal('mergedInto', personId)])
  const listing = merged.filter((placeholder) => placeholder.mergeGroupIds?.includes(groupId))
  if (listing.length === 0) return
  // Step 2 always leaves their row joined: a placeholder row of theirs isn't P's place (D-016).
  // Where they left on their own, step 3 leaves P's rows on P, so the group isn't open (#349).
  const own = await findFirst<Members>(db, TABLES.members, [
    Query.equal('groupId', groupId),
    Query.equal('personId', personId),
  ])
  if (!own || own.status === 'placeholder') return
  if (own.status === 'left' && (await leftOnTheirOwn(db, groupId, personId, own.$createdAt))) return
  await tx?.write({
    action: 'update',
    tableId: TABLES.groups,
    rowId: groupId,
    data: { rev: randomId() },
  })
  for (const placeholder of listing) {
    // P still has its place here: a kept group, or one step 2 hasn't reached.
    const row = await findFirst<Members>(db, TABLES.members, [
      Query.equal('groupId', groupId),
      Query.equal('personId', placeholder.$id),
    ])
    if (row) continue
    if (!(await named(placeholder.$id))) continue
    const details: MergingRefusal = { reason: 'merging' }
    throw new AppError(
      'CONFLICT',
      "Some of this group's records are still being updated. Try again shortly.",
      details,
    )
  }
}

/** Admins who have joined (status active): leaving or demoting must keep at least one. */
export async function joinedAdmins(db: Db, groupId: string): Promise<Members[]> {
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('role', 'admin'),
      Query.equal('status', 'active'),
      Query.limit(100),
    ],
    total: false,
  })
  return rows
}

/**
 * For a change that takes away a joined admin (leaving, demoting, moving out, removing): keeps
 * another one. Call it inside the transaction, after staging the change itself. It stages a
 * guard write (a fresh `rev`) on one other joined admin, then checks that row is still a joined
 * admin, so a concurrent change to it fails this commit, and this one fails a change staged
 * earlier (stage, then check: conventions.md). With no other joined admin, VALIDATION_FAILED with `message`.
 */
export async function keepAnotherAdmin(
  db: Db,
  tx: Tx,
  groupId: string,
  excludeMemberId: string,
  message: string,
): Promise<void> {
  const other = (await joinedAdmins(db, groupId)).find((admin) => admin.$id !== excludeMemberId)
  if (!other) throw invalid(message)
  await tx.write({
    action: 'update',
    tableId: TABLES.members,
    rowId: other.$id,
    data: { rev: randomId() },
  })
  const current = await getRowOrNull<Members>(db, TABLES.members, other.$id)
  if (current?.groupId !== groupId || current.role !== 'admin' || current.status !== 'active') {
    throw tryAgain()
  }
}
