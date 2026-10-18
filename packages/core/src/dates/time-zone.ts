import { TZDate } from '@date-fns/tz'
import { addDays, type LocalDate } from './local-date'

function checked(date: TZDate, timeZone: string): TZDate {
  if (Number.isNaN(date.getTime())) throw new RangeError(`Unknown time zone: "${timeZone}"`)
  return date
}

/** Today's date in `timeZone` at the instant `now`. */
export function localToday(timeZone: string, now: Date): LocalDate {
  const local = checked(new TZDate(now.getTime(), timeZone), timeZone)
  const month = String(local.getMonth() + 1).padStart(2, '0')
  const day = String(local.getDate()).padStart(2, '0')
  return `${local.getFullYear()}-${month}-${day}` as LocalDate
}

/**
 * When a period's statement is drafted: 06:00 local time on the day after
 * `periodEnd`, as a UTC ISO instant (statements.md#periods).
 */
export function closeAtFor(periodEnd: LocalDate, timeZone: string): string {
  const [year, month, day] = addDays(periodEnd, 1).split('-').map(Number) as [
    number,
    number,
    number,
  ]
  const closeAt = checked(new TZDate(year, month - 1, day, 6, 0, 0, timeZone), timeZone)
  return new Date(closeAt.getTime()).toISOString()
}
