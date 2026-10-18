import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  endScheduleBodySchema,
  previewScheduleBodySchema,
  rruleSchema,
  scheduleInputSchema,
} from './scheduler'

const paths = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? []

const shiftSchedule = {
  id: '66f1c2a0b3d4e5f60718',
  groupId: 'acme',
  kind: 'shift',
  description: 'Thursday shift',
  template: { shift: { minutes: 300, rateCents: 2500 }, category: 'work' },
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  startsOn: '2026-10-29',
  endsOn: '2027-06-30',
  exdates: ['2026-12-24'],
  skipPublicHolidays: true,
  autoPost: true,
  horizonDays: 56,
} satisfies z.input<typeof scheduleInputSchema>

const rentSchedule = {
  id: '66f1c2a0b3d4e5f60719',
  groupId: 'house1',
  kind: 'bill',
  description: 'Rent',
  template: {
    totalCents: 240_000,
    bill: { status: 'due' },
    payers: [{ personId: 'alice', cents: 240_000 }],
    split: { mode: 'equal', personIds: ['alice', 'bob'] },
  },
  rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
  startsOn: '2026-11-01',
  skipPublicHolidays: false,
  autoPost: false,
} satisfies z.input<typeof scheduleInputSchema>

describe('scheduleInputSchema', () => {
  it.each([shiftSchedule, rentSchedule])('accepts %j', (schedule) => {
    expect(scheduleInputSchema.parse(schedule)).toEqual(schedule)
  })

  it('needs a schedule ID of exactly 20 characters', () => {
    expect(paths(scheduleInputSchema, { ...shiftSchedule, id: shiftSchedule.id.slice(1) })).toEqual(
      ['id'],
    )
    expect(paths(scheduleInputSchema, { ...shiftSchedule, id: `${shiftSchedule.id}a` })).toEqual([
      'id',
    ])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, id: '_6f1c2a0b3d4e5f60718' })).toEqual([
      'id',
    ])
  })

  it('only schedules shifts, bills, expenses and income', () => {
    expect(paths(scheduleInputSchema, { ...shiftSchedule, kind: 'payment' })).toEqual(['kind'])
  })

  it('applies the kind rules to the template', () => {
    expect(
      paths(scheduleInputSchema, { ...shiftSchedule, template: { category: 'work' } }),
    ).toEqual(['template.shift'])
    expect(
      paths(scheduleInputSchema, {
        ...rentSchedule,
        kind: 'expense',
        template: { ...rentSchedule.template, bill: undefined, split: { mode: 'days' } },
      }),
    ).toEqual(['template.split.mode'])
    expect(
      paths(scheduleInputSchema, {
        ...rentSchedule,
        kind: 'income',
        template: { totalCents: 100 },
      }),
    ).toEqual([])
  })

  it("leaves each occurrence's dueOn and billing period to the scheduler", () => {
    const template = { ...rentSchedule.template, split: { mode: 'days' } }
    expect(paths(scheduleInputSchema, { ...rentSchedule, template })).toEqual([])
  })

  it('rejects template fields that come from the schedule itself', () => {
    expect(
      paths(scheduleInputSchema, {
        ...shiftSchedule,
        template: { ...shiftSchedule.template, date: '2026-10-29' },
      }),
    ).toEqual(['template'])
  })

  it('needs endsOn on or after startsOn', () => {
    expect(paths(scheduleInputSchema, { ...shiftSchedule, endsOn: '2026-10-29' })).toEqual([])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, endsOn: '2026-10-28' })).toEqual([
      'endsOn',
    ])
  })

  it('checks dates, exdates and the horizon', () => {
    expect(paths(scheduleInputSchema, { ...shiftSchedule, startsOn: '2026-02-30' })).toEqual([
      'startsOn',
    ])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, exdates: ['24 Dec'] })).toEqual([
      'exdates.0',
    ])
    const days = Array.from({ length: 367 }, (_, index) => `2027-${index < 200 ? '01' : '02'}-01`)
    expect(paths(scheduleInputSchema, { ...shiftSchedule, exdates: days.slice(0, 366) })).toEqual(
      [],
    )
    expect(paths(scheduleInputSchema, { ...shiftSchedule, exdates: days })).toEqual(['exdates'])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, horizonDays: 7 })).toEqual([])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, horizonDays: 120 })).toEqual([])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, horizonDays: 6 })).toEqual([
      'horizonDays',
    ])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, horizonDays: 121 })).toEqual([
      'horizonDays',
    ])
  })

  it('needs both flags', () => {
    expect(paths(scheduleInputSchema, { ...shiftSchedule, autoPost: undefined })).toEqual([
      'autoPost',
    ])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, skipPublicHolidays: 'yes' })).toEqual([
      'skipPublicHolidays',
    ])
  })
})

describe('rruleSchema', () => {
  it.each([
    'FREQ=WEEKLY;BYDAY=TH',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=MONTHLY;BYMONTHDAY=1',
    'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=DAILY;COUNT=10',
    'FREQ=YEARLY;BYMONTH=7;BYMONTHDAY=1;UNTIL=20301231',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=MONTHLY;BYDAY=+2MO,TU;BYSETPOS=1;WKST=MO',
    'FREQ=YEARLY;BYYEARDAY=-366;BYWEEKNO=53;UNTIL=20301231T000000Z',
    'FREQ=YEARLY;BYMONTH=2;UNTIL=20280229',
    'BYDAY=TH;FREQ=WEEKLY',
  ])('accepts %s', (rule) => {
    expect(rruleSchema.parse(rule)).toBe(rule)
  })

  it.each([
    ['FREQ=HOURLY', 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY'],
    ['FREQ=MINUTELY;INTERVAL=5', 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY'],
    ['BYDAY=TH', 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY'],
    ['FREQ=DAILY;BYHOUR=9', 'BYHOUR is not supported'],
    ['FREQ=DAILY;BYMINUTE=0', 'BYMINUTE is not supported'],
    ['FREQ=DAILY;BYSECOND=0', 'BYSECOND is not supported'],
    ['FREQ=WEEKLY;FREQ=DAILY', 'FREQ appears more than once'],
    ['RRULE:FREQ=WEEKLY', 'Expected KEY=VALUE parts separated by semicolons'],
    ['FREQ=WEEKLY;', 'Expected KEY=VALUE parts separated by semicolons'],
    ['freq=weekly', 'Expected KEY=VALUE parts separated by semicolons'],
    ['FREQ=WEEKLY;BYDAY=', 'Expected KEY=VALUE parts separated by semicolons'],
    ['FREQ=WEEKLY;BYDAY=XX', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH,', 'BYDAY has an invalid value'],
    ['FREQ=MONTHLY;BYDAY=54MO', 'BYDAY has an invalid value'],
    ['FREQ=MONTHLY;BYDAY=0MO', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;INTERVAL=0', 'INTERVAL has an invalid value'],
    ['FREQ=WEEKLY;INTERVAL=-1', 'INTERVAL has an invalid value'],
    ['FREQ=DAILY;COUNT=ten', 'COUNT has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=32', 'BYMONTHDAY has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=0', 'BYMONTHDAY has an invalid value'],
    ['FREQ=YEARLY;BYMONTH=-1', 'BYMONTH has an invalid value'],
    ['FREQ=YEARLY;BYMONTH=13', 'BYMONTH has an invalid value'],
    ['FREQ=YEARLY;BYYEARDAY=367', 'BYYEARDAY has an invalid value'],
    ['FREQ=YEARLY;BYWEEKNO=54', 'BYWEEKNO has an invalid value'],
    ['FREQ=YEARLY;BYSETPOS=1000', 'BYSETPOS has an invalid value'],
    ['FREQ=WEEKLY;WKST=XX', 'WKST has an invalid value'],
    ['FREQ=DAILY;UNTIL=2030-12-31', 'UNTIL has an invalid value'],
    ['FREQ=DAILY;UNTIL=20261340', 'UNTIL has an invalid value'],
    ['FREQ=DAILY;UNTIL=20270229T000000Z', 'UNTIL has an invalid value'],
    ['FREQ=DAILY;COUNT=5;UNTIL=20301231', 'Use COUNT or UNTIL, not both'],
    ['', 'Expected KEY=VALUE parts separated by semicolons'],
  ])('rejects %j', (rule, message) => {
    expect(() => rruleSchema.parse(rule)).toThrow(message)
  })

  it('fits the 255-character column', () => {
    const long = `FREQ=WEEKLY;BYDAY=${'MO,'.repeat(80)}MO`
    expect(rruleSchema.safeParse(long).success).toBe(false)
  })
})

describe('endScheduleBodySchema', () => {
  it('needs an end date', () => {
    expect(paths(endScheduleBodySchema, { endsOn: '2026-12-31' })).toEqual([])
    expect(paths(endScheduleBodySchema, {})).toEqual(['endsOn'])
  })
})

describe('previewScheduleBodySchema', () => {
  const { id: _id, ...unsaved } = shiftSchedule

  it('accepts an unsaved schedule and a count', () => {
    expect(paths(previewScheduleBodySchema, unsaved)).toEqual([])
    expect(paths(previewScheduleBodySchema, { ...unsaved, count: 100 })).toEqual([])
  })

  it('rejects an id, a bad count and the same mistakes as a schedule', () => {
    expect(paths(previewScheduleBodySchema, shiftSchedule)).toEqual([''])
    expect(paths(previewScheduleBodySchema, { ...unsaved, count: 0 })).toEqual(['count'])
    expect(paths(previewScheduleBodySchema, { ...unsaved, count: 101 })).toEqual(['count'])
    expect(paths(previewScheduleBodySchema, { ...unsaved, endsOn: '2026-01-01' })).toEqual([
      'endsOn',
    ])
  })
})
