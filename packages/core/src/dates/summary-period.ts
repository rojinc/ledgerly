import { addDays, type DateRange, endOfMonth, type LocalDate, weekdayOf } from './local-date'
import { periodFor } from './periods'
import { localTimeToUtc, localToday } from './time-zone'

export type SummaryFrequency = 'none' | 'weekly' | 'fortnightly' | 'monthly'

const SEND_HOUR = 7

/** The first day on or after `date` that a summary can go out: a Monday, or the 1st. */
function firstSendDay(frequency: Exclude<SummaryFrequency, 'none'>, date: LocalDate): LocalDate {
  if (frequency === 'monthly') return date.endsWith('-01') ? date : addDays(endOfMonth(date), 1)
  return addDays(date, (8 - weekdayOf(date)) % 7)
}

/**
 * When the next summary goes out, as a UTC ISO instant strictly after `now`,
 * or null for `none` (scheduling.md#step-4-summary-emails). Pass `previous`,
 * the `nextSummaryAt` that just fired, when moving forward after a send, so a
 * fortnightly cycle keeps counting from its last send.
 */
export function nextSummaryAt(
  frequency: SummaryFrequency,
  timeZone: string,
  now: Date,
  previous?: string | null,
): string | null {
  if (frequency === 'none') return null
  const at = (day: LocalDate) => localTimeToUtc(day, SEND_HOUR, timeZone)
  const isPast = (day: LocalDate) => Date.parse(at(day)) <= now.getTime()
  if (frequency === 'fortnightly' && previous) {
    // Snapping to a Monday keeps the cycle on Mondays if the timezone changed.
    let day = firstSendDay(frequency, addDays(localToday(timeZone, new Date(previous)), 14))
    while (isPast(day)) day = addDays(day, 14)
    return at(day)
  }
  const day = firstSendDay(frequency, localToday(timeZone, now))
  return at(isPast(day) ? firstSendDay(frequency, addDays(day, 1)) : day)
}

/**
 * The days a summary sent on `sendDate` covers: the period that ended the day
 * before, counted back from `sendDate` (or the previous calendar month).
 */
export function summaryPeriod(
  frequency: Exclude<SummaryFrequency, 'none'>,
  sendDate: LocalDate,
): DateRange {
  return periodFor(frequency, sendDate, addDays(sendDate, -1))
}
