import { describe, expect, it } from 'vitest'
import { parseLocalDate } from '../dates/local-date'
import { publicHolidayChecker } from './public-holidays'

const d = parseLocalDate

describe('publicHolidayChecker', () => {
  it('counts public holidays and substitute days, not bank holidays or observances', () => {
    const nsw = publicHolidayChecker('AU-NSW')
    expect(nsw(d('2026-10-05'))).toBe(true) // Labour Day
    expect(nsw(d('2026-12-28'))).toBe(true) // Boxing Day (substitute day)
    expect(nsw(d('2026-10-06'))).toBe(false)
    expect(nsw(d('2026-08-03'))).toBe(false) // Bank Holiday
    expect(nsw(d('2026-05-10'))).toBe(false) // Mother's Day
    expect(nsw(d('2027-01-01'))).toBe(true) // another year
  })

  it('uses the state’s own holidays', () => {
    // Labour Day is the first Monday in October in NSW, but March in Victoria.
    expect(publicHolidayChecker('AU-VIC')(d('2026-10-05'))).toBe(false)
  })

  it('works with a country alone', () => {
    expect(publicHolidayChecker('NZ')(d('2026-12-25'))).toBe(true)
  })

  it('throws for a region it doesn’t know', () => {
    expect(() => publicHolidayChecker('XX')).toThrow(RangeError)
    expect(() => publicHolidayChecker('AU-ZZZ')).toThrow(RangeError)
    expect(() => publicHolidayChecker('SG-01')).toThrow(RangeError) // Singapore has no states
  })
})
