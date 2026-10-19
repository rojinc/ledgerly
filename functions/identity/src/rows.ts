import type { Identities, Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import type { Tx } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { AppwriteException, type Models, Query } from 'node-appwrite'

export const SET_UP_FIRST = 'Set up your account first.'

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

/** The user's own person (`persons.userId`), or undefined before bootstrap made one. */
export async function findPersonOfUser(db: Db, userId: string): Promise<Persons | undefined> {
  return findFirst<Persons>(db, TABLES.persons, [Query.equal('userId', userId)])
}

export async function findIdentity(db: Db, key: string): Promise<Identities | undefined> {
  return findFirst<Identities>(db, TABLES.identities, [Query.equal('key', key)])
}

/**
 * Stages a guard write on the person (a fresh `rev`, ledger.md#concurrency), then reads it as
 * stored, not in this transaction's view: `refusal` if their account's deletion has passed its
 * point of no return since they were looked up. One that passes it later fails the commit, so
 * nothing is written for a deleted person (identity-and-invites.md#order).
 */
export async function guardPerson(
  tx: Tx,
  db: Db,
  personId: string,
  refusal: () => AppError,
): Promise<void> {
  await tx.write({
    action: 'update',
    tableId: TABLES.persons,
    rowId: personId,
    data: { rev: randomId() },
  })
  const stored = await getRowOrNull<Persons>(db, TABLES.persons, personId)
  if (!stored || stored.deletedAt) throw refusal()
}

/** No account, not being merged, not a deleted account: a person a new user may adopt. */
export function isPlaceholder(person: Persons): boolean {
  return !person.userId && !person.mergedInto && !person.deletedAt
}

async function findFirst<R extends Models.Row>(
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
