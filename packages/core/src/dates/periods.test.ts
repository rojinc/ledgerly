import { describe, expect, it } from 'vitest'
import { parseLocalDate } from './local-date'
import { firstPeriodEnd, periodFor } from './periods'

const d = (text: string) => parseLocalDate(text)

describe('periodFor', () => {
  it('uses calendar months for monthly and ignores the anchor', () => {
    expect(periodFor('monthly', null, d('2026-10-18'))).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    })
    expect(periodFor('monthly', d('2026-10-05'), d('2026-02-14'))).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    })
    expect(periodFor('monthly', null, d('2026-12-31'))).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    })
  })

  it('counts weekly periods from the anchor', () => {
    const anchor = d('2026-10-05') // a Monday
    expect(periodFor('weekly', anchor, d('2026-10-05'))).toEqual({
      start: '2026-10-05',
      end: '2026-10-11',
    })
    expect(periodFor('weekly', anchor, d('2026-10-11'))).toEqual({
      start: '2026-10-05',
      end: '2026-10-11',
    })
    expect(periodFor('weekly', anchor, d('2026-10-12'))).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    })
  })

  it('counts weekly periods backwards from the anchor too', () => {
    expect(periodFor('weekly', d('2026-10-05'), d('2026-10-04'))).toEqual({
      start: '2026-09-28',
      end: '2026-10-04',
    })
  })

  it('counts fortnightly periods from the anchor, across a DST change', () => {
    const anchor = d('2026-09-28')
    expect(periodFor('fortnightly', anchor, d('2026-10-04'))).toEqual({
      start: '2026-09-28',
      end: '2026-10-11',
    })
    expect(periodFor('fortnightly', anchor, d('2026-10-12'))).toEqual({
      start: '2026-10-12',
      end: '2026-10-25',
    })
    expect(periodFor('fortnightly', anchor, d('2026-09-27'))).toEqual({
      start: '2026-09-14',
      end: '2026-09-27',
    })
  })

  it('rejects a cycle without periods', () => {
    expect(() => periodFor('none' as 'weekly', d('2026-10-05'), d('2026-10-18'))).toThrow(
      RangeError,
    )
  })

  it('needs an anchor for weekly and fortnightly cycles', () => {
    expect(() => periodFor('weekly', null, d('2026-10-18'))).toThrow(RangeError)
    expect(() => periodFor('fortnightly', null, d('2026-10-18'))).toThrow(RangeError)
  })
})

describe('firstPeriodEnd (#405)', () => {
  const monday = d('2026-11-02')

  it('ends the period that contains the day, with no anchor or one already passed', () => {
    expect(firstPeriodEnd('monthly', null, d('2026-11-01'))).toBe('2026-11-30')
    expect(firstPeriodEnd('weekly', d('2026-10-05'), d('2026-11-01'))).toBe('2026-11-01')
  })

  it('ends the period that starts on the anchor, when the anchor is that day', () => {
    expect(firstPeriodEnd('weekly', monday, monday)).toBe('2026-11-08')
  })

  it('folds the days before a later anchor into its first period', () => {
    // Counted backwards, 1 November would be the last day of a stub week.
    expect(periodFor('weekly', monday, d('2026-11-01')).end).toBe('2026-11-01')
    expect(firstPeriodEnd('weekly', monday, d('2026-11-01'))).toBe('2026-11-08')
    expect(firstPeriodEnd('fortnightly', monday, d('2026-10-20'))).toBe('2026-11-15')
  })

  it('ignores a later anchor for a monthly cycle', () => {
    expect(firstPeriodEnd('monthly', d('2026-12-07'), d('2026-11-01'))).toBe('2026-11-30')
  })

  it('needs an anchor for a weekly or fortnightly cycle', () => {
    expect(() => firstPeriodEnd('fortnightly', null, d('2026-11-01'))).toThrow(RangeError)
  })
})
