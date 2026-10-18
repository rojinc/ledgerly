import { addDays, type DateRange, daysBetween, endOfMonth, type LocalDate } from './local-date'

/** Statement cycles that have periods (`none` has none). */
export type PeriodCycle = 'weekly' | 'fortnightly' | 'monthly'

/**
 * The statement period that contains `date` (statements.md#periods).
 * Weekly and fortnightly periods count from `anchor`, backwards too; monthly
 * periods are calendar months and ignore the anchor.
 */
export function periodFor(
  cycle: PeriodCycle,
  anchor: LocalDate | null,
  date: LocalDate,
): DateRange {
  if (cycle === 'monthly') {
    return { start: `${date.slice(0, 8)}01` as LocalDate, end: endOfMonth(date) }
  }
  if (anchor === null) throw new RangeError(`A ${cycle} cycle needs an anchor date`)
  const length = cycle === 'weekly' ? 7 : 14
  const start = addDays(anchor, Math.floor(daysBetween(anchor, date) / length) * length)
  return { start, end: addDays(start, length - 1) }
}
