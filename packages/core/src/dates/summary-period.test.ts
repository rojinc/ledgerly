import { describe, expect, it } from 'vitest'
import { parseLocalDate } from './local-date'
import { nextSummaryAt, summaryPeriod } from './summary-period'

const SYDNEY = 'Australia/Sydney'
const at = (iso: string) => new Date(iso)

describe('nextSummaryAt', () => {
  it('is null for none', () => {
    expect(nextSummaryAt('none', SYDNEY, at('2026-10-18T09:00:00Z'))).toBeNull()
  })

  it('weekly: the next Monday at 07:00 local, strictly after now', () => {
    // Sunday 18 Oct, 20:00 in Sydney (AEDT, UTC+11) → Monday 19 Oct 07:00
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-10-18T09:00:00Z'))).toBe(
      '2026-10-18T20:00:00.000Z',
    )
    // Monday 06:59 local → today at 07:00; Monday 07:00 exactly → next week
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-10-18T19:59:00Z'))).toBe(
      '2026-10-18T20:00:00.000Z',
    )
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-10-18T20:00:00Z'))).toBe(
      '2026-10-25T20:00:00.000Z',
    )
  })

  it('stays at 07:00 local across Sydney’s DST changes', () => {
    // October: 28 Sep is still AEST (UTC+10); 5 Oct is AEDT (UTC+11)
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-09-26T00:00:00Z'))).toBe(
      '2026-09-27T21:00:00.000Z',
    )
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-10-03T00:00:00Z'))).toBe(
      '2026-10-04T20:00:00.000Z',
    )
    // April: 30 Mar is AEDT; 6 Apr is back to AEST
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-03-28T00:00:00Z'))).toBe(
      '2026-03-29T20:00:00.000Z',
    )
    expect(nextSummaryAt('weekly', SYDNEY, at('2026-04-04T00:00:00Z'))).toBe(
      '2026-04-05T21:00:00.000Z',
    )
  })

  it('monthly: the 1st at 07:00 local', () => {
    expect(nextSummaryAt('monthly', SYDNEY, at('2026-10-18T09:00:00Z'))).toBe(
      '2026-10-31T20:00:00.000Z',
    )
    // 1 Nov 06:00 local → that day; 1 Nov 08:00 local → 1 Dec
    expect(nextSummaryAt('monthly', SYDNEY, at('2026-10-31T19:00:00Z'))).toBe(
      '2026-10-31T20:00:00.000Z',
    )
    expect(nextSummaryAt('monthly', SYDNEY, at('2026-10-31T21:00:00Z'))).toBe(
      '2026-11-30T20:00:00.000Z',
    )
    expect(nextSummaryAt('monthly', 'UTC', at('2026-12-15T00:00:00Z'))).toBe(
      '2027-01-01T07:00:00.000Z',
    )
  })

  it('fortnightly: starts on the next Monday, then every 14 days from the last send', () => {
    expect(nextSummaryAt('fortnightly', SYDNEY, at('2026-10-18T09:00:00Z'), null)).toBe(
      '2026-10-18T20:00:00.000Z',
    )
    const sent = '2026-10-18T20:00:00.000Z'
    expect(nextSummaryAt('fortnightly', SYDNEY, at('2026-10-18T20:05:00Z'), sent)).toBe(
      '2026-11-01T20:00:00.000Z',
    )
    // A late run skips a missed send but keeps the cycle: 2 Nov is past, so 16 Nov
    expect(nextSummaryAt('fortnightly', SYDNEY, at('2026-11-08T00:00:00Z'), sent)).toBe(
      '2026-11-15T20:00:00.000Z',
    )
  })

  it('fortnightly: snaps back to a Monday if the timezone changed since the last send', () => {
    // That send was Sunday 18 Oct in Los Angeles; +14 is Sunday 1 Nov, so
    // Monday 2 Nov 07:00 PST (US DST ended on 1 Nov).
    expect(
      nextSummaryAt(
        'fortnightly',
        'America/Los_Angeles',
        at('2026-10-19T00:00:00Z'),
        '2026-10-18T20:00:00.000Z',
      ),
    ).toBe('2026-11-02T15:00:00.000Z')
  })

  it('rejects unknown time zones', () => {
    expect(() => nextSummaryAt('weekly', 'Mars/Base', at('2026-10-18T09:00:00Z'))).toThrow(
      RangeError,
    )
  })
})

describe('summaryPeriod', () => {
  const d = parseLocalDate

  it('weekly: the previous Monday to Sunday', () => {
    expect(summaryPeriod('weekly', d('2026-10-19'))).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    })
  })

  it('fortnightly: the 14 days before', () => {
    expect(summaryPeriod('fortnightly', d('2026-11-02'))).toEqual({
      start: '2026-10-19',
      end: '2026-11-01',
    })
  })

  it('monthly: the previous calendar month', () => {
    expect(summaryPeriod('monthly', d('2026-11-01'))).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    })
    expect(summaryPeriod('monthly', d('2026-03-01'))).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    })
    expect(summaryPeriod('monthly', d('2027-01-01'))).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    })
  })
})
