import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Items, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { expandSchedule, occurrenceId } from '@ledgerly/core/recurrence/expand-schedule'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import type { TransactionInput, TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Tx, type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import {
  guardGroup,
  guardGroupAndMembers,
  type Ledger,
  type Plan,
  plan,
  Raced,
  replaceRows,
  teamRead,
  transactionColumns,
} from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'
import { allRows } from './pages'

const MS_PER_MINUTE = 60_000
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

type Occurrence = { input: TransactionInput; planned: Plan }

/** The parts of a schedule an occurrence is made from. */
export type ScheduleTemplate = Pick<
  Schedules,
  '$id' | 'groupId' | 'kind' | 'description' | 'templateJson' | 'createdBy'
>

/** The transaction an occurrence on `date` is (scheduling.md#step-1-expand-due-schedules). */
export function occurrenceInput(schedule: ScheduleTemplate, date: LocalDate): TransactionInput {
  const template = JSON.parse(schedule.templateJson) as TransactionTemplate
  return {
    ...template,
    id: occurrenceId(schedule.$id, date),
    groupId: schedule.groupId,
    kind: schedule.kind,
    date,
    description: schedule.description,
    // A bill occurrence is due on its own date.
    ...(schedule.kind === 'bill'
      ? { bill: { ...template.bill, status: 'due' as const, dueOn: date } }
      : {}),
  }
}

/**
 * Plans the occurrence on `date`: `scheduled`, or `due` for a bill (ledger.md#statuses), with
 * the schedule's creator as the payer when the template names none. The row stores no payer,
 * so whoever posts it pays then. Throws the ledger's error for a template that breaks a
 * ledger rule.
 */
export function planOccurrence(
  schedule: ScheduleTemplate,
  date: LocalDate,
  ledger: Ledger,
): Occurrence {
  const input = occurrenceInput(schedule, date)
  const status = schedule.kind === 'bill' ? 'due' : 'scheduled'
  return { input, planned: plan(input, status, ledger, schedule.createdBy) }
}

/** The next 00:05 in `timeZone` after `today`, as UTC (scheduling.md, step 1). */
export function nextRunAt(today: LocalDate, timeZone: string): string {
  const midnight = Date.parse(localTimeToUtc(addDays(today, 1), 0, timeZone))
  return new Date(midnight + 5 * MS_PER_MINUTE).toISOString()
}

/**
 * Step 1 for one schedule: creates its occurrences from the day after `after` (by default
 * `generatedThrough`; `startsOn` when empty) to `endsOn` or the horizon, whichever comes
 * first, then sets `generatedThrough` and `nextRunAt`. An occurrence whose row exists already, voided or edited, is left as it is
 * (scheduling.md#idempotency). Returns how many it created.
 *
 * Each batch of at most 90 writes is guarded (ledger.md#concurrency): it stages its progress on
 * the schedule row and checks the stored schedule is the one read, then guards the group and
 * the people the template names. Anything that changed meanwhile throws `Raced`, and an
 * occurrence created meanwhile fails the commit with 409, so the caller runs it again.
 */
export async function generateOccurrences(
  db: Db,
  schedule: Schedules,
  group: Groups,
  ledger: Ledger,
  now: Date,
  // An edit expands from its own reset point: another run may have moved generatedThrough on
  // before the edit deleted the occurrences it made (scheduling.md#schedule-routes).
  after = schedule.generatedThrough as LocalDate | null,
): Promise<number> {
  const today = localToday(group.timezone, now)
  const from = laterOf(schedule.startsOn as LocalDate, after ? addDays(after, 1) : null)
  const horizon = addDays(today, schedule.horizonDays)
  const endsOn = schedule.endsOn as LocalDate | null
  const to = endsOn && compareDates(endsOn, horizon) < 0 ? endsOn : horizon
  const dates = compareDates(from, to) <= 0 ? datesOf(schedule, group, from, to) : []
  // By ID, not date: a person can move an occurrence to another day, and its ID is still taken.
  const existing = new Set(
    await existingIds(
      db,
      dates.map((date) => occurrenceId(schedule.$id, date)),
    ),
  )
  const occurrences = dates
    .filter((date) => !existing.has(occurrenceId(schedule.$id, date)))
    .map((date) => planOccurrence(schedule, date, ledger))
  const people = [...new Set(occurrences.flatMap(({ planned }) => planned.people))]
  // Nothing is left to create once everything up to `endsOn` exists.
  const finished = endsOn !== null && compareDates(endsOn, to) <= 0
  const done = {
    generatedThrough: to,
    nextRunAt: finished ? null : nextRunAt(today, group.timezone),
  }

  let seen = schedule
  const batches = batchesOf(occurrences, 2 + people.length)
  for (const [index, batch] of batches.entries()) {
    const last = index === batches.length - 1
    const progress = last ? done : { generatedThrough: batch.at(-1)?.input.date ?? to }
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, seen, progress)
      if (batch.length === 0) return
      await guardGroupAndMembers(tx, db, group, ledger, people)
      await tx.write(...batch.flatMap((occurrence) => occurrenceWrites(schedule, occurrence)))
    })
    seen = { ...seen, ...progress }
  }
  return occurrences.length
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

// The ones of `ids` that have a row.
async function existingIds(db: Db, ids: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (let start = 0; start < ids.length; start += PAGE) {
    const rows = await allRows<Transactions>(db, TABLES.transactions, [
      Query.equal('$id', ids.slice(start, start + PAGE)),
    ])
    found.push(...rows.map((row) => row.$id))
  }
  return found
}

// idx_transaction_position, at most PAGE transactions at a time.
function itemsOf(db: Db, transactionIds: readonly string[]): Promise<Items[]> {
  return allRows<Items>(db, TABLES.items, [Query.equal('transactionId', [...transactionIds])])
}

// A write to a row deleted meanwhile is a race: the caller runs again with things as they are.
async function goneIsRaced(write: Promise<void>): Promise<void> {
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

function datesOf(schedule: Schedules, group: Groups, from: LocalDate, to: LocalDate): LocalDate[] {
  const isHoliday = schedule.skipPublicHolidays ? publicHolidayChecker(group.region) : () => false
  return expandSchedule(
    {
      rrule: schedule.rrule,
      startsOn: schedule.startsOn as LocalDate,
      endsOn: schedule.endsOn as LocalDate | null,
      exdates: schedule.exdates as LocalDate[] | null,
      skipPublicHolidays: schedule.skipPublicHolidays,
    },
    from,
    to,
    isHoliday,
  )
}

// Occurrences in transactions of at most 90 writes, after the `guards` writes each one starts
// with. Always at least one batch, which records the schedule's progress.
function batchesOf(occurrences: Occurrence[], guards: number): Occurrence[][] {
  const batches: Occurrence[][] = [[]]
  let writes = guards
  for (const occurrence of occurrences) {
    const size = 1 + occurrence.planned.items.length
    const current = batches.at(-1) as Occurrence[]
    if (current.length > 0 && writes + size > MAX_OPS_PER_DB_TRANSACTION) {
      batches.push([occurrence])
      writes = guards + size
    } else {
      current.push(occurrence)
      writes += size
    }
  }
  return batches
}

function occurrenceWrites(schedule: Schedules, { input, planned }: Occurrence): Write[] {
  const permissions = teamRead(schedule.groupId)
  return [
    {
      action: 'create',
      tableId: TABLES.transactions,
      rowId: input.id,
      data: {
        ...transactionColumns(input, planned),
        scheduleId: schedule.$id,
        overridden: false,
        statementId: null,
        receiptFileIds: null,
        startedAt: null,
        remindedAt: null,
        voidReason: null,
        // Schedule occurrences use the schedule's createdBy (data-model.md#transactions).
        createdBy: schedule.createdBy,
        updatedBy: schedule.createdBy,
      },
      permissions,
    },
    ...replaceRows(
      TABLES.items,
      [],
      planned.items.map((item) => ({ transactionId: input.id, ...item })),
      permissions,
    ),
  ]
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

function laterOf(date: LocalDate, other: LocalDate | null): LocalDate {
  return other && compareDates(other, date) > 0 ? other : date
}
