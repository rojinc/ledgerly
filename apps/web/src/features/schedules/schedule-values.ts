import type { Schedules } from '@ledgerly/core/generated/rows'
import { parseMoney } from '@ledgerly/core/money/format'
import { transactionTemplateSchema } from '@ledgerly/core/schemas/ledger'
import type { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import type { z } from 'zod'
import { centsToText } from '../groups/employer-form'
import { fromRrule, type Repeat, toRrule } from './rrule'

/** The schedule form's fields, as typed. Shift schedules only (bills are #33). */
export type ScheduleValues = Repeat & {
  description: string
  /** Paid hours per shift: `5`, `7.5` or `7:30`. */
  hours: string
  rate: string
  startsOn: string
  skipPublicHolidays: boolean
  autoPost: boolean
}

// `7`, `7.5`, `7.25` or `7:30`.
const HOURS = /^(\d{1,2})(?:([.:])(\d{1,2}))?$/

/** Typed hours as whole minutes: `7.5` and `7:30` are 450. NaN if it isn't hours. */
export function parseHours(text: string): number {
  const match = HOURS.exec(text.trim())
  if (!match) return Number.NaN
  const [, whole, separator, part] = match
  let minutes = Number(whole) * 60
  if (separator === ':') {
    if (Number(part) > 59) return Number.NaN
    minutes += Number(part)
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

function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/**
 * `POST /schedules` (and `PATCH` with the same id) for a shift schedule: every occurrence is
 * a shift of those paid minutes at that rate (functions-api.md#scheduler). NaN makes the schema
 * refuse a field that isn't a number.
 */
export function toScheduleInput(
  values: ScheduleValues,
  ids: { id: string; groupId: string },
  currency: string,
  /** What the stored schedule has that this form doesn't show, kept as it was. */
  kept: { endsOn?: string; exdates?: string[]; horizonDays?: number } = {},
): z.input<typeof scheduleInputSchema> {
  return {
    ...ids,
    kind: 'shift',
    description: values.description.trim(),
    template: {
      shift: { minutes: parseHours(values.hours), rateCents: cents(values.rate, currency) },
    },
    rrule: toRrule(values),
    startsOn: values.startsOn,
    ...kept,
    skipPublicHolidays: values.skipPublicHolidays,
    autoPost: values.autoPost,
  }
}

/**
 * The form's values for a stored shift schedule, or undefined if this form can't show it: a
 * rule it never builds, or a template that isn't a plain shift.
 */
export function fromSchedule(schedule: Schedules, currency: string): ScheduleValues | undefined {
  const repeat = fromRrule(schedule.rrule)
  let shift: { minutes: number; rateCents: number } | undefined
  try {
    const template = transactionTemplateSchema.safeParse(JSON.parse(schedule.templateJson))
    // Only a plain shift, minutes and rate: a save would drop anything else (a break, times,
    // a note), so a template with more isn't editable here.
    const plain =
      template.success &&
      Object.keys(template.data).join() === 'shift' &&
      Object.keys(template.data.shift ?? {})
        .sort()
        .join() === 'minutes,rateCents'
    shift = plain ? template.data.shift : undefined
  } catch {
    shift = undefined
  }
  if (!repeat || !shift || schedule.kind !== 'shift') return undefined
  return {
    ...repeat,
    description: schedule.description,
    hours: hoursText(shift.minutes),
    rate: centsToText(shift.rateCents, currency),
    startsOn: schedule.startsOn,
    skipPublicHolidays: schedule.skipPublicHolidays,
    autoPost: schedule.autoPost,
  }
}
