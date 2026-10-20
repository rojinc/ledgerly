import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { type StatementSnapshot, statementSnapshotSchema } from '@ledgerly/core/schemas/statements'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { periodLabel } from '@ledgerly/server/email/templates'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { AppwriteException, ID, type Models, Permission, Query, Role } from 'node-appwrite'

// Small helpers shared by the statements routes. groups and identity have copies of the first
// few; they can move to packages/server together.

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

/** Every row matching `queries`, read in pages of 100 by cursor (scaling.md). */
export async function listAll<R extends Models.Row>(
  db: Db,
  tableId: TableId,
  queries: string[],
): Promise<R[]> {
  const rows: R[] = []
  let cursor: string | undefined
  for (;;) {
    const { rows: page } = await db.listRows<R>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        ...queries,
        Query.orderAsc('$id'),
        Query.limit(PAGE_SIZE),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    })
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    cursor = page.at(-1)?.$id
  }
}

/** Appwrite takes at most 100 values in one `Query.equal`. */
export function chunks<T>(values: readonly T[], size = PAGE_SIZE): T[][] {
  const out: T[][] = []
  for (let start = 0; start < values.length; start += size) {
    out.push(values.slice(start, start + size))
  }
  return out
}

const PAGE_SIZE = 100

/** A missing statement's NOT_FOUND message, which outsiders get too (`requireMemberOf`). */
export const NO_SUCH_STATEMENT = 'There is no such statement.'

/** The statement, or NOT_FOUND. */
export async function getStatement(db: Db, statementId: string): Promise<Statements> {
  const statement = await getRowOrNull<Statements>(db, TABLES.statements, statementId)
  if (!statement) throw new AppError('NOT_FOUND', NO_SUCH_STATEMENT)
  return statement
}

export function teamRead(groupId: string): string[] {
  return [Permission.read(Role.team(groupId))]
}

/**
 * An `activity` row (data-model.md#activity). Scheduled jobs have no actor
 * (permissions.md#function-side-checks).
 */
export function activityWrite(
  groupId: string,
  actorPersonId: string | null,
  action: string,
  summary: string,
  now: Date,
  changes?: { before: object; after: object },
): Write {
  return {
    action: 'create',
    tableId: TABLES.activity,
    rowId: ID.unique(),
    data: {
      groupId,
      actorPersonId,
      action,
      summary: summary.slice(0, 255),
      ...(changes ? { changesJson: JSON.stringify(changes) } : {}),
      at: now.toISOString(),
    },
    permissions: teamRead(groupId),
  }
}

/**
 * How activity rows name a statement (statements.md#2-finalize): an invoice by its number, and
 * one with no number (a divide, or an invoice draft being discarded) by its period.
 */
export function statementName(
  statement: Pick<Statements, 'type' | 'displayNumber' | 'periodStart' | 'periodEnd'>,
): string {
  if (statement.displayNumber) return `Invoice ${statement.displayNumber}`
  const period = periodLabel(statement.periodStart as LocalDate, statement.periodEnd as LocalDate)
  return `${statement.type === 'divide' ? 'Divide' : 'Invoice draft'} for ${period}`
}

export function snapshotOf(statement: Statements): StatementSnapshot {
  return statementSnapshotSchema.parse(JSON.parse(statement.snapshotJson))
}

/**
 * Writes `data` to the statement (with any `also` writes), then checks the stored row still has
 * the status and the values of every column being written that were read before, so a
 * finalize, void, send or refresh that got in first is never overwritten. `check` runs after
 * that, inside the transaction, for anything else the write depends on. Returns the statement
 * as written.
 */
export async function updateStatement(
  db: Db,
  statement: Statements,
  data: Partial<Statements>,
  also: Write[] = [],
  check?: () => Promise<void>,
): Promise<Statements> {
  await withTransaction(db, async (tx) => {
    await tx.write(
      { action: 'update', tableId: TABLES.statements, rowId: statement.$id, data },
      ...also,
    )
    const stored = await getRowOrNull<Statements>(db, TABLES.statements, statement.$id)
    const columns = ['status', ...Object.keys(data)] as Array<keyof Statements>
    if (!stored || columns.some((column) => stored[column] !== statement[column])) {
      throw tryAgain()
    }
    await check?.()
  })
  return { ...statement, ...data }
}

/** The group's latest final statement by period end (void ones don't count), if any. */
export async function latestFinal(db: Db, groupId: string): Promise<Statements | undefined> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('status', 'final'),
      Query.orderDesc('periodEnd'),
      Query.limit(1),
    ],
    total: false,
  })
  return rows[0]
}

/** Whether a statement of the group is `finalizing` (`idx_group_period`). */
export async function isFinalizing(db: Db, groupId: string): Promise<boolean> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', groupId), Query.equal('status', 'finalizing'), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}

/**
 * A new `draft` statement of the group for `period`, with its snapshot: the job's, a reissue's
 * and a close's (statements.md#lifecycle).
 */
export function draftWrite(
  group: Groups,
  statementId: string,
  period: { start: string; end: string },
  snapshot: StatementSnapshot,
): Write {
  return {
    action: 'create',
    tableId: TABLES.statements,
    rowId: statementId,
    data: {
      groupId: group.$id,
      type: snapshot.group.type === 'employer' ? 'invoice' : 'divide',
      periodStart: period.start,
      periodEnd: period.end,
      status: 'draft',
      number: null,
      displayNumber: null,
      issuedOn: null,
      dueOn: null,
      snapshotJson: JSON.stringify(snapshot),
      pdfFileId: null,
      sentAt: null,
      finalizedBy: null,
    },
    permissions: teamRead(group.$id),
  }
}

/** The `statement.drafted` summary, for the job's drafts and a close's. */
export function draftSummary(periodEnd: string): string {
  return `Statement for the period ending ${periodEnd} drafted`
}

/**
 * A guard write to the group row: a fresh `rev`, so it is a real change that fails, or is
 * failed by, any other write to the group at the same moment (ledger.md#concurrency).
 */
export function groupGuard(group: Pick<Groups, '$id'>): Write {
  return { action: 'update', tableId: TABLES.groups, rowId: group.$id, data: { rev: randomId() } }
}
