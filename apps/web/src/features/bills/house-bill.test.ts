import type { Members } from '@ledgerly/core/generated/rows'
import { describe, expect, it } from 'vitest'
import {
  type HouseBillValues,
  NOBODY_PRESENT,
  newHouseBillValues,
  previewHouseBill,
  toHouseBillBody,
  toHouseBillValues,
} from './house-bill'

const HOUSE = {
  ownerPersonId: 'alice',
  settingsJson: JSON.stringify({ type: 'house', autoFinalize: false, defaultBillSplit: 'days' }),
}
const EQUAL_HOUSE = {
  ...HOUSE,
  settingsJson: JSON.stringify({ type: 'house', autoFinalize: false, defaultBillSplit: 'equal' }),
}

function member(personId: string, joinedOn: string, leftOn: string | null = null) {
  return { personId, displayName: personId, joinedOn, leftOn } as Members
}

// User flow 6: Cara moved in on 1 August.
const MEMBERS = [
  member('alice', '2026-01-01'),
  member('bob', '2026-01-01'),
  member('cara', '2026-08-01'),
]

// Flow 6 step 2: $270 for 1 Jul–30 Sep, due 15 Oct, not paid yet.
const FLOW_6: HouseBillValues = {
  ...newHouseBillValues('2026-10-01', 'alice', 'days'),
  description: 'Electricity',
  category: 'electricity',
  amount: '270',
  periodStart: '2026-07-01',
  periodEnd: '2026-09-30',
  dueOn: '2026-10-15',
}
const IDS = { id: 'b1', groupId: 'house1' }

function preview(values: Partial<HouseBillValues>, house = HOUSE, members = MEMBERS) {
  const body = toHouseBillBody({ ...FLOW_6, ...values }, IDS, 'AUD')
  return previewHouseBill(body, house, members, 'alice')
}

describe('toHouseBillBody', () => {
  it('sends flow 6’s due bill exactly', () => {
    expect(toHouseBillBody(FLOW_6, IDS, 'AUD')).toEqual({
      id: 'b1',
      groupId: 'house1',
      kind: 'bill',
      date: '2026-10-15',
      description: 'Electricity',
      category: 'electricity',
      totalCents: 27000,
      split: { mode: 'days' },
      bill: {
        status: 'due',
        dueOn: '2026-10-15',
        periodStart: '2026-07-01',
        periodEnd: '2026-09-30',
      },
    })
  })

  it('sends a paid bill on its paid date, paid by whoever paid it', () => {
    const body = toHouseBillBody(
      { ...FLOW_6, paid: true, paidOn: '2026-10-10', paidBy: 'bob' },
      IDS,
      'AUD',
    )
    expect(body).toMatchObject({
      date: '2026-10-10',
      bill: { status: 'paid', periodStart: '2026-07-01', periodEnd: '2026-09-30' },
      payers: [{ personId: 'bob', cents: 27000 }],
    })
    expect(body.bill).not.toHaveProperty('dueOn')
  })

  it('names some people by days present, sorted by person ID', () => {
    const body = toHouseBillBody(
      { ...FLOW_6, split: 'someDays', splitPeople: ['cara', 'alice', 'cara'] },
      IDS,
      'AUD',
    )
    expect(body.split).toEqual({ mode: 'days', personIds: ['alice', 'cara'] })
  })

  it('names no split for everyone present equally, so the ledger’s default applies', () => {
    expect(toHouseBillBody({ ...FLOW_6, split: 'equal' }, IDS, 'AUD')).not.toHaveProperty('split')
  })

  it('keeps the stored payer and note on an edit, paying the new amount', () => {
    const payers = [{ personId: 'bob', cents: 27000 }]
    const body = toHouseBillBody({ ...FLOW_6, amount: '280' }, IDS, 'AUD', {
      payers,
      note: 'Meter read',
    })
    expect(body).toMatchObject({
      totalCents: 28000,
      payers: [{ personId: 'bob', cents: 28000 }],
      note: 'Meter read',
    })
  })

  it('sends several stored payers as they are', () => {
    const payers = [
      { personId: 'alice', cents: 20000 },
      { personId: 'bob', cents: 7000 },
    ]
    expect(toHouseBillBody(FLOW_6, IDS, 'AUD', { payers }).payers).toEqual(payers)
  })

  it('sends back a stored split the form can’t show', () => {
    const split = {
      mode: 'exact' as const,
      amounts: [
        { personId: 'alice', cents: 20000 },
        { personId: 'bob', cents: 7000 },
      ],
    }
    const body = toHouseBillBody({ ...FLOW_6, split: 'kept' }, IDS, 'AUD', { split })
    expect(body.split).toEqual(split)
  })

  it('leaves out an empty category, and turns an amount that isn’t one into NaN', () => {
    const body = toHouseBillBody({ ...FLOW_6, category: '', amount: 'lots' }, IDS, 'AUD')
    expect(body).not.toHaveProperty('category')
    expect(body.totalCents).toBeNaN()
  })
})

describe('previewHouseBill', () => {
  it('gives flow 6’s days and parts: Cara pays for 61 of the 92 days', () => {
    expect(preview({})).toEqual({
      lines: [
        { personId: 'alice', days: 92, shareCents: 10139 },
        { personId: 'bob', days: 92, shareCents: 10139 },
        { personId: 'cara', days: 61, shareCents: 6722 },
      ],
    })
  })

  it('splits by days among the people named, and only them', () => {
    expect(preview({ split: 'someDays', splitPeople: ['alice', 'cara'] })).toEqual({
      lines: [
        // 27000 × 92/153 = 16235.29 and × 61/153 = 10764.70: the leftover cent goes to Cara.
        { personId: 'alice', days: 92, shareCents: 16235 },
        { personId: 'cara', days: 61, shareCents: 10765 },
      ],
    })
  })

  it('splits equally between everyone present in an equal-default house', () => {
    expect(preview({ split: 'equal' }, EQUAL_HOUSE)).toEqual({
      lines: [
        { personId: 'alice', days: 92, shareCents: 9000 },
        { personId: 'bob', days: 92, shareCents: 9000 },
        { personId: 'cara', days: 61, shareCents: 9000 },
      ],
    })
  })

  it('shows someone who wasn’t there with 0 days and no part', () => {
    const members = [...MEMBERS, member('dan', '2026-01-01', '2026-06-30')]
    const result = preview({}, HOUSE, members)
    expect(result && 'lines' in result && result.lines.at(-1)).toEqual({
      personId: 'dan',
      days: 0,
      shareCents: 0,
    })
  })

  it('waits for the amount and both period dates', () => {
    expect(preview({ amount: '' })).toBeUndefined()
    expect(preview({ amount: '0' })).toBeUndefined()
    expect(preview({ periodStart: '' })).toBeUndefined()
    expect(preview({ periodEnd: '2026-02-30' })).toBeUndefined()
  })

  it.each<[string, Partial<HouseBillValues>, Members[], string]>([
    [
      'a period that ends before it starts',
      { periodStart: '2026-09-30', periodEnd: '2026-07-01' },
      MEMBERS,
      'The period can’t end before it starts.',
    ],
    [
      'a period of 10,000 days or more',
      { periodStart: '2000-01-01', periodEnd: '2027-05-19' },
      MEMBERS,
      'A bill’s period can be at most 10000 days.',
    ],
    [
      'nobody there',
      { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
      MEMBERS,
      NOBODY_PRESENT,
    ],
    [
      'nobody ticked',
      { split: 'someDays', splitPeople: [] },
      MEMBERS,
      'Tick at least one person to split it between.',
    ],
    [
      'more than 15 people',
      {},
      Array.from({ length: 16 }, (_, i) => member(`p${String(i).padStart(2, '0')}`, '2026-01-01')),
      'At most 15 people can be in one bill.',
    ],
  ])('refuses %s', (_name, values, members, error) => {
    expect(preview(values, HOUSE, members)).toEqual({ error })
  })

  it('refuses a new amount several stored payers no longer add up to', () => {
    const payers = [
      { personId: 'alice', cents: 20000 },
      { personId: 'bob', cents: 7000 },
    ]
    const body = (amount: string) => toHouseBillBody({ ...FLOW_6, amount }, IDS, 'AUD', { payers })
    expect(previewHouseBill(body('270'), HOUSE, MEMBERS, 'alice')).toHaveProperty('lines')
    expect(previewHouseBill(body('280'), HOUSE, MEMBERS, 'alice')).toEqual({
      error:
        'Several people paid this bill, so its amount can’t change here. Skip it and add it again.',
    })
  })

  it('previews a stored exact split as stored', () => {
    const split = {
      mode: 'exact' as const,
      amounts: [
        { personId: 'alice', cents: 20000 },
        { personId: 'bob', cents: 7000 },
      ],
    }
    const body = toHouseBillBody({ ...FLOW_6, split: 'kept' }, IDS, 'AUD', { split })
    expect(previewHouseBill(body, HOUSE, MEMBERS, 'alice')).toEqual({
      lines: [
        { personId: 'alice', days: 92, shareCents: 20000 },
        { personId: 'bob', days: 92, shareCents: 7000 },
        { personId: 'cara', days: 61, shareCents: 0 },
      ],
    })
  })

  it('counts a payer who wasn’t there among the 15 people', () => {
    const members = [
      ...Array.from({ length: 15 }, (_, i) =>
        member(`p${String(i).padStart(2, '0')}`, '2026-01-01'),
      ),
      member('zed', '2025-01-01', '2025-12-31'),
    ]
    const paidByZed = { paid: true, paidOn: '2026-10-10', paidBy: 'zed' }
    expect(preview(paidByZed, HOUSE, members)).toEqual({
      error: 'At most 15 people can be in one bill.',
    })
    expect(preview(paidByZed, HOUSE, members.slice(1))).toHaveProperty('lines')
  })
})

describe('toHouseBillValues', () => {
  const row = {
    description: 'Electricity',
    date: '2026-10-15',
    dueOn: '2026-10-15',
    category: 'electricity',
  }
  const period = { periodStart: '2026-07-01', periodEnd: '2026-09-30' }

  it('round-trips a stored due bill into the same body', () => {
    const kept = { split: { mode: 'days' as const, personIds: ['alice', 'cara'] }, period }
    const values = toHouseBillValues(row, '270.00', kept, 'alice', 'days')
    expect(values).toMatchObject({ split: 'someDays', splitPeople: ['alice', 'cara'], ...period })
    expect(toHouseBillBody(values, IDS, 'AUD', kept)).toEqual({
      ...toHouseBillBody(FLOW_6, IDS, 'AUD'),
      split: { mode: 'days', personIds: ['alice', 'cara'] },
    })
  })

  it('keeps a stored split the form can’t show', () => {
    const exact = {
      split: { mode: 'exact' as const, amounts: [{ personId: 'alice', cents: 27000 }] },
      period,
    }
    expect(toHouseBillValues(row, '270.00', exact, 'alice', 'days').split).toBe('kept')
  })

  it('opens a bill with no stored split on the house’s default', () => {
    expect(toHouseBillValues(row, '270.00', { period }, 'alice', 'equal').split).toBe('equal')
    expect(toHouseBillValues(row, '270.00', { period }, 'alice', 'days').split).toBe('days')
    const everyone = { split: { mode: 'days' as const }, period }
    expect(toHouseBillValues(row, '270.00', everyone, 'alice', 'equal').split).toBe('days')
  })

  it('drops a category the app doesn’t know', () => {
    const values = toHouseBillValues({ ...row, category: 'rockets' }, '1', {}, 'alice', 'days')
    expect(values.category).toBe('')
  })
})
