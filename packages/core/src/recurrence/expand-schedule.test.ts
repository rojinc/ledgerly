import { describe, expect, it } from 'vitest'
import { parseLocalDate } from '../dates/local-date'
import { expandSchedule, occurrenceId, type ScheduleDates } from './expand-schedule'
import { publicHolidayChecker } from './public-holidays'

const d = parseLocalDate
const never = () => false
const schedule = (rrule: string, fields: Partial<ScheduleDates> = {}): ScheduleDates => ({
  rrule,
  startsOn: d('2026-09-01'),
  skipPublicHolidays: false,
  ...fields,
})
const october = [d('2026-10-01'), d('2026-10-31')] as const

describe('expandSchedule', () => {
  it('gives every Thursday in October 2026', () => {
    expect(expandSchedule(schedule('FREQ=WEEKLY;BYDAY=TH'), ...october, never)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
      '2026-10-22',
      '2026-10-29',
    ])
  })

  it('counts a fortnightly schedule from startsOn', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'
    const window = [d('2026-10-01'), d('2026-11-30')] as const
    expect(expandSchedule(schedule(rule, { startsOn: d('2026-10-05') }), ...window, never)).toEqual(
      ['2026-10-05', '2026-10-19', '2026-11-02', '2026-11-16', '2026-11-30'],
    )
    expect(expandSchedule(schedule(rule, { startsOn: d('2026-10-12') }), ...window, never)).toEqual(
      ['2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23'],
    )
  })

  it('takes BYMONTHDAY=-1 as the last day of each month, across February', () => {
    const rule = schedule('FREQ=MONTHLY;BYMONTHDAY=-1', { startsOn: d('2026-01-01') })
    expect(expandSchedule(rule, d('2026-01-01'), d('2026-04-30'), never)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    expect(expandSchedule(rule, d('2028-02-01'), d('2028-02-29'), never)).toEqual(['2028-02-29'])
  })

  it('skips NSW Labour Day on a Monday schedule only when asked to', () => {
    const mondays = (skipPublicHolidays: boolean) =>
      expandSchedule(
        schedule('FREQ=WEEKLY;BYDAY=MO', { skipPublicHolidays }),
        ...october,
        publicHolidayChecker('AU-NSW'),
      )
    expect(mondays(true)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26'])
    expect(mondays(false)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
  })

  it('leaves out exdates, and dates before startsOn or after endsOn', () => {
    const thursdays = 'FREQ=WEEKLY;BYDAY=TH'
    expect(
      expandSchedule(schedule(thursdays, { exdates: [d('2026-10-15')] }), ...october, never),
    ).toEqual(['2026-10-01', '2026-10-08', '2026-10-22', '2026-10-29'])
    expect(
      expandSchedule(schedule(thursdays, { endsOn: d('2026-10-20') }), ...october, never),
    ).toEqual(['2026-10-01', '2026-10-08', '2026-10-15'])
    expect(
      expandSchedule(schedule(thursdays, { startsOn: d('2026-10-10') }), ...october, never),
    ).toEqual(['2026-10-15', '2026-10-22', '2026-10-29'])
    expect(
      expandSchedule(schedule(thursdays, { endsOn: d('2026-09-30') }), ...october, never),
    ).toEqual([])
  })

  it('starts a fortnightly rule in the week of startsOn, even mid-week', () => {
    // Every other Tuesday from Wednesday 7 Oct: that week's Tuesday has passed,
    // so the first one is two weeks on.
    const rule = schedule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', {
      startsOn: d('2026-10-07'),
      exdates: null,
    })
    expect(expandSchedule(rule, ...october, never)).toEqual(['2026-10-20'])
  })

  it('follows COUNT and UNTIL, counted from startsOn', () => {
    const start = { startsOn: d('2026-10-01') }
    expect(
      expandSchedule(schedule('FREQ=WEEKLY;BYDAY=TH;COUNT=3', start), ...october, never),
    ).toEqual(['2026-10-01', '2026-10-08', '2026-10-15'])
    expect(expandSchedule(schedule('FREQ=DAILY;UNTIL=20261003', start), ...october, never)).toEqual(
      ['2026-10-01', '2026-10-02', '2026-10-03'],
    )
  })

  it('gives nothing for a rule that never matches in the window', () => {
    const feb30 = schedule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', { startsOn: d('2026-01-01') })
    expect(expandSchedule(feb30, d('2026-01-01'), d('2030-12-31'), never)).toEqual([])
  })
})

describe('occurrenceId', () => {
  it('is the schedule ID, an underscore and the date without dashes', () => {
    expect(occurrenceId('66f1c2a0b1c2d3e4f5a6', d('2026-10-29'))).toBe(
      '66f1c2a0b1c2d3e4f5a6_20261029',
    )
  })
})
