import { describe, expect, it } from 'vitest'
import { monthGrid, monthOf, parseMonth, shiftMonth } from './month-grid'

// Pure string maths: the same under TZ=UTC (CI) and TZ=Australia/Sydney (run both by hand).
describe('monthGrid', () => {
  it('covers October 2026 in whole weeks, Monday first', () => {
    const grid = monthGrid('2026-10')
    // 1 October 2026 is a Thursday; 31 October a Saturday.
    expect(grid.start).toBe('2026-09-28')
    expect(grid.end).toBe('2026-11-01')
    expect(grid.weeks).toHaveLength(5)
    expect(grid.weeks.map((week) => week.length)).toEqual([7, 7, 7, 7, 7])
    expect(grid.weeks[0]?.slice(0, 4)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ])
    expect(grid.weeks.at(-1)?.at(-1)).toBe('2026-11-01')
  })

  it('starts on the 1st when it is a Monday, and ends on the last day when it is a Sunday', () => {
    // June 2026: Monday 1 to Tuesday 30.
    expect(monthGrid('2026-06')).toMatchObject({ start: '2026-06-01', end: '2026-07-05' })
    // February 2021: Monday 1 to Sunday 28, exactly four weeks.
    const february = monthGrid('2021-02')
    expect(february).toMatchObject({ start: '2021-02-01', end: '2021-02-28' })
    expect(february.weeks).toHaveLength(4)
  })

  it('handles leap years, six-week months and the daylight-saving change in October', () => {
    expect(monthGrid('2024-02').weeks.flat()).toContain('2024-02-29')
    expect(monthGrid('2023-02').weeks.flat()).not.toContain('2023-02-29')
    // August 2026: Saturday 1 to Monday 31 needs six rows.
    expect(monthGrid('2026-08').weeks).toHaveLength(6)
    // Sydney moves to daylight saving on 4 October 2026: no day is skipped or doubled.
    const days = monthGrid('2026-10').weeks.flat()
    expect(new Set(days).size).toBe(35)
    expect(days).toContain('2026-10-04')
  })
})

describe('months', () => {
  it('moves across years both ways', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-10', -22)).toBe('2024-12')
  })

  it('reads only real months, and takes the month of a date', () => {
    expect(parseMonth('2026-10')).toBe('2026-10')
    expect(parseMonth('2026-13')).toBeUndefined()
    expect(parseMonth('2026-1')).toBeUndefined()
    expect(parseMonth(null)).toBeUndefined()
    expect(monthOf('2026-10-18' as never)).toBe('2026-10')
  })
})
