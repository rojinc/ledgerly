import { RRule } from 'rrule'
import { compareDates, type LocalDate } from '../dates/local-date'

/** The parts of a schedule that decide its dates. */
export type ScheduleDates = {
  rrule: string
  startsOn: LocalDate
  endsOn?: LocalDate | null
  exdates?: readonly LocalDate[] | null
  skipPublicHolidays: boolean
}

// Floating dates (scheduling.md#expanding-occurrences): a local date becomes
// midnight UTC and back, so no machine timezone ever touches it.
const toFloating = (date: LocalDate) => new Date(`${date}T00:00:00.000Z`)
const fromFloating = (date: Date) => date.toISOString().slice(0, 10) as LocalDate

/**
 * The dates a schedule falls on from `from` to `to`, both included: its RRULE
 * counted from `startsOn`, without `exdates`, anything outside
 * `startsOn`–`endsOn` and, when `skipPublicHolidays` is on, days `isHoliday`
 * names. rrule searches until it finds a date after `to`, so a rule that
 * rarely or never matches can be slow; #86 will limit the schema to the rule
 * shapes scheduling.md lists for that reason.
 */
export function expandSchedule(
  schedule: ScheduleDates,
  from: LocalDate,
  to: LocalDate,
  isHoliday: (date: LocalDate) => boolean,
): LocalDate[] {
  const start = compareDates(from, schedule.startsOn) < 0 ? schedule.startsOn : from
  const end = schedule.endsOn && compareDates(schedule.endsOn, to) < 0 ? schedule.endsOn : to
  if (compareDates(start, end) > 0) return []
  const rule = new RRule({
    ...RRule.parseString(schedule.rrule),
    dtstart: toFloating(schedule.startsOn),
  })
  const skipped = new Set(schedule.exdates ?? [])
  return rule
    .between(toFloating(start), toFloating(end), true)
    .map(fromFloating)
    .filter((date) => !skipped.has(date) && !(schedule.skipPublicHolidays && isHoliday(date)))
}

/** `<scheduleId>_<YYYYMMDD>`: the same occurrence always gets the same row ID (scheduling.md#idempotency). */
export function occurrenceId(scheduleId: string, date: LocalDate): string {
  return `${scheduleId}_${date.replaceAll('-', '')}`
}
