import Holidays from 'date-holidays'
import type { LocalDate } from '../dates/local-date'

/**
 * Whether a date is a public holiday in `region`, e.g. `AU-NSW`
 * (scheduling.md#public-holidays). Only type `public` counts. It compares the
 * library's local date strings, so no timezone is involved. Throws for a
 * region the library doesn't know, rather than silently skipping nothing.
 * Kept apart from expandSchedule so the web bundle never loads holiday data.
 */
export function publicHolidayChecker(region: string): (date: LocalDate) => boolean {
  const [country, state] = region.split('-') as [string, string | undefined]
  const holidays = new Holidays()
  const known =
    country in holidays.getCountries() &&
    (state === undefined || state in (holidays.getStates(country) ?? {}))
  if (!known) throw new RangeError('Unknown holiday region')
  holidays.init(country, state)

  const byYear = new Map<string, Set<string>>()
  return (date) => {
    const year = date.slice(0, 4)
    let days = byYear.get(year)
    if (!days) {
      days = new Set(
        holidays
          .getHolidays(Number(year))
          .filter((holiday) => holiday.type === 'public')
          .map((holiday) => holiday.date.slice(0, 10)),
      )
      byYear.set(year, days)
    }
    return days.has(date)
  }
}
