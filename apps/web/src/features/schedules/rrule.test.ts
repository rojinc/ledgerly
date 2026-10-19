import { rruleSchema } from '@ledgerly/core/schemas/scheduler'
import { describe, expect, it } from 'vitest'
import { describeRepeat, fromRrule, type Repeat, toRrule } from './rrule'

const WEEKLY: Repeat = {
  pattern: 'weekly',
  days: ['TH'],
  interval: 1,
  monthDay: 1,
  end: 'never',
  count: '',
  until: '',
}

describe('toRrule', () => {
  // scheduling.md#rules-the-ui-builds, row by row.
  it.each([
    ['Every Thursday', WEEKLY, 'FREQ=WEEKLY;BYDAY=TH'],
    [
      'Every other Tuesday',
      { ...WEEKLY, days: ['TU'], interval: 2 },
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
    ],
    [
      'Mon, Wed and Fri, picked in any order',
      { ...WEEKLY, days: ['FR', 'MO', 'WE'] },
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    ],
    ['On the 1st of every month', { ...WEEKLY, pattern: 'monthly' }, 'FREQ=MONTHLY;BYMONTHDAY=1'],
    [
      'On the last day of every month',
      { ...WEEKLY, pattern: 'monthly', monthDay: -1 },
      'FREQ=MONTHLY;BYMONTHDAY=-1',
    ],
    [
      'Ending after 10 dates',
      { ...WEEKLY, end: 'count', count: ' 10 ' },
      'FREQ=WEEKLY;BYDAY=TH;COUNT=10',
    ],
    [
      'Ending on a date',
      { ...WEEKLY, end: 'until', until: '2026-12-24' },
      'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261224',
    ],
  ] as [string, Repeat, string][])('%s', (_, repeat, rule) => {
    expect(toRrule(repeat)).toBe(rule)
    expect(rruleSchema.safeParse(rule).success).toBe(true)
    // Read back, it builds the same rule: an existing schedule opens as it was saved.
    const read = fromRrule(rule)
    expect(read && toRrule(read)).toBe(rule)
  })

  it('builds rules the API refuses when the form is incomplete, so the schema says so', () => {
    expect(rruleSchema.safeParse(toRrule({ ...WEEKLY, days: [] })).success).toBe(false)
    expect(rruleSchema.safeParse(toRrule({ ...WEEKLY, end: 'count', count: '0' })).success).toBe(
      false,
    )
  })
})

describe('fromRrule', () => {
  it('reads the parts in any order, and refuses shapes the form never builds', () => {
    expect(fromRrule('BYDAY=MO,FR;FREQ=WEEKLY;INTERVAL=3')).toMatchObject({
      pattern: 'weekly',
      days: ['MO', 'FR'],
      interval: 3,
    })
    expect(fromRrule('FREQ=DAILY')).toBeUndefined()
    expect(fromRrule('FREQ=WEEKLY;BYDAY=-1FR')).toBeUndefined()
    expect(fromRrule('FREQ=WEEKLY;BYDAY=TH;INTERVAL=9')).toBeUndefined()
    expect(fromRrule('FREQ=MONTHLY;BYMONTHDAY=31')).toBeUndefined()
  })
})

describe('describeRepeat', () => {
  const words = (date: string) => `[${date}]`

  it('says it in words', () => {
    expect(describeRepeat(WEEKLY, words)).toBe('Every Thursday')
    expect(describeRepeat({ ...WEEKLY, days: ['WE', 'MO'], interval: 2 }, words)).toBe(
      'Every 2 weeks on Mon, Wed',
    )
    expect(describeRepeat({ ...WEEKLY, pattern: 'monthly', monthDay: -1 }, words)).toBe(
      'Last day of each month',
    )
    expect(describeRepeat({ ...WEEKLY, pattern: 'monthly', monthDay: 15 }, words)).toBe(
      'On day 15 of each month',
    )
  })

  it('says the rule’s own end: a number of shifts or a last date', () => {
    expect(describeRepeat({ ...WEEKLY, end: 'count', count: '10' }, words)).toBe(
      'Every Thursday, 10 shifts',
    )
    expect(describeRepeat({ ...WEEKLY, end: 'count', count: '1' }, words)).toBe(
      'Every Thursday, 1 shift',
    )
    expect(describeRepeat({ ...WEEKLY, end: 'until', until: '2026-12-24' }, words)).toBe(
      'Every Thursday, until [2026-12-24]',
    )
  })
})
