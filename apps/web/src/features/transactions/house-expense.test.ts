import type { Members } from '@ledgerly/core/generated/rows'
import { describe, expect, it } from 'vitest'
import {
  defaultTicks,
  type HouseExpenseValues,
  parsePercent,
  parseShares,
  percentText,
  previewShares,
  splitProblems,
  toHouseExpenseBody,
} from './house-expense'

const IDS = { id: 'tx1', groupId: 'house1' }

function member(personId: string, joinedOn: string, leftOn: string | null = null): Members {
  return { personId, displayName: personId, joinedOn, leftOn } as Members
}

const MEMBERS = [
  member('alice', '2026-01-01'),
  member('bob', '2026-01-01'),
  member('cara', '2026-03-01'),
  member('dan', '2026-01-01', '2026-09-30'),
]

function values(extra: Partial<HouseExpenseValues> = {}): HouseExpenseValues {
  return {
    amount: '90',
    date: '2026-10-19',
    description: 'Groceries',
    category: 'groceries',
    paidBy: 'alice',
    severalPaid: false,
    paid: {},
    splitMode: 'equal',
    splitBetween: ['alice', 'bob', 'cara'],
    parts: {},
    note: '',
    ...extra,
  }
}

describe('toHouseExpenseBody', () => {
  it('sends the documented body: one payer, an equal split, no note', () => {
    expect(toHouseExpenseBody(values(), IDS, 'AUD')).toEqual({
      id: 'tx1',
      groupId: 'house1',
      kind: 'expense',
      date: '2026-10-19',
      description: 'Groceries',
      category: 'groceries',
      totalCents: 9000,
      payers: [{ personId: 'alice', cents: 9000 }],
      split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
    })
  })

  it('sorts personIds by personId, not by the order they were ticked in', () => {
    const body = toHouseExpenseBody(
      values({ amount: '40', paidBy: 'bob', splitBetween: ['cara', 'alice'], category: '' }),
      IDS,
      'AUD',
    )
    expect(body.payers).toEqual([{ personId: 'bob', cents: 4000 }])
    expect(body.split).toEqual({ mode: 'equal', personIds: ['alice', 'cara'] })
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('note')
  })

  it('trims the description and keeps a note', () => {
    const body = toHouseExpenseBody(
      values({ description: '  Groceries ', note: ' From the market ' }),
      IDS,
      'AUD',
    )
    expect(body.description).toBe('Groceries')
    expect(body.note).toBe('From the market')
  })

  it('gives NaN for an amount that isn’t one, so the schema refuses it', () => {
    expect(toHouseExpenseBody(values({ amount: 'lots' }), IDS, 'AUD').totalCents).toBeNaN()
  })
})

describe('defaultTicks', () => {
  it('ticks those living there on the date', () => {
    expect(defaultTicks(MEMBERS, '2026-10-19')).toEqual(['alice', 'bob', 'cara'])
  })

  it('ticks someone who moved out later, but not someone not yet moved in', () => {
    expect(defaultTicks(MEMBERS, '2026-02-15')).toEqual(['alice', 'bob', 'dan'])
  })

  it('still ticks someone on the day they move out, and on the day they move in', () => {
    expect(defaultTicks(MEMBERS, '2026-09-30')).toContain('dan')
    expect(defaultTicks(MEMBERS, '2026-03-01')).toContain('cara')
    expect(defaultTicks(MEMBERS, '2026-10-01')).not.toContain('dan')
  })

  it('ticks nobody for a date that isn’t one yet', () => {
    expect(defaultTicks(MEMBERS, '')).toEqual([])
  })
})

describe('previewShares', () => {
  const house = { ownerPersonId: 'alice' }
  const preview = (extra: Partial<HouseExpenseValues>) =>
    previewShares(toHouseExpenseBody(values(extra), IDS, 'AUD'), house, MEMBERS, 'alice')

  it('works out each part as the ledger does', () => {
    expect(preview({})).toEqual({
      shares: [
        { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
        { personId: 'bob', givenCents: 0, receivedCents: 3000 },
        { personId: 'cara', givenCents: 0, receivedCents: 3000 },
      ],
    })
  })

  it('gives the leftover cent to the first personId', () => {
    const shares = preview({ amount: '100', splitBetween: ['cara', 'bob', 'alice'] })
    expect('shares' in shares && shares.shares.map((share) => share.receivedCents)).toEqual([
      3334, 3333, 3333,
    ])
  })

  it('shows a payer who isn’t in the split as having only paid', () => {
    expect(preview({ paidBy: 'dan', splitBetween: ['alice', 'bob'] })).toEqual({
      shares: [
        { personId: 'alice', givenCents: 0, receivedCents: 4500 },
        { personId: 'bob', givenCents: 0, receivedCents: 4500 },
        { personId: 'dan', givenCents: 9000, receivedCents: 0 },
      ],
    })
  })

  it('gives the ledger’s refusal in its own words', () => {
    expect(preview({ splitBetween: ['alice', 'zed'] })).toEqual({
      error: 'Only members of the group can be in a transaction',
    })
  })

  it('refuses a date that isn’t one', () => {
    expect(preview({ date: '19/10/2026' })).toEqual({ error: 'Enter a date.' })
  })

  it('passes on errors that aren’t the ledger’s', () => {
    expect(() =>
      previewShares(
        toHouseExpenseBody(values(), IDS, 'AUD'),
        house,
        null as unknown as Members[],
        'alice',
      ),
    ).toThrow(TypeError)
  })
})

describe('parsePercent', () => {
  it.each([
    ['33.33', 3333],
    ['100', 10000],
    ['5.5', 550],
    [' 0 ', 0],
    ['12.05', 1205],
  ])('reads %s as %d basis points', (text, basisPoints) => {
    expect(parsePercent(text)).toBe(basisPoints)
  })

  it.each(['33.333', '100.01', '101', '-1', '1e2', '', '33,33', '.5'])('refuses %s', (text) => {
    expect(parsePercent(text)).toBeNaN()
  })
})

describe('percentText', () => {
  it.each([
    [9999, '99.99%'],
    [10000, '100%'],
    [550, '5.5%'],
    [3333, '33.33%'],
    [5, '0.05%'],
  ])('writes %d as %s', (basisPoints, text) => {
    expect(percentText(basisPoints)).toBe(text)
  })
})

describe('parseShares', () => {
  it('reads whole numbers from 1 to MAX_WEIGHT', () => {
    expect(parseShares('2')).toBe(2)
    expect(parseShares(' 10000 ')).toBe(10000)
    for (const text of ['0', '10001', '1.5', '-1', '', 'two']) expect(parseShares(text)).toBeNaN()
  })
})

describe('toHouseExpenseBody, several payers and other splits (#181)', () => {
  const body = (extra: Partial<HouseExpenseValues>) => toHouseExpenseBody(values(extra), IDS, 'AUD')

  it('sends each payer who paid, in personId order', () => {
    expect(body({ severalPaid: true, paid: { bob: '40', alice: '50', cara: ' ' } }).payers).toEqual(
      [
        { personId: 'alice', cents: 5000 },
        { personId: 'bob', cents: 4000 },
      ],
    )
  })

  it('sends exact amounts, percentages or shares for the people ticked', () => {
    const ticked = { splitBetween: ['bob', 'alice'] }
    expect(
      body({ ...ticked, splitMode: 'exact', parts: { alice: '25', bob: '35' } }).split,
    ).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'alice', cents: 2500 },
        { personId: 'bob', cents: 3500 },
      ],
    })
    expect(
      body({ ...ticked, splitMode: 'percent', parts: { alice: '66.67', bob: '33.33', cara: '9' } })
        .split,
    ).toEqual({
      mode: 'percent',
      percents: [
        { personId: 'alice', basisPoints: 6667 },
        { personId: 'bob', basisPoints: 3333 },
      ],
    })
    expect(
      body({ ...ticked, splitMode: 'weights', parts: { alice: '2', bob: '1' } }).split,
    ).toEqual({
      mode: 'weights',
      weights: [
        { personId: 'alice', weight: 2 },
        { personId: 'bob', weight: 1 },
      ],
    })
  })
})

describe('splitProblems', () => {
  const problems = (extra: Partial<HouseExpenseValues>, total = 9000) =>
    splitProblems(values(extra), 'AUD', total)

  it('finds nothing wrong with one payer and an equal split', () => {
    expect(problems({ parts: { alice: 'junk' } })).toEqual({ paid: {}, parts: {} })
  })

  it('checks what each person paid, then that it adds up to the total', () => {
    expect(problems({ severalPaid: true, paid: {} }).paidTotal).toBe('Enter what each person paid.')
    expect(problems({ severalPaid: true, paid: { alice: 'lots', bob: '40' } })).toEqual({
      paid: { alice: 'Enter an amount like 40.50' },
      parts: {},
    })
    expect(problems({ severalPaid: true, paid: { alice: '45', bob: '40' } }).paidTotal).toMatch(
      /^The amounts paid add up to A?\$85\.00, but the total is A?\$90\.00\.$/,
    )
    expect(problems({ severalPaid: true, paid: { alice: '50', bob: '40' } })).toEqual({
      paid: {},
      parts: {},
    })
    // Without a total to compare with, only the amounts themselves are checked.
    expect(
      problems({ severalPaid: true, paid: { alice: '1' } }, Number.NaN).paidTotal,
    ).toBeUndefined()
  })

  it('needs each ticked person’s part, in its own format', () => {
    expect(
      problems({ splitBetween: ['alice', 'bob'], splitMode: 'exact', parts: { alice: 'x' } }).parts,
    ).toEqual({ alice: 'Enter an amount like 40.50', bob: 'Required' })
    expect(
      problems({ splitBetween: ['alice'], splitMode: 'percent', parts: { alice: '33.333' } }).parts,
    ).toEqual({ alice: 'Enter a percentage like 33.33' })
    expect(
      problems({ splitBetween: ['alice'], splitMode: 'weights', parts: { alice: '0' } }).parts,
    ).toEqual({ alice: 'Enter a whole number from 1 to 10000' })
  })

  it('checks amounts add up to the total, and percentages to 100%', () => {
    const two = { splitBetween: ['alice', 'bob'] }
    expect(
      problems({ ...two, splitMode: 'exact', parts: { alice: '25', bob: '30' } }, 6000).partsTotal,
    ).toMatch(/^The amounts add up to A?\$55\.00, but the total is A?\$60\.00\.$/)
    expect(
      problems({ ...two, splitMode: 'exact', parts: { alice: '25', bob: '35' } }, 6000).partsTotal,
    ).toBeUndefined()
    expect(
      problems({ ...two, splitMode: 'percent', parts: { alice: '66.66', bob: '33.33' } })
        .partsTotal,
    ).toBe('The percentages add up to 99.99%, not 100%.')
    expect(
      problems({ ...two, splitMode: 'percent', parts: { alice: '66.67', bob: '33.33' } })
        .partsTotal,
    ).toBeUndefined()
    // Shares have no total to meet.
    expect(
      problems({ ...two, splitMode: 'weights', parts: { alice: '2', bob: '1' } }).partsTotal,
    ).toBeUndefined()
  })
})
