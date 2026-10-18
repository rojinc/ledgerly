import { addDays, type DateRange, type LocalDate } from '@ledgerly/core/dates/local-date'
import { type PeriodCycle, periodFor } from '@ledgerly/core/dates/periods'
import { closeAtFor, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'

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
 * The period whose statement is due at the stored `nextCloseAt`: it ended the day before.
 * Taken from the stored time, not the cycle as it is now, so a cycle or time zone change made
 * after the period ended (the groups function keeps a due `nextCloseAt`) can't skip it.
 */
export function closingPeriod(group: Groups & { nextCloseAt: string }): DateRange {
  const lastDay = new Date(Date.parse(group.nextCloseAt) - BACK_TO_LAST_DAY_MS)
  return periodEndingOn(group, localToday(group.timezone, lastDay))
}

/** When the period after `periodEnd` closes, or null for a group with no cycle. */
export function closeAfter(group: Groups, periodEnd: LocalDate): string | null {
  if (group.statementCycle === 'none') return null
  const { cycle, anchor } = cycleOf(group)
  return closeAtFor(periodFor(cycle, anchor, addDays(periodEnd, 1)).end, group.timezone)
}
