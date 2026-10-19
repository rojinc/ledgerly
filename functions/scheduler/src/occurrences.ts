import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Items, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { expandSchedule, occurrenceId } from '@ledgerly/core/recurrence/expand-schedule'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import type { TransactionInput, TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import {
  guardGroupAndMembers,
  type Ledger,
  type Plan,
  plan,
  Raced,
  replaceRows,
  teamRead,
  transactionColumns,
} from '@ledgerly/server/ledger/transactions'
import { guardSchedule, itemsOf, laterOf } from '@ledgerly/server/scheduler/end-schedule'
import { Query } from 'node-appwrite'

const MS_PER_MINUTE = 60_000

type Occurrence = { input: TransactionInput; planned: Plan }

/** The parts of a schedule an occurrence is made from. */
export type ScheduleTemplate = Pick<
  Schedules,
  '$id' | 'groupId' | 'kind' | 'description' | 'templateJson' | 'createdBy'
>

/**
 * Made after its own day (a bill's due date), by a run that came late after an edit or a schedule
 * that starts in the past: step 2 never posts it, so a week an edit moved isn't posted twice, and
 * step 3 reminds the owner of a shift instead (scheduling.md#step-2-auto-post).
 */
export function madeLate(row: Transactions, timeZone: string): boolean {
  const createdOn = localToday(timeZone, new Date(row.$createdAt))
  return compareDates(createdOn, (row.dueOn ?? row.date) as LocalDate) > 0
}

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

/**
 * The next 00:05 in `timeZone` after `today`, as UTC (scheduling.md, step 1). Where the clocks
 * skip midnight west of UTC (Santiago, Havana and the Azores on their DST day), 00:05 would land
 * the evening before, so it is 01:05, just after the day starts. East of UTC (Beirut, Cairo) it
 * already moves on to 01:05. Where midnight happens twice, it is the first 00:05.
 */
export function nextRunAt(today: LocalDate, timeZone: string): string {
  const tomorrow = addDays(today, 1)
  const at = (hour: number) =>
    new Date(Date.parse(localTimeToUtc(tomorrow, hour, timeZone)) + 5 * MS_PER_MINUTE)
  const run = at(0)
  return (localToday(timeZone, run) === tomorrow ? run : at(1)).toISOString()
}

/** What an expansion did: occurrences it created, changed in place, and deleted as stale. */
export type Expansion = { created: number; updated: number; removed: number }

// One change an expansion makes, on one date.
type Step =
  | { action: 'create'; date: LocalDate; occurrence: Occurrence }
  | { action: 'update'; date: LocalDate; row: Transactions; items: Items[]; occurrence: Occurrence }
  | { action: 'delete'; date: LocalDate; row: Transactions; items: Items[] }

/**
 * Step 1 for one schedule (scheduling.md#step-1-expand-due-schedules): brings its occurrences
 * from the day after `after` (by default `generatedThrough`; `startsOn` when empty) to its end
 * or the horizon, whichever comes first, in line with the schedule as it is now, then sets
 * `generatedThrough` and `nextRunAt`. It creates the ones that are missing, by ID (one a person
 * moved to another day still holds its ID). One from the same day on that's still `scheduled`
 * or `due` and not edited is updated in place when the template changed, and deleted with its
 * items when the rule no longer has its date or it lies after the schedule's end. So an edit
 * that stopped partway is put right by the next run, however late. Voided, edited and posted
 * ones are left as they are (scheduling.md#idempotency).
 *
 * Each batch of at most 90 writes is guarded (ledger.md#concurrency): it stages its progress on
 * the schedule row and checks the stored schedule is the one read, guards the group and the
 * people the template names, and after staging checks that the rows it updates or deletes, and
 * their items, are still as read. Anything that changed meanwhile throws `Raced`, and an
 * occurrence created meanwhile fails the commit with 409, so the caller runs it again. Before
 * each batch it stops once `outOfTime` says so, and the next run carries on from its progress.
 */
export async function generateOccurrences(
  db: Db,
  schedule: Schedules,
  group: Groups,
  ledger: Ledger,
  now: Date,
  // An edit expands from its own reset point: another run may have moved generatedThrough on
  // before the edit saved its rule (scheduling.md#schedule-routes).
  after = schedule.generatedThrough as LocalDate | null,
  outOfTime: () => boolean = () => false,
): Promise<Expansion> {
  const today = localToday(group.timezone, now)
  const next = after ? addDays(after, 1) : null
  const from = laterOf(schedule.startsOn as LocalDate, next)
  const horizon = addDays(today, schedule.horizonDays)
  const end = scheduleEnd(schedule)
  const to = end && compareDates(end, horizon) < 0 ? end : horizon
  const dates = compareDates(from, to) <= 0 ? datesOf(schedule, group, from, to) : []
  const ids = new Map(dates.map((date) => [occurrenceId(schedule.$id, date), date]))
  // idx_schedule_date: the ones the schedule may still change, from where it creates. Not
  // limited to startsOn, so a later startsOn removes the ones before it. An edit moves
  // generatedThrough to yesterday, so nothing before today changes.
  const changeable = (
    await allRows<Transactions>(db, TABLES.transactions, [
      Query.equal('scheduleId', schedule.$id),
      Query.greaterThanEqual('date', next ?? from),
    ])
  ).filter(isChangeable)
  const itemsByRow = groupItems(
    await itemsOf(
      db,
      changeable.map((row) => row.$id),
    ),
  )
  const rows = new Map(changeable.map((row) => [row.$id, row]))
  const existing = new Set(await existingIds(db, [...ids.keys()]))

  const steps: Step[] = []
  for (const [id, date] of ids) {
    const occurrence = planOccurrence(schedule, date, ledger)
    const row = rows.get(id)
    if (!existing.has(id)) {
      steps.push({ action: 'create', date, occurrence })
    } else if (row && differs(row, itemsByRow.get(id) ?? [], occurrence)) {
      steps.push({ action: 'update', date, row, items: itemsByRow.get(id) ?? [], occurrence })
    }
  }
  for (const row of changeable) {
    const date = row.date as LocalDate
    const stale = compareDates(date, to) <= 0 || (end !== null && compareDates(date, end) > 0)
    // A date the rule no longer has (before startsOn, say), or after its end. Later ones wait
    // until the window reaches them.
    if (!ids.has(row.$id) && stale) {
      steps.push({ action: 'delete', date, row, items: itemsByRow.get(row.$id) ?? [] })
    }
  }
  steps.sort((a, b) => compareDates(a.date, b.date))
  const people = [
    ...new Set(
      steps.flatMap((step) => (step.action === 'delete' ? [] : step.occurrence.planned.people)),
    ),
  ]
  // Nothing is left to create once everything up to the end exists.
  const finished = end !== null && compareDates(end, to) <= 0
  const done = {
    // Never back: `to` is earlier after an end, and a later run must not reach behind it.
    generatedThrough: laterOf(to, after),
    nextRunAt: finished ? null : nextRunAt(today, group.timezone),
  }

  let seen = schedule
  const result: Expansion = { created: 0, updated: 0, removed: 0 }
  const batches = batchesOf(steps, 2 + people.length)
  for (const [index, batch] of batches.entries()) {
    if (outOfTime()) break
    const last = index === batches.length - 1
    const reached = batch.at(-1)?.date ?? to
    // Never back, between batches either: after an end before yesterday, `to` is earlier than
    // `after`, and a rerun from there would reach past occurrences that wait for the user.
    const progress = last
      ? done
      : { generatedThrough: laterOf(compareDates(reached, to) < 0 ? reached : to, after) }
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, seen, progress)
      if (batch.length === 0) return
      await guardGroupAndMembers(tx, db, group, ledger, people)
      await tx.write(...batch.flatMap((step) => stepWrites(schedule, step)))
      await requireUnchanged(db, batch)
    })
    seen = { ...seen, ...progress }
    for (const step of batch) {
      if (step.action === 'create') result.created += 1
      if (step.action === 'update') result.updated += 1
      if (step.action === 'delete') result.removed += 1
    }
  }
  return result
}

/**
 * The last date the schedule can fall on: its `endsOn`, or its rule's own end (`UNTIL`, or the
 * `COUNT`th date, counted before exdates and holidays as RFC 5545 does), whichever is first.
 * Null when it never ends.
 */
export function scheduleEnd(
  schedule: Pick<Schedules, 'rrule' | 'startsOn' | 'endsOn'>,
): LocalDate | null {
  const endsOn = schedule.endsOn as LocalDate | null
  const parts = new Map(
    schedule.rrule.split(';').map((part) => part.split('=') as [string, string]),
  )
  const until = parts.get('UNTIL')
  const startsOn = schedule.startsOn as LocalDate
  const ruleEnd = until
    ? (`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` as LocalDate)
    : parts.has('COUNT')
      ? (expandSchedule(
          { rrule: schedule.rrule, startsOn, skipPublicHolidays: false },
          startsOn,
          // COUNT is at most 500, monthly at the sparsest: under 42 years.
          addDays(startsOn, 366 * 45),
          () => false,
        ).at(-1) ?? startsOn)
      : null
  if (!ruleEnd) return endsOn
  return endsOn && compareDates(endsOn, ruleEnd) < 0 ? endsOn : ruleEnd
}

// Still `scheduled` or `due`, and not edited: the schedule may change or delete it.
function isChangeable(row: Transactions): boolean {
  return (row.status === 'scheduled' || row.status === 'due') && !row.overridden
}

// Whether the stored occurrence or its items differ from what the template makes now.
function differs(row: Transactions, items: Items[], { input, planned }: Occurrence): boolean {
  const columns = Object.entries(transactionColumns(input, planned)).some(
    ([column, value]) =>
      JSON.stringify(row[column as keyof Transactions] ?? null) !== JSON.stringify(value ?? null),
  )
  const stored = [...items]
    .sort((a, b) => a.position - b.position)
    .map(({ position, name, quantity, amountCents, category, splitJson }) => ({
      position,
      name,
      quantity,
      amountCents,
      category: category ?? null,
      splitJson,
    }))
  return columns || JSON.stringify(stored) !== JSON.stringify(planned.items)
}

// The writes of one step: an occurrence created with its items, updated in place (its items
// replaced), or deleted with its items.
function stepWrites(schedule: Schedules, step: Step): Write[] {
  if (step.action === 'create') return occurrenceWrites(schedule, step.occurrence)
  if (step.action === 'delete') {
    return [
      { action: 'delete', tableId: TABLES.transactions, rowId: step.row.$id },
      ...step.items.map((item) => ({
        action: 'delete' as const,
        tableId: TABLES.items,
        rowId: item.$id,
      })),
    ]
  }
  const { input, planned } = step.occurrence
  return [
    {
      action: 'update',
      tableId: TABLES.transactions,
      rowId: step.row.$id,
      // updatedBy stays the schedule's creator: nobody else has changed a changeable row.
      data: transactionColumns(input, planned),
    },
    ...replaceRows(
      TABLES.items,
      [...step.items].sort((a, b) => a.position - b.position),
      planned.items.map((item) => ({ transactionId: input.id, ...item })),
      teamRead(schedule.groupId),
    ),
  ]
}

// After staging: the rows a batch updates or deletes are still changeable, and have no item it
// didn't read. The stored rows, not this transaction's view. An item added before the batch
// was staged would be left without its transaction; one added after it also wrote the
// transaction row, so the commit fails.
async function requireUnchanged(db: Db, batch: Step[]): Promise<void> {
  const touched = batch.flatMap((step) => (step.action === 'create' ? [] : [step]))
  if (touched.length === 0) return
  const ids = touched.map((step) => step.row.$id)
  const stored = await allRows<Transactions>(db, TABLES.transactions, [Query.equal('$id', ids)])
  if (stored.length !== ids.length || !stored.every(isChangeable)) throw new Raced()
  const read = new Set(touched.flatMap((step) => step.items.map((item) => item.$id)))
  if ((await itemsOf(db, ids)).some((item) => !read.has(item.$id))) throw new Raced()
}

function groupItems(items: Items[]): Map<string, Items[]> {
  const byRow = new Map<string, Items[]>()
  for (const item of items)
    byRow.set(item.transactionId, [...(byRow.get(item.transactionId) ?? []), item])
  return byRow
}

// Ids per query, well under Appwrite's limit on values in one `equal`.
const PAGE = 50

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

// Steps in transactions of at most 90 writes, after the `guards` writes each one starts with.
// Always at least one batch, which records the schedule's progress. An occurrence has at most
// 30 items, so each step fits.
function batchesOf(steps: Step[], guards: number): Step[][] {
  const batches: Step[][] = [[]]
  let writes = guards
  for (const occurrence of steps) {
    const size = stepSize(occurrence)
    const current = batches.at(-1) as Step[]
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

function stepSize(step: Step): number {
  if (step.action === 'create') return 1 + step.occurrence.planned.items.length
  if (step.action === 'delete') return 1 + step.items.length
  return 1 + Math.max(step.items.length, step.occurrence.planned.items.length)
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
