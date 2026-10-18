import { describe, expect, it } from 'vitest'
import { parseLocalDate } from './local-date'
import { periodFor } from './periods'

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
