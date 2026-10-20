import { describe, expect, it } from 'vitest'
import { scheduleEnd } from './schedule-end'

describe('scheduleEnd', () => {
  it.each([
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH', endsOn: null }, null],
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH', endsOn: '2026-11-05' }, '2026-11-05'],
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029', endsOn: null }, '2026-10-29'],
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029', endsOn: '2026-10-20' }, '2026-10-20'],
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029', endsOn: '2026-12-31' }, '2026-10-29'],
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=2', endsOn: '2026-12-31' }, '2026-10-08'],
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=2', endsOn: '2026-10-02' }, '2026-10-02'],
    [{ rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2', endsOn: null }, '2026-11-30'],
    // A count that runs past a year: the 24th first-of-the-month (AI A's N1 on #441).
    [{ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;COUNT=24', endsOn: null }, '2028-09-01'],
    // Every other week from the week of 1 October: 13 and 27 October.
    [{ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=2', endsOn: null }, '2026-10-27'],
    // A count of dates that never come (30 February) ends where it starts.
    [{ rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=1', endsOn: null }, '2026-10-01'],
    // A pause ends it the day before, unless something else ends it first (#430).
    [{ rrule: 'FREQ=WEEKLY;BYDAY=TH', endsOn: null, pausedFrom: '2026-11-01' }, '2026-10-31'],
    [
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', endsOn: '2026-10-20', pausedFrom: '2026-11-01' },
      '2026-10-20',
    ],
    [
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', endsOn: '2026-12-31', pausedFrom: '2026-11-01' },
      '2026-10-31',
    ],
    [
      { rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=2', endsOn: null, pausedFrom: '2026-11-01' },
      '2026-10-08',
    ],
    [
      { rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231', endsOn: null, pausedFrom: '2026-10-08' },
      '2026-10-07',
    ],
  ])('scheduleEnd(%o) is %s', (rule, end) => {
    expect(scheduleEnd({ pausedFrom: null, ...rule, startsOn: '2026-10-01' })).toBe(end)
  })
})
