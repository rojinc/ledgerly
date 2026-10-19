import { describe, expect, it } from 'vitest'
import { capPeriod, minutesInPeriod } from './hours-cap'
import { parseLocalDate } from './local-date'

const d = (text: string) => parseLocalDate(text)

describe('capPeriod (#53)', () => {
  const week = { period: 'week' as const }

  it('runs a week from Monday to Sunday', () => {
    const period = { start: '2026-10-19', end: '2026-10-25' }
    expect(capPeriod(week, d('2026-10-19'))).toEqual(period) // Monday
    expect(capPeriod(week, d('2026-10-25'))).toEqual(period) // Sunday
    expect(capPeriod(week, d('2026-10-26'))).toEqual({ start: '2026-10-26', end: '2026-11-01' })
  })

  it('runs a week across a year boundary', () => {
    expect(capPeriod(week, d('2027-01-01'))).toEqual({ start: '2026-12-28', end: '2027-01-03' })
  })

  it('counts a fortnight from its first Monday, before it as well as after', () => {
    const fortnight = { period: 'fortnight' as const, startsOn: d('2026-10-19') }
    const first = { start: '2026-10-19', end: '2026-11-01' }
    expect(capPeriod(fortnight, d('2026-10-19'))).toEqual(first)
    expect(capPeriod(fortnight, d('2026-11-01'))).toEqual(first)
    expect(capPeriod(fortnight, d('2026-11-02'))).toEqual({
      start: '2026-11-02',
      end: '2026-11-15',
    })
    expect(capPeriod(fortnight, d('2026-10-18'))).toEqual({
      start: '2026-10-05',
      end: '2026-10-18',
    })
    expect(capPeriod(fortnight, d('2027-01-01'))).toEqual({
      start: '2026-12-28',
      end: '2027-01-10',
    })
  })

  it('refuses a fortnight with no first Monday', () => {
    expect(() => capPeriod({ period: 'fortnight' }, d('2026-10-19'))).toThrow(RangeError)
  })
})

describe('minutesInPeriod (#53)', () => {
  const period = { start: d('2026-10-19'), end: d('2026-10-25') }

  it('is 0 with no shifts', () => {
    expect(minutesInPeriod([], period)).toBe(0)
  })

  it('sums the shifts in the period, its first and last day included', () => {
    const shifts = [
      { date: d('2026-10-18'), minutes: 600 }, // the Sunday before
      { date: d('2026-10-19'), minutes: 450 },
      { date: d('2026-10-22'), minutes: 300 },
      { date: d('2026-10-25'), minutes: 125 },
      { date: d('2026-10-26'), minutes: 600 }, // the Monday after
    ]
    expect(minutesInPeriod(shifts, period)).toBe(875)
  })
})
