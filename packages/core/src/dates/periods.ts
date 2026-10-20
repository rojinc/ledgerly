import {
  addDays,
  compareDates,
  type DateRange,
  daysBetween,
  endOfMonth,
  type LocalDate,
} from './local-date'

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
  if (cycle !== 'weekly' && cycle !== 'fortnightly') throw new RangeError('Unknown cycle')
  if (anchor === null) throw new RangeError(`A ${cycle} cycle needs an anchor date`)
  const length = cycle === 'weekly' ? 7 : 14
  const start = addDays(anchor, Math.floor(daysBetween(anchor, date) / length) * length)
  return { start, end: addDays(start, length - 1) }
}

/**
 * The end of the period a close worked out from `from` waits for (statements.md#periods): the
 * period that contains `from`, or, for a weekly or fortnightly cycle whose anchor is later, the
 * anchor's first period, so nothing closes before the first real period (#405).
 */
export function firstPeriodEnd(
  cycle: PeriodCycle,
  anchor: LocalDate | null,
  from: LocalDate,
): LocalDate {
  const later = cycle !== 'monthly' && anchor !== null && compareDates(anchor, from) > 0
  return periodFor(cycle, anchor, later ? anchor : from).end
}
