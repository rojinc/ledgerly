import {
  addDays,
  compareDates,
  type DateRange,
  type LocalDate,
} from '@ledgerly/core/dates/local-date'
import { firstPeriodEnd, type PeriodCycle, periodFor } from '@ledgerly/core/dates/periods'
import { closeAtFor, localToday, periodEndClosedAt } from '@ledgerly/core/dates/time-zone'
import type { Groups, Statements, Transactions } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'

function cycleOf(group: Groups): { cycle: PeriodCycle; anchor: LocalDate | null } {
  // A group with no cycle counts in calendar months, for previews.
  const cycle = group.statementCycle === 'none' ? 'monthly' : group.statementCycle
  return { cycle, anchor: group.cycleAnchor as LocalDate | null }
}

/** The period that ends on `end`, starting where the group's cycle period containing it starts. */
export function periodEndingOn(group: Groups, end: LocalDate): DateRange {
  const { cycle, anchor } = cycleOf(group)
  return { start: periodFor(cycle, anchor, end).start, end }
}

/**
 * The period whose statement is due at the stored `nextCloseAt` (statements.md#periods). It ends
 * the day before, taken from the stored time, not the cycle as it is now, so a cycle or time
 * zone change made after it ended can't skip it: the groups function keeps a due `nextCloseAt`,
 * re-expressed in a new time zone (#126). It starts the day after `previousEnd`, where the
 * group's last statement before it ended, so such a change leaves no gap or overlap between
 * periods either. A group's first statement starts where its cycle period does.
 */
export function closingPeriod(
  group: Groups & { nextCloseAt: string },
  previousEnd: LocalDate | null,
): DateRange {
  const end = periodEndClosedAt(group.nextCloseAt, group.timezone)
  if (previousEnd && compareDates(previousEnd, end) < 0) {
    return { start: addDays(previousEnd, 1), end }
  }
  return periodEndingOn(group, end)
}

/**
 * `closingPeriod` after the group's latest statement that ends before it, void ones included: a
 * void period is redone by a reissue of its own range (`idx_group_period`).
 */
export async function closingPeriodOf(
  db: Db,
  group: Groups & { nextCloseAt: string },
): Promise<DateRange> {
  const { end } = closingPeriod(group, null)
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', group.$id),
      Query.lessThan('periodEnd', end),
      Query.orderDesc('periodEnd'),
      Query.limit(1),
    ],
    total: false,
  })
  return closingPeriod(group, (rows[0]?.periodEnd ?? null) as LocalDate | null)
}

/**
 * Where a statement ending on `end` starts when an admin closes it now
 * (statements.md#6-close-a-period-now-post-statementsclose): the day after the group's latest
 * statement, void ones included. A first statement starts where the cycle period containing
 * `end` does; with no cycle, on the group's earliest posted transaction up to `end`, or the day
 * it was created.
 */
export async function closeStart(db: Db, group: Groups, end: LocalDate): Promise<LocalDate> {
  const latest = await latestStatement(db, group.$id)
  if (latest) return addDays(latest.periodEnd as LocalDate, 1)
  if (group.statementCycle !== 'none') return periodEndingOn(group, end).start
  const { rows: first } = await db.listRows<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    queries: [
      Query.equal('groupId', group.$id),
      Query.equal('status', 'posted'),
      Query.lessThanEqual('date', end),
      Query.orderAsc('date'),
      Query.limit(1),
    ],
    total: false,
  })
  return (
    (first[0]?.date as LocalDate | undefined) ??
    localToday(group.timezone, new Date(group.$createdAt))
  )
}

/** The group's statement with the latest `periodEnd`, void ones included (`idx_group_period`). */
export async function latestStatement(db: Db, groupId: string): Promise<Statements | undefined> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', groupId), Query.orderDesc('periodEnd'), Query.limit(1)],
    total: false,
  })
  return rows[0]
}

/**
 * A close's default end, and the preview's: today in the group's time zone, or the job's period
 * end while that period waits for the job.
 */
export function closeEnd(group: Groups, now: Date): LocalDate {
  const today = localToday(group.timezone, now)
  const jobEnd = jobPeriodEnd(group)
  return jobEnd && compareDates(jobEnd, today) < 0 ? jobEnd : today
}

/** The last day of the period the job drafts next, or null when it drafts none (cycle `none`). */
export function jobPeriodEnd(group: Groups): LocalDate | null {
  return group.nextCloseAt ? periodEndClosedAt(group.nextCloseAt, group.timezone) : null
}

/** When the period after `periodEnd` closes, or null for a group with no cycle. */
export function closeAfter(group: Groups, periodEnd: LocalDate): string | null {
  if (group.statementCycle === 'none') return null
  const { cycle, anchor } = cycleOf(group)
  // A future anchor's first period, not a stub before it (statements.md#periods, #405).
  return closeAtFor(firstPeriodEnd(cycle, anchor, addDays(periodEnd, 1)), group.timezone)
}
