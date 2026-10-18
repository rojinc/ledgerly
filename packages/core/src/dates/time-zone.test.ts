import { describe, expect, it } from 'vitest'
import { parseLocalDate } from './local-date'
import { closeAtFor, localToday } from './time-zone'

const SYDNEY = 'Australia/Sydney'
const at = (iso: string) => new Date(iso)

describe('localToday', () => {
  it('uses the group timezone, not UTC or the machine', () => {
    // 13:30 UTC on 18 Oct is 00:30 on 19 Oct in Sydney (UTC+11).
    expect(localToday(SYDNEY, at('2026-10-18T13:30:00Z'))).toBe('2026-10-19')
    expect(localToday('UTC', at('2026-10-18T13:30:00Z'))).toBe('2026-10-18')
    expect(localToday('America/Los_Angeles', at('2026-10-18T03:00:00Z'))).toBe('2026-10-17')
  })

  it('handles the minutes around the DST changes in Sydney', () => {
    // DST starts 2026-10-04 02:00 AEST (+10) → 03:00 AEDT (+11).
    expect(localToday(SYDNEY, at('2026-10-03T13:59:00Z'))).toBe('2026-10-03') // 23:59 AEST
    expect(localToday(SYDNEY, at('2026-10-03T14:00:00Z'))).toBe('2026-10-04') // 00:00 AEST
    // DST ends 2027-04-04 03:00 AEDT (+11) → 02:00 AEST (+10).
    expect(localToday(SYDNEY, at('2027-04-03T12:59:00Z'))).toBe('2027-04-03') // 23:59 AEDT
    expect(localToday(SYDNEY, at('2027-04-03T13:00:00Z'))).toBe('2027-04-04') // 00:00 AEDT
    expect(localToday(SYDNEY, at('2027-04-04T13:59:00Z'))).toBe('2027-04-04') // 23:59 AEST
  })

  it('rejects an unknown time zone', () => {
    expect(() => localToday('Mars/Base', at('2026-10-18T00:00:00Z'))).toThrow(RangeError)
  })
})

describe('closeAtFor', () => {
  it('is 06:00 local on the day after the period ends, as UTC', () => {
    // statements.md / user flow 5: October closes at 06:00 on 1 Nov in Sydney (AEDT, +11).
    expect(closeAtFor(parseLocalDate('2026-10-31'), SYDNEY)).toBe('2026-10-31T19:00:00.000Z')
    expect(closeAtFor(parseLocalDate('2026-07-31'), SYDNEY)).toBe('2026-07-31T20:00:00.000Z') // AEST, +10
    expect(closeAtFor(parseLocalDate('2026-12-31'), 'UTC')).toBe('2027-01-01T06:00:00.000Z')
  })

  it('uses the offset in force on the close day when DST changes', () => {
    expect(closeAtFor(parseLocalDate('2026-10-03'), SYDNEY)).toBe('2026-10-03T19:00:00.000Z') // 4 Oct, +11
    expect(closeAtFor(parseLocalDate('2027-04-03'), SYDNEY)).toBe('2027-04-03T20:00:00.000Z') // 4 Apr, +10
  })

  it('rejects an unknown time zone', () => {
    expect(() => closeAtFor(parseLocalDate('2026-10-31'), 'Mars/Base')).toThrow(RangeError)
  })
})
