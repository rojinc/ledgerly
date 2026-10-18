import { describe, expect, it } from 'vitest'
import {
  elapsedText,
  hoursText,
  minutesBetween,
  paidMinutes,
  parseHours,
  type ShiftValues,
  toShiftBody,
  toShiftValues,
} from './shift-values'

const BASE: ShiftValues = {
  groupId: 'g1',
  date: '2026-10-08',
  description: ' Thursday shift ',
  timing: 'times',
  startTime: '09:00',
  endTime: '17:30',
  breakMinutes: '30',
  hours: '',
  rate: '25.50',
}

describe('shift times', () => {
  it('counts minutes between times, an earlier end being the next day', () => {
    expect(minutesBetween('09:00', '17:30')).toBe(510)
    expect(minutesBetween('22:00', '06:00')).toBe(480)
    // Same start and end: a full day, not nothing.
    expect(minutesBetween('08:00', '08:00')).toBe(1440)
    expect(minutesBetween('9:00', '17:00')).toBeUndefined()
    expect(minutesBetween('24:00', '17:00')).toBeUndefined()
  })

  it('reads hours as 7, 7.5, 7.25 or 7:30, with whole-minute rounding', () => {
    expect(parseHours('7')).toBe(420)
    expect(parseHours('7.5')).toBe(450)
    expect(parseHours(' 7:30 ')).toBe(450)
    expect(parseHours('7.25')).toBe(435)
    expect(parseHours('0.33')).toBe(20)
    expect(parseHours('7:60')).toBeUndefined()
    expect(parseHours('7.555')).toBeUndefined()
    expect(parseHours('-1')).toBeUndefined()
    expect(parseHours('seven')).toBeUndefined()
  })

  it('writes minutes back as hours to type', () => {
    expect(hoursText(450)).toBe('7:30')
    expect(hoursText(480)).toBe('8')
    expect(hoursText(5)).toBe('0:05')
    expect(parseHours(hoursText(437))).toBe(437)
  })

  it('pays the time between start and end less the break, or the hours', () => {
    expect(paidMinutes(BASE)).toBe(480)
    expect(paidMinutes({ ...BASE, breakMinutes: '' })).toBe(510)
    expect(paidMinutes({ ...BASE, breakMinutes: '600' })).toBe(-90)
    expect(paidMinutes({ ...BASE, breakMinutes: 'x' })).toBeNaN()
    expect(paidMinutes({ ...BASE, timing: 'hours', hours: '7.5' })).toBe(450)
    expect(paidMinutes({ ...BASE, timing: 'hours', hours: '' })).toBeNaN()
  })

  it('shows elapsed seconds as H:MM:SS', () => {
    expect(elapsedText(0)).toBe('0:00:00')
    expect(elapsedText(3909.7)).toBe('1:05:09')
    expect(elapsedText(-5)).toBe('0:00:00')
  })
})

describe('toShiftBody', () => {
  it('builds the shift with times, break and the rate in cents, without floats', () => {
    expect(toShiftBody(BASE, 'x1', 'AUD')).toEqual({
      id: 'x1',
      groupId: 'g1',
      kind: 'shift',
      date: '2026-10-08',
      description: 'Thursday shift',
      shift: {
        minutes: 480,
        rateCents: 2550,
        breakMinutes: 30,
        startTime: '09:00',
        endTime: '17:30',
      },
    })
    // A currency without cents.
    expect(toShiftBody({ ...BASE, rate: '2500' }, 'x1', 'JPY').shift?.rateCents).toBe(2500)
  })

  it('sends only minutes and rate for hours, and NaN for what the schema must refuse', () => {
    expect(toShiftBody({ ...BASE, timing: 'hours', hours: '7:30' }, 'x1', 'AUD').shift).toEqual({
      minutes: 450,
      rateCents: 2550,
    })
    expect(toShiftBody({ ...BASE, rate: '25.555' }, 'x1', 'AUD').shift?.rateCents).toBeNaN()
    expect(toShiftBody({ ...BASE, breakMinutes: '' }, 'x1', 'AUD').shift).not.toHaveProperty(
      'breakMinutes',
    )
  })

  it('turns a stored shift back into the same values', () => {
    const body = toShiftBody(BASE, 'x1', 'AUD')
    const values = toShiftValues(
      { groupId: 'g1', date: '2026-10-08', description: 'Thursday shift' },
      body.shift as NonNullable<typeof body.shift>,
      '25.50',
    )
    expect(values).toEqual({ ...BASE, description: 'Thursday shift', hours: '8' })
    const hours = toShiftValues(
      { groupId: 'g1', date: '2026-10-08', description: 'Shift' },
      { minutes: 450, rateCents: 2550 },
      '25.50',
    )
    expect(hours).toMatchObject({ timing: 'hours', hours: '7:30', startTime: '', breakMinutes: '' })
  })
})
