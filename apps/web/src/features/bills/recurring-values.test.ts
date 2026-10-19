import { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { describe, expect, it } from 'vitest'
import { hasEnded, type RecurringValues, templateCents, toRecurringInput } from './recurring-values'

const RENT: RecurringValues = {
  description: ' Rent ',
  category: 'rent',
  amount: '400',
  repeat: 'weekly',
  weekday: 'MO',
  monthDay: '',
  startsOn: '2026-10-19',
  until: '',
  autopay: false,
}

const IDS = { id: 'abcdefghij0123456789', groupId: 'g1' }

describe('toRecurringInput', () => {
  it('sends rent weekly on Monday as a bill schedule (user flow 10)', () => {
    const input = toRecurringInput(RENT, IDS, 'AUD')
    expect(input).toStrictEqual({
      id: 'abcdefghij0123456789',
      groupId: 'g1',
      kind: 'bill',
      description: 'Rent',
      template: { totalCents: 40000, category: 'rent', bill: { status: 'due' } },
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      startsOn: '2026-10-19',
      skipPublicHolidays: false,
      autoPost: false,
    })
    expect(scheduleInputSchema.safeParse(input).success).toBe(true)
  })

  it('builds monthly on a day, the last day, an end date and autopay', () => {
    const monthly = toRecurringInput(
      { ...RENT, repeat: 'monthly', monthDay: ' 15 ', until: '2027-06-30', autopay: true },
      IDS,
      'AUD',
    )
    expect(monthly).toMatchObject({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20270630',
      autoPost: true,
    })
    expect(scheduleInputSchema.safeParse(monthly).success).toBe(true)
    const last = toRecurringInput({ ...RENT, repeat: 'last', monthDay: '9' }, IDS, 'AUD')
    expect(last.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=-1')
    expect(scheduleInputSchema.safeParse(last).success).toBe(true)
  })

  it('gives values the schema refuses for a missing day, a day past 28, or a bad amount', () => {
    const refused = (values: Partial<RecurringValues>) =>
      scheduleInputSchema.safeParse(toRecurringInput({ ...RENT, ...values }, IDS, 'AUD')).success
    expect(refused({ repeat: 'monthly', monthDay: '' })).toBe(false)
    expect(refused({ repeat: 'monthly', monthDay: '29' })).toBe(false)
    expect(refused({ amount: 'lots' })).toBe(false)
    expect('category' in toRecurringInput({ ...RENT, category: '' }, IDS, 'AUD').template).toBe(
      false,
    )
  })
})

describe('templateCents', () => {
  it('reads the amount from the template, or nothing it can’t read', () => {
    expect(templateCents({ templateJson: '{"totalCents":40000}' })).toBe(40000)
    expect(templateCents({ templateJson: '{}' })).toBeUndefined()
    expect(templateCents({ templateJson: 'nope' })).toBeUndefined()
  })
})

describe('hasEnded', () => {
  it('has ended once its end date or UNTIL is before today', () => {
    expect(hasEnded({ endsOn: '2026-10-18', rrule: 'FREQ=WEEKLY;BYDAY=MO' }, '2026-10-19')).toBe(
      true,
    )
    expect(hasEnded({ endsOn: '2026-10-19', rrule: 'FREQ=WEEKLY;BYDAY=MO' }, '2026-10-19')).toBe(
      false,
    )
    expect(
      hasEnded({ endsOn: null, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20261001' }, '2026-10-19'),
    ).toBe(true)
    expect(hasEnded({ endsOn: null, rrule: 'FREQ=WEEKLY;BYDAY=MO' }, '2026-10-19')).toBe(false)
  })
})
