import type { Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { AppwriteException, type Models, Query } from 'node-appwrite'

// Small helpers like those of identity (functions/identity/src/rows.ts) and groups.

export function isAppwriteError(error: unknown, code: number): boolean {
  return error instanceof AppwriteException && error.code === code
}

/** Runs `request`; a 404 (the user, team or row is already gone) counts as done. */
export async function doneIfGone(request: () => Promise<unknown>): Promise<void> {
  try {
    await request()
  } catch (error) {
    if (!isAppwriteError(error, 404)) throw error
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

/** Every person naming the user (`idx_userId`): one, unless a bootstrap raced a deletion. */
export function personsOfUser(db: Db, userId: string): Promise<Persons[]> {
  return allRows<Persons>(db, TABLES.persons, [Query.equal('userId', userId)])
}
