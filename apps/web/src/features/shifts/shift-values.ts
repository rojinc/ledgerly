import { parseMoney } from '@ledgerly/core/money/format'
import type { TransactionInput, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'

/** The shift form's fields, all as typed. */
export type ShiftValues = {
  groupId: string
  date: string
  description: string
  /** Start and end times, or the hours worked. */
  timing: 'times' | 'hours'
  startTime: string
  endTime: string
  breakMinutes: string
  hours: string
  rate: string
  /** The note, as typed. */
  note: string
}

/** The stored `shift` part of a transaction's input. */
export type StoredShift = NonNullable<TransactionInput['shift']>

const MINUTES_PER_DAY = 24 * 60
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
// `7`, `7.5`, `7.25` or `7:30`: minutes always have two digits, so `7:3` isn't 7 h 03 min. Up
// to 3 digits of hours, for a fortnight's limit (#53).
const HOURS = /^(\d{1,3})(?:(\.)(\d{1,2})|(:)(\d{2}))?$/

function minutesOfDay(time: string): number | undefined {
  const match = TIME.exec(time)
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

/** Minutes from `start` to `end`; an end at or before the start is the next day. */
export function minutesBetween(start: string, end: string): number | undefined {
  const from = minutesOfDay(start)
  const to = minutesOfDay(end)
  if (from === undefined || to === undefined) return undefined
  return to > from ? to - from : to - from + MINUTES_PER_DAY
}

/** Typed hours as whole minutes: `7.5` and `7:30` are 450. Undefined if it isn't hours. */
export function parseHours(text: string): number | undefined {
  const match = HOURS.exec(text.trim())
  if (!match) return undefined
  const [, whole, , part, colon, clock] = match
  let minutes = Number(whole) * 60
  if (colon) {
    if (Number(clock) > 59) return undefined
    minutes += Number(clock)
  } else if (part !== undefined) {
    // Integers only: `.25` is 25/100 of an hour, rounded to the minute.
    minutes += Math.round((Number(part) * 60) / 10 ** part.length)
  }
  return minutes
}

/** Minutes as hours to type back: 450 → `7:30`, 480 → `8`. */
export function hoursText(minutes: number): string {
  const rest = minutes % 60
  const whole = (minutes - rest) / 60
  return rest === 0 ? String(whole) : `${whole}:${String(rest).padStart(2, '0')}`
}

/** Whole minutes, or undefined for an empty field; NaN makes the schema refuse the rest. */
function wholeMinutes(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/** The paid minutes the form describes: the time between start and end less the break, or the hours. */
export function paidMinutes(values: ShiftValues): number {
  if (values.timing === 'hours') return parseHours(values.hours) ?? Number.NaN
  const span = minutesBetween(values.startTime, values.endTime)
  const breakMinutes = wholeMinutes(values.breakMinutes) ?? 0
  return span === undefined ? Number.NaN : span - breakMinutes
}

/** `POST /transactions` and `PATCH /transactions/{id}` for a shift (functions-api.md#ledger). */
export function toShiftBody(
  values: ShiftValues,
  id: string,
  currency: string,
): z.input<typeof transactionInputSchema> {
  const breakMinutes = values.timing === 'times' ? wholeMinutes(values.breakMinutes) : undefined
  return {
    id,
    groupId: values.groupId,
    kind: 'shift',
    date: values.date,
    description: values.description.trim(),
    shift: {
      minutes: paidMinutes(values),
      rateCents: cents(values.rate, currency),
      ...(breakMinutes === undefined ? {} : { breakMinutes }),
      ...(values.timing === 'times'
        ? { startTime: values.startTime, endTime: values.endTime }
        : {}),
    },
    // `PATCH` replaces the whole input, so a stored note is sent back or it's lost (#485).
    ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
  }
}

/** The form's values for a stored shift, with the stored input's note. */
export function toShiftValues(
  transaction: { groupId: string; date: string; description: string },
  shift: StoredShift,
  rateText: string,
  note = '',
): ShiftValues {
  const times = shift.startTime !== undefined && shift.endTime !== undefined
  return {
    groupId: transaction.groupId,
    date: transaction.date,
    description: transaction.description,
    timing: times ? 'times' : 'hours',
    startTime: shift.startTime ?? '',
    endTime: shift.endTime ?? '',
    breakMinutes: shift.breakMinutes === undefined ? '' : String(shift.breakMinutes),
    hours: hoursText(shift.minutes),
    rate: rateText,
    note,
  }
}

/** Seconds as `1:05:09`. */
export function elapsedText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
