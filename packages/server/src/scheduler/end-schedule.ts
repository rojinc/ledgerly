import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Items, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { AppwriteException, Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { allRows } from '../appwrite/pages'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import { type Tx, withTransaction } from '../appwrite/transaction'
import { guardGroup, Raced } from '../ledger/transactions'

// The schedule row's columns an expansion depends on. A change to any of them by someone else
// makes the expansion run again with the schedule as it is now.
const SCHEDULE_COLUMNS = [
  'kind',
  'description',
  'templateJson',
  'rrule',
  'startsOn',
  'endsOn',
  'exdates',
  'skipPublicHolidays',
  'autoPost',
  'horizonDays',
  'generatedThrough',
  'nextRunAt',
] as const

/**
 * Ends the schedule on `endsOn`, as `scheduler POST /schedules/{id}/end` does once it has
 * checked the caller and the date (scheduling.md#schedule-routes), and as deleting an account
 * does (identity-and-invites.md#deleting-an-account-m4). In one transaction with the schedule
 * and group guards, it sets `endsOn`, makes the schedule due at once and moves
 * `generatedThrough` to no earlier than yesterday; then it deletes the occurrences from the
 * later of the day after `endsOn` and today that are still `scheduled` or `due` and not edited.
 * So the next cron run deletes whatever this didn't get to (a timeout, say), or carries on up to
 * a later `endsOn` than before. It never plans the template, so a schedule can always be ended.
 * Anything that changed meanwhile throws `Raced` (or the commit fails with 409), and the caller
 * runs it again. Returns how many occurrences it deleted.
 */
export async function endScheduleOn(
  db: Db,
  group: Groups,
  schedule: Schedules,
  endsOn: LocalDate,
  now: Date,
): Promise<number> {
  const today = localToday(group.timezone, now)
  const yesterday = addDays(today, -1)
  const generated = schedule.generatedThrough as LocalDate | null
  const done = generated !== null && compareDates(generated, endsOn) >= 0
  // The next run carries on from here: up to a later end, or deleting what's left after an
  // earlier one. Never from before today, so nothing past is made, changed or deleted.
  const through = generated === null ? null : laterOf(done ? endsOn : generated, yesterday)
  await withTransaction(db, async (tx) => {
    await guardSchedule(tx, db, schedule, {
      endsOn,
      generatedThrough: through,
      nextRunAt: now.toISOString(),
    })
    // An archive that lands meanwhile makes this run again.
    await guardGroup(tx, db, group)
  })
  // Only future ones: a past occurrence that wasn't posted waits for the user.
  const after = addDays(endsOn, 1)
  const from = compareDates(after, today) > 0 ? after : today
  return removeOccurrences(db, group, schedule.$id, from)
}

/**
 * Deletes the schedule's occurrences dated `from` or later that are still `scheduled` or `due`
 * and not edited (`overridden`), with their items. `all` deletes every one that isn't posted,
 * for `DELETE /schedules/{id}`, voided and edited ones last, so a delete that stops partway
 * leaves the rows that keep their dates from being made again. Each batch guards the group,
 * stages its deletes, then checks the stored rows and items: a row edited, posted or voided
 * meanwhile, an item added to it, or an archive or settings change throws `Raced`
 * (ledger.md#concurrency). Returns how many it deleted.
 */
export async function removeOccurrences(
  db: Db,
  group: Groups,
  scheduleId: string,
  from: LocalDate | null,
  options: { all?: boolean } = {},
): Promise<number> {
  const removable = (row: Transactions) =>
    options.all
      ? row.status !== 'posted' && row.statementId === null
      : (row.status === 'scheduled' || row.status === 'due') && !row.overridden
  // idx_schedule_date. Paged by $id: another request may be deleting these rows too.
  const rows = (
    await allRows<Transactions>(db, TABLES.transactions, [
      Query.equal('scheduleId', scheduleId),
      ...(from ? [Query.greaterThanEqual('date', from)] : []),
    ])
  )
    .filter(removable)
    .sort((a, b) => Number(keepsDate(a)) - Number(keepsDate(b)))
  for (let start = 0; start < rows.length; start += PAGE) {
    const page = rows.slice(start, start + PAGE)
    const items = await itemsOf(
      db,
      page.map((row) => row.$id),
    )
    // Each occurrence goes with its items, in transactions of at most 90 writes, so no item
    // is ever left without its transaction.
    const units = page.map((row) => [
      row.$id,
      ...items.filter((item) => item.transactionId === row.$id).map((item) => item.$id),
    ])
    for (const batch of packed(units)) {
      await withTransaction(db, async (tx) => {
        await guardGroup(tx, db, group)
        await goneIsRaced(
          tx.write(
            ...batch.flatMap(([rowId, ...itemIds]) => [
              { action: 'delete' as const, tableId: TABLES.transactions, rowId: rowId as string },
              ...itemIds.map((itemId) => ({
                action: 'delete' as const,
                tableId: TABLES.items,
                rowId: itemId,
              })),
            ]),
          ),
        )
        // The stored rows and items, not this transaction's view, where they're already gone.
        // An item added before the deletes were staged would be left without its transaction;
        // one added after it also wrote the transaction row, so the commit fails.
        const ids = batch.map(([rowId]) => rowId as string)
        const stored = await allRows<Transactions>(db, TABLES.transactions, [
          Query.equal('$id', ids),
        ])
        if (stored.length !== ids.length || !stored.every(removable)) throw new Raced()
        const staged = new Set(batch.flat())
        if ((await itemsOf(db, ids)).some((item) => !staged.has(item.$id))) throw new Raced()
      })
    }
  }
  return rows.length
}

// Ids per query, well under Appwrite's limit on values in one `equal`.
const PAGE = 50

// A voided or edited occurrence keeps its date from being made again (scheduling.md#idempotency).
function keepsDate(row: Transactions): boolean {
  return row.status === 'void' || row.overridden
}

/** idx_transaction_position, PAGE transactions at a time. */
export async function itemsOf(db: Db, transactionIds: readonly string[]): Promise<Items[]> {
  const items: Items[] = []
  for (let start = 0; start < transactionIds.length; start += PAGE) {
    items.push(
      ...(await allRows<Items>(db, TABLES.items, [
        Query.equal('transactionId', transactionIds.slice(start, start + PAGE)),
      ])),
    )
  }
  return items
}

/** A write to a row deleted meanwhile is a race: the caller runs again with things as they are. */
export async function goneIsRaced(write: Promise<void>): Promise<void> {
  try {
    await write
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) throw new Raced()
    throw error
  }
}

/**
 * Stages `data` on the schedule row, then checks the stored row still has what `seen` has:
 * another expansion, edit or end that got there first makes this one run again.
 */
export async function guardSchedule(
  tx: Tx,
  db: Db,
  seen: Schedules,
  data: Partial<Schedules>,
): Promise<void> {
  await goneIsRaced(
    tx.write({ action: 'update', tableId: TABLES.schedules, rowId: seen.$id, data }),
  )
  let stored: Schedules
  try {
    stored = await db.getRow<Schedules>({
      databaseId: DATABASE_ID,
      tableId: TABLES.schedules,
      rowId: seen.$id,
    })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) throw new Raced()
    throw error
  }
  const changed = SCHEDULE_COLUMNS.some(
    (column) => JSON.stringify(stored[column]) !== JSON.stringify(seen[column]),
  )
  if (changed) throw new Raced()
}

// Groups of ids (an occurrence first, then its items) packed into transactions of at most 90
// writes, after the group's guard. An occurrence has at most 30 items, so each group fits.
function packed(units: string[][]): string[][][] {
  const batches: string[][][] = []
  let writes = MAX_OPS_PER_DB_TRANSACTION
  for (const unit of units) {
    if (writes + unit.length > MAX_OPS_PER_DB_TRANSACTION) {
      batches.push([])
      writes = 1
    }
    batches.at(-1)?.push(unit)
    writes += unit.length
  }
  return batches
}

/** The later of two dates; `date` when `other` is empty. */
export function laterOf(date: LocalDate, other: LocalDate | null): LocalDate {
  return other && compareDates(other, date) > 0 ? other : date
}
