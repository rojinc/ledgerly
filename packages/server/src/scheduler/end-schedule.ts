import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Items, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { AppwriteException, Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { allRows } from '../appwrite/pages'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import { type Tx, withTransaction } from '../appwrite/transaction'
import { receiptRows, writeReceiptRows } from '../ledger/receipt-files'
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
  return removeOccurrences(db, group, schedule.$id, from, now)
}

/**
 * Deletes the schedule and all its occurrences, voided and edited ones included, with their
 * items, taking their receipts off, as `scheduler DELETE /schedules/{id}` does once it has checked the caller and that none
 * is posted (scheduling.md#schedule-routes), and as deleting an account does with one that
 * hasn't started (identity-and-invites.md#each-group-they-joined). A post meanwhile leaves that
 * occurrence, so the schedule isn't deleted: `Raced`.
 */
export async function deleteScheduleRows(
  db: Db,
  group: Groups,
  scheduleId: string,
  now: Date,
): Promise<void> {
  await removeOccurrences(db, group, scheduleId, null, now, { all: true })
  await withTransaction(db, async (tx) => {
    await tx.write({ action: 'delete', tableId: TABLES.schedules, rowId: scheduleId })
    // An archive that lands meanwhile makes this run again and get ARCHIVED.
    await guardGroup(tx, db, group)
    // An occurrence created meanwhile (a cron run) would be left without its schedule. One
    // created after this was staged also wrote the schedule row, so the commit fails.
    if (await hasOccurrence(db, scheduleId, [])) throw new Raced()
  })
}

/** Whether the schedule has an occurrence that matches `queries` (`idx_schedule_date`). */
export async function hasOccurrence(
  db: Db,
  scheduleId: string,
  queries: string[],
): Promise<boolean> {
  const { rows } = await db.listRows<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    queries: [Query.equal('scheduleId', scheduleId), ...queries, Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}

/**
 * Deletes the schedule's occurrences dated `from` or later that are still `scheduled` or `due`
 * and not edited (`overridden`), with their items. `all` deletes every one that isn't posted,
 * for `DELETE /schedules/{id}`, voided and edited ones last, so a delete that stops partway
 * leaves the rows that keep their dates from being made again; those can list receipts, which
 * it takes off (data-model.md#receiptfiles). Each batch guards the group, stages its deletes,
 * then checks the stored rows and items: a row edited, posted or voided meanwhile, an item
 * added to it, or an archive or settings change throws `Raced` (ledger.md#concurrency).
 * Returns how many it deleted.
 */
export async function removeOccurrences(
  db: Db,
  group: Groups,
  scheduleId: string,
  from: LocalDate | null,
  now: Date,
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
    // Each occurrence goes with its items and its receipt rows, in transactions of at most 90
    // writes, so no item is ever left without its transaction.
    const units = page.map((row) => ({
      row,
      itemIds: items.filter((item) => item.transactionId === row.$id).map((item) => item.$id),
    }))
    const writesOf = ({ row, itemIds }: (typeof units)[number]) =>
      1 + itemIds.length + (row.receiptFileIds?.length ?? 0)
    for (const batch of packed(units, writesOf)) {
      await withTransaction(db, async (tx) => {
        await guardGroup(tx, db, group)
        const fileIds = batch.flatMap(({ row }) => row.receiptFileIds ?? [])
        const receipts = await receiptRows(db, [...new Set(fileIds)])
        await goneIsRaced(
          tx.write(
            ...batch.flatMap(({ row, itemIds }) => [
              { action: 'delete' as const, tableId: TABLES.transactions, rowId: row.$id },
              ...itemIds.map((itemId) => ({
                action: 'delete' as const,
                tableId: TABLES.items,
                rowId: itemId,
              })),
            ]),
          ),
        )
        await writeReceiptRows(
          db,
          tx,
          receipts,
          batch.flatMap(({ row }) =>
            (row.receiptFileIds ?? []).map((fileId) => ({ fileId, remove: [row.$id] })),
          ),
          now,
        )
        // The stored rows and items, not this transaction's view, where they're already gone.
        // An item or receipt added before the deletes were staged would be left without its
        // transaction; one added after it also wrote the transaction row, so the commit fails.
        const ids = batch.map(({ row }) => row.$id)
        const stored = await allRows<Transactions>(db, TABLES.transactions, [
          Query.equal('$id', ids),
        ])
        const receiptsAsRead = new Map(batch.map(({ row }) => [row.$id, receiptList(row)]))
        const unchanged = (row: Transactions) =>
          removable(row) && receiptList(row) === receiptsAsRead.get(row.$id)
        if (stored.length !== ids.length || !stored.every(unchanged)) throw new Raced()
        const staged = new Set(batch.flatMap(({ row, itemIds }) => [row.$id, ...itemIds]))
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

// Units of writes (an occurrence, its items and its receipt rows) packed into transactions of at
// most 90 writes, after the group's guard. An occurrence has at most 30 items and 10 receipts,
// so each unit fits.
function packed<T>(units: readonly T[], writesOf: (unit: T) => number): T[][] {
  const batches: T[][] = []
  let writes = MAX_OPS_PER_DB_TRANSACTION
  for (const unit of units) {
    if (writes + writesOf(unit) > MAX_OPS_PER_DB_TRANSACTION) {
      batches.push([])
      writes = 1
    }
    batches.at(-1)?.push(unit)
    writes += writesOf(unit)
  }
  return batches
}

const receiptList = (row: Transactions) => JSON.stringify(row.receiptFileIds ?? [])

/** The later of two dates; `date` when `other` is empty. */
export function laterOf(date: LocalDate, other: LocalDate | null): LocalDate {
  return other && compareDates(other, date) > 0 ? other : date
}
