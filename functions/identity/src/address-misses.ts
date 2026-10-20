import { ADDRESS_MISS_LIMIT } from '@ledgerly/core/constants/limits'
import type { Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import type { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { conflictAsTryAgain, getRowOrNull, isAppwriteError } from './rows'

const WINDOW_MS = ADDRESS_MISS_LIMIT.hours * 60 * 60 * 1000

type Counted = Pick<Persons, 'addressMisses' | 'addressMissesFrom'>

/**
 * Whether the sender's row holds `ADDRESS_MISS_LIMIT.count` counted checks or more in a live
 * window (identity-and-invites.md#invites, step 2). A count of `null`, on a row made before the
 * column, is 0.
 */
export function atMissLimit(person: Counted | null, now: Date): boolean {
  return (
    liveWindow(person, now) !== null && (person?.addressMisses ?? 0) >= ADDRESS_MISS_LIMIT.count
  )
}

/**
 * The start of the sender's live window, which runs from `addressMissesFrom` until
 * `ADDRESS_MISS_LIMIT.hours` later; null when there is none.
 */
function liveWindow(person: Counted | null, now: Date): string | null {
  const from = person?.addressMissesFrom
  if (!from || now.getTime() >= Date.parse(from) + WINDOW_MS) return null
  return from
}

/**
 * Counting first (#274): counts one address check on the sender's `persons` row before the
 * address is looked at, in one transaction: a guard write (a fresh `rev`), the row read again as
 * committed, then `addressMisses + 1` in a live window, or a new window at 1 from now. At the
 * limit, `tooMany` instead, and nothing is written. A 409 runs it once more, then CONFLICT, still
 * before any address is looked at. The row gets a count and a time only: no address, target or
 * route. Returns the start of the window the count was taken in, for `takeBack`.
 */
export async function countCheck(
  db: Db,
  senderId: string,
  now: Date,
  tooMany: () => AppError,
): Promise<string> {
  // Set by each run, so after a rerun it is the committed run's window.
  let window = ''
  await conflictAsTryAgain(() =>
    onceMore(() =>
      onSenderRow(db, senderId, (stored) => {
        if (atMissLimit(stored, now)) throw tooMany()
        const live = liveWindow(stored, now)
        window = live ?? now.toISOString()
        return live
          ? { addressMisses: (stored?.addressMisses ?? 0) + 1 }
          : { addressMisses: 1, addressMissesFrom: window }
      }),
    ),
  )
  return window
}

/**
 * Taking the count back: the write that gives a sent check its 1 back, for a transaction that
 * guards the sender's row and read it as stored after that: `addressMisses − 1`, never below 0,
 * `addressMissesFrom` unchanged. None once another check has started a new window since
 * `window`, the one the count was taken in, so it can't cancel a check counted there.
 */
export function takeBack(senderId: string, stored: Counted | null, window: string): Write[] {
  const data = takenBack(stored, window)
  return data ? [{ action: 'update', tableId: TABLES.persons, rowId: senderId, data }] : []
}

/**
 * A reminder retry's take-back, in a transaction of its own (identity-and-invites.md#reminders,
 * step 3): the same guard, then `takeBack`'s count. A 409 runs it once more; a second leaves the
 * count up, which only over-counts.
 */
export async function takeBackAlone(db: Db, senderId: string, window: string): Promise<void> {
  try {
    await onceMore(() => onSenderRow(db, senderId, (stored) => takenBack(stored, window)))
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
  }
}

// As instants: Appwrite may give back a datetime in another form than the one written.
function takenBack(stored: Counted | null, window: string): Partial<Persons> | undefined {
  const from = stored?.addressMissesFrom
  if (!from || Date.parse(from) !== Date.parse(window)) return undefined
  return { addressMisses: Math.max(0, (stored?.addressMisses ?? 0) - 1) }
}

/**
 * One transaction on the sender's row: a guard write, the row read again as committed
 * (ledger.md#concurrency), then `change`'s data for it, if any. A write to the row committed
 * after the guard fails this commit.
 */
function onSenderRow(
  db: Db,
  senderId: string,
  change: (stored: Persons | null) => Partial<Persons> | undefined,
): Promise<void> {
  return withTransaction(db, async (tx) => {
    await tx.write({
      action: 'update',
      tableId: TABLES.persons,
      rowId: senderId,
      data: { rev: randomId() },
    })
    const stored = await getRowOrNull<Persons>(db, TABLES.persons, senderId)
    const data = change(stored)
    if (data) await tx.write({ action: 'update', tableId: TABLES.persons, rowId: senderId, data })
  })
}

/** Runs `write`, and once more after a 409. */
async function onceMore(write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
    await write()
  }
}
