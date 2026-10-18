import { z } from 'zod'
import { checkDateOrder, descriptionSchema, idSchema, localDateSchema } from './common'
import { checkKindRules, transactionTemplateSchema } from './ledger'

// functions-api.md#scheduler and scheduling.md.

// Occurrence IDs are `<scheduleId>_<YYYYMMDD>`, which must fit in 36 characters.
const scheduleIdSchema = idSchema.length(20)
// A year of skipped days.
const MAX_EXDATES = 366

const WEEKDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
const FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

/** A list of whole numbers from 1 to `max`, or down from -1 when `signed` (counted from the end). */
function numbers(max: number, signed = true) {
  const pattern = signed ? /^[+-]?\d{1,3}$/ : /^\d{1,3}$/
  return (value: string) =>
    value.split(',').every((item) => {
      const size = Math.abs(Number(item))
      return pattern.test(item) && size >= 1 && size <= max
    })
}

/** Weekdays, each with an optional ordinal: `MO,WE`, `-1FR` (the last Friday). */
function weekdays(value: string): boolean {
  return value.split(',').every((item) => {
    const [, ordinal, day = ''] = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(item) ?? []
    return WEEKDAYS.has(day) && (ordinal === undefined || numbers(53)(ordinal))
  })
}

const positive = (value: string) => /^[1-9]\d{0,3}$/.test(value)

// RFC 5545 §3.3.10 rule parts and their values, minus BYHOUR, BYMINUTE and BYSECOND:
// rules finer than a day only repeat the same date and can be very slow to expand
// (scheduling.md). FREQ is checked after the loop.
const RRULE_PARTS = new Map<string, (value: string) => boolean>([
  ['FREQ', () => true],
  ['UNTIL', (value) => /^\d{8}(T\d{6}Z?)?$/.test(value)],
  ['COUNT', positive],
  ['INTERVAL', positive],
  ['BYDAY', weekdays],
  ['BYMONTHDAY', numbers(31)],
  ['BYYEARDAY', numbers(366)],
  ['BYWEEKNO', numbers(53)],
  ['BYMONTH', numbers(12, false)],
  ['BYSETPOS', numbers(366)],
  ['WKST', (value) => WEEKDAYS.has(value)],
])

function rruleIssue(rule: string): string | undefined {
  const parts = new Map<string, string>()
  for (const part of rule.split(';')) {
    const [, key = '', value] = /^([A-Z]+)=([^=]+)$/.exec(part) ?? []
    if (value === undefined) return 'Expected KEY=VALUE parts separated by semicolons'
    const isValid = RRULE_PARTS.get(key)
    if (!isValid) return `${key} is not supported`
    if (parts.has(key)) return `${key} appears more than once`
    if (!isValid(value)) return `${key} has an invalid value`
    parts.set(key, value)
  }
  if (!FREQUENCIES.has(parts.get('FREQ') ?? '')) {
    return 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY'
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) return 'Use COUNT or UNTIL, not both'
  return undefined
}

/** An RFC 5545 RRULE without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=TH`. */
export const rruleSchema = z
  .string()
  .max(255)
  .superRefine((rule, ctx) => {
    const message = rruleIssue(rule)
    if (message) ctx.addIssue({ code: 'custom', message })
  })

const scheduleFields = {
  groupId: idSchema,
  kind: z.enum(['shift', 'bill', 'expense', 'income']),
  description: descriptionSchema,
  template: transactionTemplateSchema,
  rrule: rruleSchema,
  startsOn: localDateSchema,
  endsOn: localDateSchema.optional(),
  exdates: z.array(localDateSchema).max(MAX_EXDATES).optional(),
  skipPublicHolidays: z.boolean(),
  autoPost: z.boolean(),
  horizonDays: z.int().min(7).max(120).optional(), // the table's default is 56
}

type ScheduleFields = z.output<z.ZodObject<typeof scheduleFields>>

// Every occurrence becomes a transaction of the schedule's kind, so the template
// follows the same kind rules as a TransactionInput.
function checkSchedule(schedule: ScheduleFields, ctx: z.RefinementCtx): void {
  checkKindRules(schedule.kind, schedule.template, ctx, ['template'])
  checkDateOrder(schedule.startsOn, schedule.endsOn, 'endsOn', ctx)
}

/** `POST /schedules`, and `PATCH /schedules/{id}` with the same `id`. */
export const scheduleInputSchema = z
  .strictObject({ id: scheduleIdSchema, ...scheduleFields })
  .superRefine(checkSchedule)

export type ScheduleInput = z.infer<typeof scheduleInputSchema>

/** `POST /schedules/{id}/end` */
export const endScheduleBodySchema = z.strictObject({ endsOn: localDateSchema })

export type EndScheduleBody = z.infer<typeof endScheduleBodySchema>

/** `POST /schedules/preview`: a ScheduleInput without `id`, plus how many dates to show. */
export const previewScheduleBodySchema = z
  .strictObject({ ...scheduleFields, count: z.int().min(1).max(100).optional() })
  .superRefine(checkSchedule)

export type PreviewScheduleBody = z.infer<typeof previewScheduleBodySchema>
