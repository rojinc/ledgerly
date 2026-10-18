import { z } from 'zod'
import { compareDates, isLocalDate, type LocalDate, parseLocalDate } from '../dates/local-date'
import { checkDateOrder, descriptionSchema, idSchema, localDateSchema } from './common'
import { checkKindRules, transactionTemplateSchema } from './ledger'

// functions-api.md#scheduler and scheduling.md.

// Occurrence IDs are `<scheduleId>_<YYYYMMDD>`, which must fit in 36 characters.
const scheduleIdSchema = idSchema.length(20)
// A year of skipped days.
const MAX_EXDATES = 366

// Expanding from far in the past is slow, and no schedule needs to start that early.
const EARLIEST_DATE = parseLocalDate('2000-01-01')
const scheduleDateSchema = localDateSchema.refine(
  (date) => compareDates(date, EARLIEST_DATE) >= 0,
  {
    message: `Must be on or after ${EARLIEST_DATE}`,
    when: (payload) => payload.issues.length === 0,
  },
)

const WEEKDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])

/** One or more plain weekday codes, each once: `TH`, `MO,WE,FR`. */
function weekdays(value: string): boolean {
  const days = value.split(',')
  return days.every((day) => WEEKDAYS.has(day)) && new Set(days).size === days.length
}

/** The date of an `UNTIL` value `YYYYMMDD`, if it is a real calendar day. */
function untilDate(value: string): LocalDate | undefined {
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
  return /^\d{8}$/.test(value) && isLocalDate(date) ? date : undefined
}

// RFC 5545 §3.3.10 parts, limited to the values the UI uses. FREQ is checked against
// the shapes below.
const RRULE_PARTS = new Map<string, (value: string) => boolean>([
  ['FREQ', () => true],
  ['BYDAY', weekdays],
  ['INTERVAL', (value) => /^[1-4]$/.test(value)], // up to every fourth week
  ['BYMONTHDAY', (value) => /^(-1|[1-9]|1\d|2[0-8])$/.test(value)], // every month has it
  ['COUNT', (value) => /^[1-9]\d{0,2}$/.test(value) && Number(value) <= 500],
  ['UNTIL', (value) => untilDate(value) !== undefined],
])

// scheduling.md#rules-the-ui-builds: the only rules accepted. Others can take seconds
// to expand, and POST /schedules and /schedules/preview expand while the caller waits.
const SHAPES = new Map([
  ['WEEKLY', { needs: 'BYDAY', allows: new Set(['FREQ', 'BYDAY', 'INTERVAL', 'COUNT', 'UNTIL']) }],
  ['MONTHLY', { needs: 'BYMONTHDAY', allows: new Set(['FREQ', 'BYMONTHDAY', 'COUNT', 'UNTIL']) }],
])

function rruleIssue(rule: string): string | undefined {
  const parts = new Map<string, string>()
  for (const part of rule.split(';')) {
    const [, key = '', value] = /^([A-Z]+)=([^=]+)$/.exec(part) ?? []
    if (value === undefined) return 'Expected KEY=VALUE parts separated by semicolons'
    const isValid = RRULE_PARTS.get(key)
    // Never echo the caller's text back in the message.
    if (!isValid) return 'Unsupported rule part'
    if (parts.has(key)) return `${key} appears more than once`
    if (!isValid(value)) return `${key} has an invalid value`
    parts.set(key, value)
  }
  const freq = parts.get('FREQ') ?? ''
  const shape = SHAPES.get(freq)
  if (!shape) return 'FREQ must be WEEKLY or MONTHLY'
  if (!parts.has(shape.needs)) return `FREQ=${freq} needs ${shape.needs}`
  const extra = [...parts.keys()].find((key) => !shape.allows.has(key))
  if (extra) return `${extra} can't be used with FREQ=${freq}`
  if (parts.has('COUNT') && parts.has('UNTIL')) return 'Use COUNT or UNTIL, not both'
  return undefined
}

/** An RRULE the UI builds, without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=TH`. */
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
  startsOn: scheduleDateSchema,
  endsOn: scheduleDateSchema.optional(),
  exdates: z.array(scheduleDateSchema).max(MAX_EXDATES).optional(),
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
  const untilPart = schedule.rrule.split(';').find((part) => part.startsWith('UNTIL='))
  const until = untilDate(untilPart?.slice('UNTIL='.length) ?? '')
  if (until !== undefined && compareDates(until, schedule.startsOn) < 0) {
    ctx.addIssue({ code: 'custom', message: 'UNTIL must not be before startsOn', path: ['rrule'] })
  }
}

/** `POST /schedules`, and `PATCH /schedules/{id}` with the same `id`. */
export const scheduleInputSchema = z
  .strictObject({ id: scheduleIdSchema, ...scheduleFields })
  .superRefine(checkSchedule)

export type ScheduleInput = z.infer<typeof scheduleInputSchema>

/** `POST /schedules/{id}/end` */
export const endScheduleBodySchema = z.strictObject({ endsOn: scheduleDateSchema })

export type EndScheduleBody = z.infer<typeof endScheduleBodySchema>

/** `POST /schedules/preview`: a ScheduleInput without `id`, plus how many dates to show. */
export const previewScheduleBodySchema = z
  .strictObject({ ...scheduleFields, count: z.int().min(1).max(100).optional() })
  .superRefine(checkSchedule)

export type PreviewScheduleBody = z.infer<typeof previewScheduleBodySchema>
