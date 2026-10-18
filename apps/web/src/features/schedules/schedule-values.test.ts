import type { Schedules } from '@ledgerly/core/generated/rows'
import { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { describe, expect, it } from 'vitest'
import {
  fromSchedule,
  hoursText,
  parseHours,
  type ScheduleValues,
  toScheduleInput,
} from './schedule-values'

const IDS = { id: 'abcdefghij0123456789', groupId: 'g1' }

// The issue's example: every Thursday, 5 hours at $25.
const THURSDAYS: ScheduleValues = {
  pattern: 'weekly',
  days: ['TH'],
  interval: 1,
  monthDay: 1,
  end: 'never',
  count: '',
  until: '',
  description: ' Thursday shift ',
  hours: '5',
  rate: '25',
  startsOn: '2026-10-22',
  skipPublicHolidays: true,
  autoPost: false,
}

describe('toScheduleInput', () => {
  it('builds every Thursday 5h at $25 as the API takes it', () => {
    const input = toScheduleInput(THURSDAYS, IDS, 'AUD')
    expect(input).toEqual({
      ...IDS,
      kind: 'shift',
      description: 'Thursday shift',
      template: { shift: { minutes: 300, rateCents: 2500 } },
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      startsOn: '2026-10-22',
      skipPublicHolidays: true,
      autoPost: false,
    })
    expect(scheduleInputSchema.safeParse(input).success).toBe(true)
  })

  it('keeps what the form doesn’t show, such as an end date and skipped days', () => {
    const input = toScheduleInput(THURSDAYS, IDS, 'AUD', {
      endsOn: '2026-12-31',
      exdates: ['2026-11-05'],
    })
    expect(input).toMatchObject({ endsOn: '2026-12-31', exdates: ['2026-11-05'] })
  })

  it('sends NaN for hours or a rate that aren’t numbers, so the schema refuses them', () => {
    const input = toScheduleInput({ ...THURSDAYS, hours: 'five', rate: '25.555' }, IDS, 'AUD')
    expect(input.template.shift?.minutes).toBeNaN()
    expect(input.template.shift?.rateCents).toBeNaN()
    expect(scheduleInputSchema.safeParse(input).success).toBe(false)
  })
})

describe('hours', () => {
  it('reads 7, 7.5, 7.25 and 7:30, and writes them back', () => {
    expect(parseHours('7')).toBe(420)
    expect(parseHours(' 7.5 ')).toBe(450)
    expect(parseHours('7.25')).toBe(435)
    expect(parseHours('7:30')).toBe(450)
    expect(parseHours('7:60')).toBeNaN()
    expect(parseHours('-1')).toBeNaN()
    expect(hoursText(450)).toBe('7:30')
    expect(hoursText(300)).toBe('5')
  })
})

describe('fromSchedule', () => {
  const stored = {
    $id: IDS.id,
    groupId: 'g1',
    kind: 'shift',
    description: 'Thursday shift',
    templateJson: JSON.stringify({ shift: { minutes: 300, rateCents: 2550 } }),
    rrule: 'FREQ=WEEKLY;BYDAY=TH',
    startsOn: '2026-10-22',
    endsOn: null,
    exdates: null,
    skipPublicHolidays: true,
    autoPost: false,
  } as Schedules

  it('opens a stored shift schedule as it was saved', () => {
    const values = fromSchedule(stored, 'AUD')
    expect(values).toEqual({
      ...THURSDAYS,
      description: 'Thursday shift',
      rate: '25.50',
    })
    expect(toScheduleInput(values as ScheduleValues, IDS, 'AUD').template).toEqual({
      shift: { minutes: 300, rateCents: 2550 },
    })
  })

  it('can’t show a rule it never builds, or a template that isn’t a shift', () => {
    expect(fromSchedule({ ...stored, rrule: 'FREQ=DAILY' }, 'AUD')).toBeUndefined()
    expect(fromSchedule({ ...stored, templateJson: '{}' }, 'AUD')).toBeUndefined()
    expect(fromSchedule({ ...stored, templateJson: 'nope' }, 'AUD')).toBeUndefined()
  })
})
