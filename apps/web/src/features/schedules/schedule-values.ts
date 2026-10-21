import type { Schedules } from '@ledgerly/core/generated/rows'
import { parseMoney } from '@ledgerly/core/money/format'
import { transactionTemplateSchema } from '@ledgerly/core/schemas/ledger'
import { type ScheduleInput, scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import type { z } from 'zod'
import { centsToText } from '../groups/employer-form'
import { hoursText, parseHours } from '../shifts/shift-values'
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
  /** The dates to skip, as stored: the form lists and changes only those from today on (#487). */
  skipped: string[]
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
  kept: { endsOn?: string; horizonDays?: number } = {},
): z.input<typeof scheduleInputSchema> {
  // Past dates change nothing (PATCH never fills in past dates), so they're sent back as stored.
  const exdates = [...new Set(values.skipped)].sort()
  return {
    ...ids,
    kind: 'shift',
    description: values.description.trim(),
    template: {
      shift: {
        minutes: parseHours(values.hours) ?? Number.NaN,
        rateCents: cents(values.rate, currency),
      },
    },
    rrule: toRrule(values),
    startsOn: values.startsOn,
    ...kept,
    ...(exdates.length ? { exdates } : {}),
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
    skipped: schedule.exdates ?? [],
  }
}

/** What a stored schedule has that the form doesn't show, which a save keeps as it was. */
export function keptOf(schedule: Schedules): { endsOn?: string; horizonDays: number } {
  return {
    ...(schedule.endsOn ? { endsOn: schedule.endsOn } : {}),
    horizonDays: schedule.horizonDays,
  }
}

/**
 * The stored schedule's input as its edit form would save it untouched, checked by the same
 * schema, for Restart (scheduling.md#step-1-expand-due-schedules). Undefined when the form can't
 * show it (`fromSchedule`), as it can't change it either.
 */
export function storedInput(schedule: Schedules, currency: string): ScheduleInput | undefined {
  const values = fromSchedule(schedule, currency)
  if (!values) return undefined
  const ids = { id: schedule.$id, groupId: schedule.groupId }
  const input = scheduleInputSchema.safeParse(
    toScheduleInput(values, ids, currency, keptOf(schedule)),
  )
  return input.success ? input.data : undefined
}
