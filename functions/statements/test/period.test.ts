import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { closeAtFor } from '@ledgerly/core/dates/time-zone'
import type { Groups } from '@ledgerly/core/generated/rows'
import { describe, expect, it } from 'vitest'
import { closingPeriod } from '../src/period'
import { job } from './harness'

const groupIn = (timezone: string, extra: object = {}) =>
  job({}, { timezone, ...extra }) as unknown as Groups

describe('closingPeriod', () => {
  // The night before each close has a DST change, so it is 7 (or 6.5) hours long, or 5.
  it.each([
    [
      'New York, monthly, clocks back on 1 November',
      'America/New_York',
      {},
      '2026-10-01',
      '2026-10-31',
    ],
    [
      'London, weekly, clocks back on 25 October',
      'Europe/London',
      { statementCycle: 'weekly', cycleAnchor: '2026-10-18' },
      '2026-10-18',
      '2026-10-24',
    ],
    [
      'Sydney, weekly, clocks back on 4 April',
      'Australia/Sydney',
      { statementCycle: 'weekly', cycleAnchor: '2027-03-28' },
      '2027-03-28',
      '2027-04-03',
    ],
    [
      'Lord Howe, weekly, half an hour back on 4 April',
      'Australia/Lord_Howe',
      { statementCycle: 'weekly', cycleAnchor: '2027-03-28' },
      '2027-03-28',
      '2027-04-03',
    ],
    [
      'Sydney, weekly, clocks forward on 4 October',
      'Australia/Sydney',
      { statementCycle: 'weekly', cycleAnchor: '2026-09-27' },
      '2026-09-27',
      '2026-10-03',
    ],
  ])('%s', (_case, timezone, extra, start, end) => {
    const group = groupIn(timezone, extra)
    const nextCloseAt = closeAtFor(end as LocalDate, timezone)
    expect(closingPeriod({ ...group, nextCloseAt })).toEqual({ start, end })
  })

  it.each([
    ['east, Perth to Sydney', 'Australia/Perth', 'Australia/Sydney'],
    ['west, Sydney to Perth', 'Australia/Sydney', 'Australia/Perth'],
  ])('keeps the period after a time zone change %s', (_case, before, after) => {
    const nextCloseAt = closeAtFor('2026-10-31' as LocalDate, before)
    expect(closingPeriod({ ...groupIn(after), nextCloseAt })).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    })
  })
})
