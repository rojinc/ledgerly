import { z } from 'zod'
import { checkDateOrder, descriptionSchema, idSchema, localDateSchema } from './common'
import { checkKindRules, transactionTemplateSchema } from './ledger'

// functions-api.md#scheduler and scheduling.md.

// Occurrence IDs are `<scheduleId>_<YYYYMMDD>`, which must fit in 36 characters.
const scheduleIdSchema = idSchema.length(20)

// RFC 5545 rule parts, minus BYHOUR, BYMINUTE and BYSECOND: rules finer than a day
// only repeat the same date and can be very slow to expand (scheduling.md).
const RRULE_PARTS = new Set([
  'FREQ',
  'UNTIL',
  'COUNT',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
])
const FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

// Checks the rule's parts only; expandSchedule() reads their values.
function rruleIssue(rule: string): string | undefined {
  const parts = new Map<string, string>()
  for (const part of rule.split(';')) {
    const [, key = '', value] = /^([A-Z]+)=([^=]+)$/.exec(part) ?? []
    if (value === undefined) return 'Expected KEY=VALUE parts separated by semicolons'
    if (!RRULE_PARTS.has(key)) return `${key} is not supported`
    if (parts.has(key)) return `${key} appears more than once`
    parts.set(key, value)
  }
  if (!FREQUENCIES.has(parts.get('FREQ') ?? '')) {
    return 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY'
  }
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
  exdates: z.array(localDateSchema).optional(),
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
