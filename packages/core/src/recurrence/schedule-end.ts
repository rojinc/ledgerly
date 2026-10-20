import { addDays, compareDates, type LocalDate } from '../dates/local-date'
import type { Schedules } from '../generated/rows'
import { expandSchedule } from './expand-schedule'

/**
 * The last date the schedule can fall on: the earliest of its `endsOn`, the day before its
 * `pausedFrom`, and its rule's own end (`UNTIL`, or the `COUNT`th date, counted before exdates,
 * holidays and a pause as RFC 5545 does). Null when it never ends.
 */
export function scheduleEnd(
  schedule: Pick<Schedules, 'rrule' | 'startsOn' | 'endsOn' | 'pausedFrom'>,
): LocalDate | null {
  const parts = new Map(
    schedule.rrule.split(';').map((part) => part.split('=') as [string, string]),
  )
  const until = parts.get('UNTIL')
  const startsOn = schedule.startsOn as LocalDate
  const ruleEnd = until
    ? (`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` as LocalDate)
    : parts.has('COUNT')
      ? (expandSchedule(
          // Counted before holidays: none of the days is one.
          { rrule: schedule.rrule, startsOn, skipPublicHolidays: true },
          startsOn,
          // COUNT is at most 500, monthly at the sparsest: under 42 years.
          addDays(startsOn, 366 * 45),
          () => false,
        ).at(-1) ?? startsOn)
      : null
  const paused = schedule.pausedFrom ? addDays(schedule.pausedFrom as LocalDate, -1) : null
  const ends = [schedule.endsOn as LocalDate | null, paused, ruleEnd]
  return ends.filter((date) => date !== null).sort(compareDates)[0] ?? null
}
