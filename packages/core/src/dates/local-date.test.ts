import { describe, expect, it } from 'vitest'
import {
  addDays,
  compareDates,
  daysBetween,
  endOfMonth,
  isLocalDate,
  type LocalDate,
  overlapDays,
  parseLocalDate,
  weekdayOf,
} from './local-date'

const d = (text: string) => parseLocalDate(text)

describe('parseLocalDate / isLocalDate', () => {
  it.each(['2026-10-29', '2028-02-29', '2026-12-31', '0050-01-01', '9999-12-31'])(
    'accepts %s',
    (text) => {
      expect(parseLocalDate(text)).toBe(text)
      expect(isLocalDate(text)).toBe(true)
    },
  )

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-1',
    '26-10-29',
    '2026-10-29T00:00',
    ' 2026-10-29',
    '',
  ])('rejects %j', (text) => {
    expect(isLocalDate(text)).toBe(false)
    expect(() => parseLocalDate(text)).toThrow(RangeError)
  })

  it('rejects values that are not strings', () => {
    expect(isLocalDate(20261029)).toBe(false)
    expect(isLocalDate(null)).toBe(false)
  })
})

describe('addDays', () => {
  it('moves across months, years and leap days', () => {
    expect(addDays(d('2026-10-29'), 1)).toBe('2026-10-30')
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01')
    expect(addDays(d('2028-02-28'), 1)).toBe('2028-02-29')
    expect(addDays(d('2026-03-01'), -1)).toBe('2026-02-28')
    expect(addDays(d('2026-10-29'), 0)).toBe('2026-10-29')
  })

  it('is not moved by Australian daylight saving changes', () => {
    expect(addDays(d('2026-10-03'), 1)).toBe('2026-10-04')
    expect(addDays(d('2026-10-04'), 1)).toBe('2026-10-05')
    expect(addDays(d('2027-04-03'), 1)).toBe('2027-04-04')
    expect(addDays(d('2027-04-04'), 1)).toBe('2027-04-05')
  })
})

describe('daysBetween', () => {
  it('counts days from the first date to the second', () => {
    expect(daysBetween(d('2026-10-01'), d('2026-10-04'))).toBe(3)
    expect(daysBetween(d('2026-10-04'), d('2026-10-01'))).toBe(-3)
    expect(daysBetween(d('2026-07-01'), d('2026-09-30'))).toBe(91)
    expect(daysBetween(d('2026-10-03'), d('2026-10-05'))).toBe(2) // across a DST change
  })
})

describe('compareDates', () => {
  it('orders dates', () => {
    expect(compareDates(d('2026-10-01'), d('2026-10-02'))).toBe(-1)
    expect(compareDates(d('2026-10-02'), d('2026-10-01'))).toBe(1)
    expect(compareDates(d('2026-10-01'), d('2026-10-01'))).toBe(0)
  })
})

describe('weekdayOf', () => {
  it('returns the ISO weekday', () => {
    expect(weekdayOf(d('2026-10-26'))).toBe(1) // Monday
    expect(weekdayOf(d('2026-10-29'))).toBe(4) // Thursday
    expect(weekdayOf(d('2026-11-01'))).toBe(7) // Sunday
    expect(weekdayOf(d('1969-12-31'))).toBe(3) // Wednesday, before 1970
  })
})

describe('overlapDays', () => {
  const range = (start: string, end: string) => ({ start: d(start), end: d(end) })

  it('counts shared days with both ends included', () => {
    // ledger.md#days-present: Cara moved in on 1 Aug; the bill covers 1 Jul–30 Sep.
    expect(overlapDays(range('2026-07-01', '2026-09-30'), range('2026-08-01', '2026-12-31'))).toBe(
      61,
    )
    expect(overlapDays(range('2026-07-01', '2026-09-30'), range('2026-01-01', '2026-12-31'))).toBe(
      92,
    )
    expect(overlapDays(range('2026-08-01', '2026-12-31'), range('2026-07-01', '2026-09-30'))).toBe(
      61,
    )
  })

  it('counts a single shared day as 1 and no shared days as 0', () => {
    expect(overlapDays(range('2026-07-01', '2026-07-31'), range('2026-07-31', '2026-08-31'))).toBe(
      1,
    )
    expect(overlapDays(range('2026-07-01', '2026-07-31'), range('2026-08-01', '2026-08-31'))).toBe(
      0,
    )
  })
})

describe('endOfMonth', () => {
  it.each([
    ['2026-10-15', '2026-10-31'],
    ['2026-02-01', '2026-02-28'],
    ['2028-02-10', '2028-02-29'],
    ['2026-12-31', '2026-12-31'],
    ['2026-04-01', '2026-04-30'],
  ])('%s → %s', (date, end) => {
    expect(endOfMonth(date as LocalDate)).toBe(end)
  })
})
