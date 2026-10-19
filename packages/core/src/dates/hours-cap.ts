import type { HoursCap } from '../schemas/identity'
import type { DateRange, LocalDate } from './local-date'
import { periodFor } from './periods'

/** Any Monday: weeks count from it, so each runs Monday to Sunday. */
const A_MONDAY = '2024-01-01' as LocalDate

/**
 * The period of a work-hours limit (F-82) that holds `date`: Monday to Sunday for a week, or
 * the 14 days counted from `startsOn` for a fortnight, before it as well as after.
 */
export function capPeriod(cap: Pick<HoursCap, 'period' | 'startsOn'>, date: LocalDate): DateRange {
  return cap.period === 'week'
    ? periodFor('weekly', A_MONDAY, date)
    : periodFor('fortnightly', cap.startsOn ?? null, date)
}

/** The whole paid minutes of the shifts dated within `period`, its ends included. */
export function minutesInPeriod(
  shifts: readonly { date: LocalDate; minutes: number }[],
  period: DateRange,
): number {
  let total = 0
  for (const shift of shifts) {
    // LocalDates compare as text.
    if (shift.date >= period.start && shift.date <= period.end) total += shift.minutes
  }
  return total
}
