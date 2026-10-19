import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { type PeriodCycle, periodFor } from '@ledgerly/core/dates/periods'
import { closeAtFor, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Shares } from '@ledgerly/core/generated/rows'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import type { Tx, Write } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
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
      ...(changes ? { changesJson: JSON.stringify(changes) } : {}),
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
