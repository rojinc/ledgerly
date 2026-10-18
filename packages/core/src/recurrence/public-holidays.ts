import Holidays from 'date-holidays'
import { addDays, type LocalDate } from '../dates/local-date'

const MS_PER_DAY = 86_400_000

/**
 * Every day of the year's whole-day public holidays, as local dates. A holiday
 * lasting several days counts each day; one starting after midnight (Christmas
 * Eve evening, a half day) doesn't count.
 */
function publicDays(holidays: Holidays, year: number): LocalDate[] {
  return holidays
    .getHolidays(year)
    .filter((holiday) => holiday.type === 'public' && holiday.date.slice(11, 19) === '00:00:00')
    .flatMap((holiday) => {
      const first = holiday.date.slice(0, 10) as LocalDate
      // Whole days only: a trailing half day (Turkey's 3.75-day Bayram) doesn't
      // count. The extra 2 hours absorbs days a DST change made shorter.
      const span = (holiday.end.getTime() - holiday.start.getTime()) / MS_PER_DAY
      return Array.from({ length: Math.max(1, Math.floor(span + 1 / 12)) }, (_, i) =>
        addDays(first, i),
      )
    })
}

/**
 * Whether a date is a public holiday in `region`, e.g. `AU-NSW`
 * (scheduling.md#public-holidays). It compares the library's local date
 * strings, so no timezone is involved. Throws for a region the library doesn't
 * know, rather than silently skipping nothing. Kept apart from expandSchedule
 * so the web bundle never loads holiday data.
 */
export function publicHolidayChecker(region: string): (date: LocalDate) => boolean {
  const [country, state] = region.split('-') as [string, string | undefined]
  const holidays = new Holidays()
  const known =
    Object.hasOwn(holidays.getCountries(), country) &&
    (state === undefined || Object.hasOwn(holidays.getStates(country) ?? {}, state))
  if (!known) throw new RangeError('Unknown holiday region')
  holidays.init(country, state)

  const byYear = new Map<number, Set<string>>()
  return (date) => {
    const year = Number(date.slice(0, 4))
    let days = byYear.get(year)
    if (!days) {
      // Last year's list too, for a holiday that runs past 1 January.
      days = new Set([...publicDays(holidays, year - 1), ...publicDays(holidays, year)])
      byYear.set(year, days)
    }
    return days.has(date)
  }
}
