import { tzOffset } from '@date-fns/tz'
import { addDays, type LocalDate } from './local-date'

const MS_PER_MINUTE = 60_000

function assertTimeZone(timeZone: string): void {
  // Intl throws on names that aren't IANA zones, e.g. "Mars/Base" or "Mars/Base+10".
  try {
    if (typeof timeZone !== 'string') throw new TypeError()
    new Intl.DateTimeFormat('en', { timeZone })
  } catch {
    throw new RangeError('Unknown time zone')
  }
}

/** Today's date in `timeZone` at the instant `now`. */
export function localToday(timeZone: string, now: Date): LocalDate {
  assertTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) =>
    (parts.find((p) => p.type === type) as Intl.DateTimeFormatPart).value
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}` as LocalDate
}

/**
 * `hour`:00 on the wall clock in `timeZone` on `date`, as a UTC ISO instant.
 * Worked out from the zone's UTC offsets only, so the machine's timezone
 * never matters.
 */
export function localTimeToUtc(date: LocalDate, hour: number, timeZone: string): string {
  assertTimeZone(timeZone)
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour)
  // The wall-clock time read as if it were UTC; subtract the zone's offset at
  // that moment. Asking twice lands on the right side of a DST change.
  const offsetAt = (time: number) => tzOffset(timeZone, new Date(time)) * MS_PER_MINUTE
  const guess = wall.getTime() - offsetAt(wall.getTime())
  return new Date(wall.getTime() - offsetAt(guess)).toISOString()
}

/**
 * When a period's statement is drafted: 06:00 local time on the day after
 * `periodEnd`, as a UTC ISO instant (statements.md#periods).
 */
export function closeAtFor(periodEnd: LocalDate, timeZone: string): string {
  return localTimeToUtc(addDays(periodEnd, 1), 6, timeZone)
}
