/**
 * A calendar date as `YYYY-MM-DD` in the group's timezone (D-005). Plain text,
 * so it never shifts between timezones. Make one with `parseLocalDate`.
 */
export type LocalDate = string & { readonly __brand: 'LocalDate' }

/** Both ends included. */
export type DateRange = { start: LocalDate; end: LocalDate }

const MS_PER_DAY = 86_400_000
const PATTERN = /^\d{4}-\d{2}-\d{2}$/

// Days since 1970-01-01, counted in UTC so the machine's timezone never
// matters. setUTCFullYear, unlike Date.UTC, doesn't turn year 0050 into 1950.
function toDayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const time = new Date(0)
  time.setUTCFullYear(year, month - 1, day)
  return time.getTime() / MS_PER_DAY
}

function fromDayNumber(dayNumber: number): LocalDate {
  const time = new Date(dayNumber * MS_PER_DAY)
  const year = String(time.getUTCFullYear()).padStart(4, '0')
  const month = String(time.getUTCMonth() + 1).padStart(2, '0')
  const day = String(time.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}` as LocalDate
}

/** True for a real calendar date in `YYYY-MM-DD` form; `2026-02-30` is false. */
export function isLocalDate(value: unknown): value is LocalDate {
  // An impossible date like 02-30 rolls over to 03-02 and no longer matches.
  return (
    typeof value === 'string' && PATTERN.test(value) && fromDayNumber(toDayNumber(value)) === value
  )
}

export function parseLocalDate(text: string): LocalDate {
  if (!isLocalDate(text)) throw new RangeError('Not a calendar date (YYYY-MM-DD)')
  return text
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const result = Number.isInteger(days) ? fromDayNumber(toDayNumber(date) + days) : ''
  if (!isLocalDate(result))
    throw new RangeError('addDays needs a whole number of days within years 0000–9999')
  return result
}

/** Days from `from` to `to`: `daysBetween('2026-10-01', '2026-10-04')` is 3. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toDayNumber(to) - toDayNumber(from)
}

export function compareDates(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(toDayNumber(date) * MS_PER_DAY).getUTCDay() || 7
}

/** Number of days two ranges share, both ends included; 0 if they don't meet. */
export function overlapDays(a: DateRange, b: DateRange): number {
  const start = a.start > b.start ? a.start : b.start
  const end = a.end < b.end ? a.end : b.end
  return Math.max(0, daysBetween(start, end) + 1)
}

/** The last day of the month `date` falls in. */
export function endOfMonth(date: LocalDate): LocalDate {
  const [year, month] = date.split('-').map(Number) as [number, number]
  const time = new Date(0)
  time.setUTCFullYear(year, month, 0) // day 0 of the next month
  return fromDayNumber(time.getTime() / MS_PER_DAY)
}
