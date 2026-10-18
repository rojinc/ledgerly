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

  it('counts every day of a holiday lasting several days', () => {
    const korea = publicHolidayChecker('KR')
    // 설날 (Seollal) lasts 17–19 February 2026.
    expect([16, 17, 18, 19, 20].map((day) => korea(d(`2026-02-${day}`)))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
  })

  it('doesn’t count a holiday’s trailing half day', () => {
    // Ramazan Bayramı 2026 runs from the evening of 19 March to noon on 23 March.
    const turkey = publicHolidayChecker('TR')
    expect([20, 21, 22, 23].map((day) => turkey(d(`2026-03-${day}`)))).toEqual([
      true,
      true,
      true,
      false,
    ])
  })

  it('doesn’t count a holiday that starts after midnight', () => {
    // QLD's Christmas Eve holiday starts at 18:00; Christmas Day is whole.
    const qld = publicHolidayChecker('AU-QLD')
    expect(qld(d('2026-12-24'))).toBe(false)
    expect(qld(d('2026-12-25'))).toBe(true)
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
    expect(() => publicHolidayChecker('constructor')).toThrow(RangeError)
    expect(() => publicHolidayChecker('AU-toString')).toThrow(RangeError)
  })
})
