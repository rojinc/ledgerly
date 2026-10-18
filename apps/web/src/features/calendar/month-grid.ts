import {
  addDays,
  endOfMonth,
  isLocalDate,
  type LocalDate,
  weekdayOf,
} from '@ledgerly/core/dates/local-date'

/** A month as `YYYY-MM`, the way the calendar's URL holds it. */
export type Month = string

export type MonthGrid = {
  /** First and last day shown: whole weeks, Monday first, so they can be in the next or previous month. */
  start: LocalDate
  end: LocalDate
  weeks: LocalDate[][]
}

/** `YYYY-MM` when it names a real month, else undefined. */
export function parseMonth(text: string | null): Month | undefined {
  return text && /^\d{4}-\d{2}$/.test(text) && isLocalDate(`${text}-01`) ? text : undefined
}

export function monthOf(date: LocalDate): Month {
  return date.slice(0, 7)
}

/** The month `delta` months after `month` (negative for earlier). */
export function shiftMonth(month: Month, delta: number): Month {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const index = year * 12 + (monthNumber - 1) + delta
  const shiftedYear = Math.floor(index / 12)
  return `${String(shiftedYear).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** The weeks that cover `month`, Monday first, with string date maths only (no time zone). */
export function monthGrid(month: Month): MonthGrid {
  const first = `${month}-01` as LocalDate
  const start = addDays(first, 1 - weekdayOf(first))
  const last = endOfMonth(first)
  const end = addDays(last, 7 - weekdayOf(last))
  const weeks: LocalDate[][] = []
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (weekdayOf(day) === 1) weeks.push([])
    weeks.at(-1)?.push(day)
  }
  return { start, end, weeks }
}
