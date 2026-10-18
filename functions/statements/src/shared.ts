import type { Statements } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import type { Write } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
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

/** The statement, or NOT_FOUND. */
export async function getStatement(db: Db, statementId: string): Promise<Statements> {
  const statement = await getRowOrNull<Statements>(db, TABLES.statements, statementId)
  if (!statement) throw new AppError('NOT_FOUND', 'There is no such statement.')
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
