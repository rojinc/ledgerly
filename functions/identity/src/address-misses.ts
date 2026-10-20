import { ADDRESS_MISS_LIMIT } from '@ledgerly/core/constants/limits'
import type { Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { conflictAsTryAgain, getRowOrNull, isAppwriteError } from './rows'

const WINDOW_MS = ADDRESS_MISS_LIMIT.hours * 60 * 60 * 1000

type Counted = Pick<Persons, 'addressMisses' | 'addressMissesFrom'>

/** One sender's misses, and the route's answers that count them (#274). */
export type Misses = {
  db: Db
  senderId: string
  now: Date
  /** The route's wrong-address message: every answer with it is a miss, whatever the reason. */
  wrongAddress: string
  /** The route's own RATE_LIMITED answer. */
  tooMany: () => AppError
}

/**
 * Whether the sender's row holds `ADDRESS_MISS_LIMIT.count` misses or more in a live window
 * (identity-and-invites.md#invites, step 2). A count of `null`, on a row made before the column,
 * is 0.
 */
export function atMissLimit(person: Counted | null, now: Date): boolean {
  return isLive(person, now) && (person?.addressMisses ?? 0) >= ADDRESS_MISS_LIMIT.count
}

/** A window is live from `addressMissesFrom` until `ADDRESS_MISS_LIMIT.hours` later. */
function isLive(person: Counted | null, now: Date): boolean {
  const from = person?.addressMissesFrom
  if (!from) return false
  return now.getTime() < Date.parse(from) + WINDOW_MS
}

/**
 * Runs `work`. If it answers with the route's wrong-address message, records a miss first
 * (`recordMiss`), then gives that answer, or the one recording gave instead.
 */
export async function countingMisses<T>(misses: Misses, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const wrong =
      error instanceof AppError &&
      error.code === 'VALIDATION_FAILED' &&
      error.message === misses.wrongAddress
    if (wrong) await recordMiss(misses)
    throw error
  }
}

/**
 * Records one miss on the sender's `persons` row, in its own transaction: a guard write (a fresh
 * `rev`), the row read again as committed, then `addressMisses + 1` in a live window, or a new
 * window at 1 from now. At the limit, `tooMany` instead, and nothing is written. A 409 runs it
 * once more, then CONFLICT. The row gets a count and a time only: no address, target or route.
 */
export async function recordMiss({ db, senderId, now, tooMany }: Misses): Promise<void> {
  const record = () =>
    withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: senderId,
        data: { rev: randomId() },
      })
      // As committed (ledger.md#concurrency): a miss committed after the guard fails this commit.
      const stored = await getRowOrNull<Persons>(db, TABLES.persons, senderId)
      if (atMissLimit(stored, now)) throw tooMany()
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: senderId,
        data: isLive(stored, now)
          ? { addressMisses: (stored?.addressMisses ?? 0) + 1 }
          : { addressMisses: 1, addressMissesFrom: now.toISOString() },
      })
    })
  try {
    await record()
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
    await conflictAsTryAgain(record)
  }
}
