import {
  addDays,
  compareDates,
  type DateRange,
  type LocalDate,
} from '@ledgerly/core/dates/local-date'
import { type PeriodCycle, periodFor } from '@ledgerly/core/dates/periods'
import { closeAtFor, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'

// statements.md#periods: a statement is due at 06:00 local on the day after its period ends.
// Twelve hours before that is the evening of the last day, even on a night that a DST change
// makes 5 or 7 hours long, or after the group's time zone moved by up to 6 hours.
const BACK_TO_LAST_DAY_MS = 12 * 60 * 60 * 1000

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
 * zone change made after it ended (the groups function keeps a due `nextCloseAt`) can't skip it.
 * It starts the day after `previousEnd`, where the group's last statement before it ended, so
 * such a change leaves no gap or overlap between periods either. A group's first statement
 * starts where its cycle period does.
 */
export function closingPeriod(
  group: Groups & { nextCloseAt: string },
  previousEnd: LocalDate | null,
): DateRange {
  const lastDay = new Date(Date.parse(group.nextCloseAt) - BACK_TO_LAST_DAY_MS)
  const end = localToday(group.timezone, lastDay)
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

/** When the period after `periodEnd` closes, or null for a group with no cycle. */
export function closeAfter(group: Groups, periodEnd: LocalDate): string | null {
  if (group.statementCycle === 'none') return null
  const { cycle, anchor } = cycleOf(group)
  return closeAtFor(periodFor(cycle, anchor, addDays(periodEnd, 1)).end, group.timezone)
}
