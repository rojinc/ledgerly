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

  it("leaves each occurrence's dueOn to the scheduler", () => {
    const template = { ...rentSchedule.template, bill: { status: 'due' } }
    expect(paths(scheduleInputSchema, { ...rentSchedule, template })).toEqual([])
  })

  it('refuses a billing period, and so a days split, in a bill template', () => {
    const bill = { status: 'due', periodStart: '2026-11-01', periodEnd: '2026-11-30' }
    expect(
      paths(scheduleInputSchema, { ...rentSchedule, template: { ...rentSchedule.template, bill } }),
    ).toEqual(['template.bill.periodStart', 'template.bill.periodEnd'])
    expect(
      paths(scheduleInputSchema, {
        ...rentSchedule,
        template: { ...rentSchedule.template, bill: { status: 'due', periodEnd: '2026-11-30' } },
      }),
    ).toEqual(['template.bill.periodEnd'])
    expect(
      paths(scheduleInputSchema, {
        ...rentSchedule,
        template: { ...rentSchedule.template, split: { mode: 'days' } },
      }),
    ).toEqual(['template.split.mode'])
    expect(
      paths(scheduleInputSchema, {
        ...rentSchedule,
        template: {
          bill: { status: 'due' },
          items: [
            { name: 'Rent', amountCents: 200_000, split: { mode: 'equal', personIds: ['alice'] } },
            { name: 'Power', amountCents: 40_000, split: { mode: 'days' } },
          ],
        },
      }),
    ).toEqual(['template.items.1.split.mode'])
  })

  it('rejects template fields that come from the schedule itself', () => {
    expect(
      paths(scheduleInputSchema, {
        ...shiftSchedule,
        template: { ...shiftSchedule.template, date: '2026-10-29' },
      }),
    ).toEqual(['template'])
  })

  it('needs UNTIL on or after startsOn', () => {
    const withRule = (rrule: string) => ({ ...shiftSchedule, rrule })
    expect(paths(scheduleInputSchema, withRule('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029'))).toEqual([])
    expect(paths(scheduleInputSchema, withRule('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261028'))).toEqual([
      'rrule',
    ])
    expect(paths(scheduleInputSchema, withRule('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261340'))).toEqual([
      'rrule',
    ])
    expect(() =>
      scheduleInputSchema.parse(withRule('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261028')),
    ).toThrow('UNTIL must not be before startsOn')
    const { id: _id, ...unsaved } = withRule('FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20260101')
    expect(paths(previewScheduleBodySchema, unsaved)).toEqual(['rrule'])
  })

  it('needs endsOn on or after startsOn', () => {
    expect(paths(scheduleInputSchema, { ...shiftSchedule, endsOn: '2026-10-29' })).toEqual([])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, endsOn: '2026-10-28' })).toEqual([
      'endsOn',
    ])
  })

  it('starts, ends and skips no earlier than 2000-01-01', () => {
    const early = '1999-12-31'
    expect(paths(scheduleInputSchema, { ...shiftSchedule, startsOn: '2000-01-01' })).toEqual([])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, startsOn: '0001-01-01' })).toEqual([
      'startsOn',
    ])
    expect(
      paths(scheduleInputSchema, { ...shiftSchedule, startsOn: early, endsOn: early }),
    ).toEqual(['startsOn', 'endsOn'])
    expect(paths(scheduleInputSchema, { ...shiftSchedule, exdates: [early] })).toEqual([
      'exdates.0',
    ])
    expect(() => scheduleInputSchema.parse({ ...shiftSchedule, startsOn: early })).toThrow(
      'Must be on or after 2000-01-01',
    )
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
  // scheduling.md#rules-the-ui-builds, plus the optional parts the API allows.
  it.each([
    'FREQ=WEEKLY;BYDAY=TH',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=MONTHLY;BYMONTHDAY=1',
    'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=MONTHLY;BYMONTHDAY=28',
    'BYDAY=TH;FREQ=WEEKLY',
    'FREQ=WEEKLY;BYDAY=SU;INTERVAL=4;COUNT=500',
    'FREQ=WEEKLY;BYDAY=SA,SU;INTERVAL=1;UNTIL=20280229',
    'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=1',
    'UNTIL=20301231;BYMONTHDAY=-1;FREQ=MONTHLY',
  ])('accepts %s', (rule) => {
    expect(rruleSchema.parse(rule)).toBe(rule)
  })

  // The #85 review: each of these passed before and took 1–19 s to expand.
  it.each([
    ['FREQ=DAILY;BYWEEKNO=1;BYMONTH=6', 'Unsupported rule part'],
    ['FREQ=DAILY;BYSETPOS=2', 'Unsupported rule part'],
    ['FREQ=DAILY;BYMONTH=4;BYMONTHDAY=31', 'Unsupported rule part'],
    ['FREQ=DAILY', 'FREQ must be WEEKLY or MONTHLY'],
  ])('rejects the slow rule %s', (rule, message) => {
    expect(() => rruleSchema.parse(rule)).toThrow(message)
  })

  it.each([
    ['FREQ=YEARLY;BYMONTHDAY=1', 'FREQ must be WEEKLY or MONTHLY'],
    ['FREQ=HOURLY;BYDAY=MO', 'FREQ must be WEEKLY or MONTHLY'],
    ['BYDAY=TH', 'FREQ must be WEEKLY or MONTHLY'],
    ['FREQ=WEEKLY', 'FREQ=WEEKLY needs BYDAY'],
    ['FREQ=MONTHLY;COUNT=3', 'FREQ=MONTHLY needs BYMONTHDAY'],
    ['FREQ=WEEKLY;BYDAY=TH;BYMONTHDAY=1', "BYMONTHDAY can't be used with FREQ=WEEKLY"],
    ['FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=MO', "BYDAY can't be used with FREQ=MONTHLY"],
    ['FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=2', "INTERVAL can't be used with FREQ=MONTHLY"],
    ['FREQ=WEEKLY;BYDAY=TH;WKST=MO', 'Unsupported rule part'],
    ['FREQ=DAILY;BYHOUR=9', 'Unsupported rule part'],
    ['FREQ=WEEKLY;BYDAY=TH;FREQ=WEEKLY', 'FREQ appears more than once'],
    ['FREQ=WEEKLY;BYDAY=-1FR', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=2MO', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=XX', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=MO,MO', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH,', 'BYDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;INTERVAL=0', 'INTERVAL has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;INTERVAL=5', 'INTERVAL has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=29', 'BYMONTHDAY has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=31', 'BYMONTHDAY has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=0', 'BYMONTHDAY has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=-2', 'BYMONTHDAY has an invalid value'],
    ['FREQ=MONTHLY;BYMONTHDAY=1,15', 'BYMONTHDAY has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;COUNT=0', 'COUNT has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;COUNT=501', 'COUNT has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;COUNT=ten', 'COUNT has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;UNTIL=20261340', 'UNTIL has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;UNTIL=20270229', 'UNTIL has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;UNTIL=2030-12-31', 'UNTIL has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;UNTIL=20301231T000000Z', 'UNTIL has an invalid value'],
    ['FREQ=WEEKLY;BYDAY=TH;COUNT=5;UNTIL=20301231', 'Use COUNT or UNTIL, not both'],
    ['RRULE:FREQ=WEEKLY;BYDAY=TH', 'Expected KEY=VALUE parts separated by semicolons'],
    ['FREQ=WEEKLY;BYDAY=TH;', 'Expected KEY=VALUE parts separated by semicolons'],
    ['freq=weekly;byday=th', 'Expected KEY=VALUE parts separated by semicolons'],
    ['FREQ=WEEKLY;BYDAY=', 'Expected KEY=VALUE parts separated by semicolons'],
    ['', 'Expected KEY=VALUE parts separated by semicolons'],
  ])('rejects %j', (rule, message) => {
    expect(() => rruleSchema.parse(rule)).toThrow(message)
  })

  it('never repeats an unknown part in its message', () => {
    const result = rruleSchema.safeParse('FREQ=WEEKLY;BYDAY=TH;SECRETPART=1')
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['Unsupported rule part'])
  })

  it('fits the 255-character column', () => {
    const long = `FREQ=WEEKLY;BYDAY=MO;${'X'.repeat(250)}`
    expect(rruleSchema.safeParse(long).success).toBe(false)
  })
})

describe('endScheduleBodySchema', () => {
  it('needs an end date', () => {
    expect(paths(endScheduleBodySchema, { endsOn: '2026-12-31' })).toEqual([])
    expect(paths(endScheduleBodySchema, {})).toEqual(['endsOn'])
    expect(paths(endScheduleBodySchema, { endsOn: '1999-12-31' })).toEqual(['endsOn'])
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
