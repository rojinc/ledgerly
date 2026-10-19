import Holidays from 'date-holidays'
import { addDays, type LocalDate } from '../dates/local-date'

const MS_PER_DAY = 86_400_000

/**
 * Days a state's official list has and date-holidays 3.37.0 doesn't, checked on 2026-10-19
 * (scheduling.md#public-holidays). Upgrading the library means checking these again: the pins in
 * public-holidays.test.ts fail where its dates move.
 */
const ADDED: Readonly<Record<string, readonly string[]>> = {
  // Christmas Day stays a holiday on Saturday 25 Dec 2027, with Monday 27 Dec added: Public
  // Holidays Act 2023 (SA) s 3(2), and safework.sa.gov.au/resources/public-holidays. The library
  // still moves it, as the repealed Holidays Act 1910 did.
  'AU-SA': ['2027-12-25'],
  // The same: Public Holidays Act 1981 (NT) sch 2 ("25 December … and, if that day falls on a
  // Saturday or Sunday, the following Monday"), and nt.gov.au/nt-public-holidays.
  'AU-NT': ['2027-12-25'],
}

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

  // A known region, so not a name like `constructor`.
  const added = ADDED[region] ?? []
  const byYear = new Map<number, Set<string>>()
  return (date) => {
    const year = Number(date.slice(0, 4))
    let days = byYear.get(year)
    if (!days) {
      // Last year's list too, for a holiday that runs past 1 January.
      days = new Set([...publicDays(holidays, year - 1), ...publicDays(holidays, year), ...added])
      byYear.set(year, days)
    }
    return days.has(date)
  }
}
