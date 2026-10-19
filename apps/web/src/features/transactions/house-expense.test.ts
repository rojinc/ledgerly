import type { Members } from '@ledgerly/core/generated/rows'
import { buildShares } from '@ledgerly/core/ledger/build-shares'
import { assertShareInvariants } from '@ledgerly/core/ledger/invariants'
import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { describe, expect, it } from 'vitest'
import {
  defaultTicks,
  type HouseExpenseValues,
  type ItemValues,
  itemCents,
  itemProblems,
  NEW_ITEM,
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
    itemised: false,
    items: [],
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

  it('refuses amounts below zero, and a payer of 0', () => {
    expect(problems({ severalPaid: true, paid: { alice: '100', bob: '-10' } })).toEqual({
      paid: { bob: 'Enter an amount above 0, or leave it empty' },
      parts: {},
    })
    expect(problems({ severalPaid: true, paid: { alice: '90', bob: '0' } }).paid).toEqual({
      bob: 'Enter an amount above 0, or leave it empty',
    })
    expect(
      problems(
        { splitBetween: ['alice', 'bob'], splitMode: 'exact', parts: { alice: '100', bob: '-10' } },
        9000,
      ),
    ).toEqual({ paid: {}, parts: { bob: 'Enter an amount of 0 or more' } })
    // A part of 0 is fine.
    expect(
      problems(
        { splitBetween: ['alice', 'bob'], splitMode: 'exact', parts: { alice: '90', bob: '0' } },
        9000,
      ),
    ).toEqual({ paid: {}, parts: {} })
  })

  it('checks exact parts against the total only once the total reads', () => {
    expect(
      problems({ splitBetween: ['alice'], splitMode: 'exact', parts: { alice: '5' } }, Number.NaN),
    ).toEqual({ paid: {}, parts: {} })
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

describe('itemised receipts (#42)', () => {
  const item = (extra: Partial<ItemValues>): ItemValues => ({ ...NEW_ITEM, ...extra })
  // User flow 7: Bob pays; milk, bread and the discount are for everyone, the beer for Bob.
  const flow7 = (extra: Partial<HouseExpenseValues> = {}) =>
    values({
      itemised: true,
      amount: '',
      category: '',
      paidBy: 'bob',
      splitBetween: ['cara', 'alice', 'bob'],
      items: [
        item({ name: 'Milk', amount: '4' }),
        item({ name: 'Bread', amount: '5' }),
        item({ name: 'Beer', amount: '20', excluded: ['alice', 'cara'] }),
        item({ name: 'Discount', amount: '2', discount: true }),
      ],
      ...extra,
    })
  const everyone = ['alice', 'bob', 'cara']

  it('sends user flow 7 exactly: items in order, no total or split, payers adding up', () => {
    const body = toHouseExpenseBody(flow7(), IDS, 'AUD')
    expect(body).toEqual({
      id: 'tx1',
      groupId: 'house1',
      kind: 'expense',
      date: '2026-10-19',
      description: 'Groceries',
      payers: [{ personId: 'bob', cents: 2700 }],
      items: [
        { name: 'Milk', amountCents: 400, split: { mode: 'equal', personIds: everyone } },
        { name: 'Bread', amountCents: 500, split: { mode: 'equal', personIds: everyone } },
        { name: 'Beer', amountCents: 2000, split: { mode: 'equal', personIds: ['bob'] } },
        { name: 'Discount', amountCents: -200, split: { mode: 'equal', personIds: everyone } },
      ],
    })
    expect(body).not.toHaveProperty('totalCents')
    expect(body).not.toHaveProperty('split')
  })

  it('previews flow 7 from core, summing each person’s items', () => {
    const preview = previewShares(
      toHouseExpenseBody(flow7(), IDS, 'AUD'),
      { ownerPersonId: 'alice' },
      MEMBERS,
      'alice',
    )
    expect('shares' in preview).toBe(true)
    if (!('shares' in preview)) return
    const received = Object.fromEntries(preview.shares.map((s) => [s.personId, s.receivedCents]))
    // User flow 7: each shared item splits 3 ways; the beer is Bob’s alone.
    expect(received).toEqual({ alice: 234, bob: 2233, cara: 233 })
    expect(preview.shares.find((s) => s.personId === 'bob')?.givenCents).toBe(2700)
  })

  it('sends shares per item, an item’s category, and a negative amount typed as one', () => {
    const body = toHouseExpenseBody(
      flow7({
        items: [
          item({
            name: 'Wine',
            amount: '30',
            category: 'groceries',
            mode: 'weights',
            excluded: ['cara'],
            shares: { alice: '2', bob: '1', cara: '5' },
          }),
          item({ name: 'Coupon', amount: '-3' }),
        ],
      }),
      IDS,
      'AUD',
    )
    expect(body.items).toEqual([
      {
        name: 'Wine',
        amountCents: 3000,
        category: 'groceries',
        split: {
          mode: 'weights',
          weights: [
            { personId: 'alice', weight: 2 },
            { personId: 'bob', weight: 1 },
          ],
        },
      },
      { name: 'Coupon', amountCents: -300, split: { mode: 'equal', personIds: everyone } },
    ])
    expect(body.payers).toEqual([{ personId: 'bob', cents: 2700 }])
  })

  it('refunds one person the negative total, never several, and core accepts the body', () => {
    const refund = flow7({
      severalPaid: true,
      paid: { alice: '5', bob: '5' },
      items: [item({ name: 'Returned kettle', amount: '30', discount: true })],
    })
    const body = toHouseExpenseBody(refund, IDS, 'AUD')
    expect(body.payers).toEqual([{ personId: 'bob', cents: -3000 }])
    // The ledger's own checks, as the function runs them: the schema, shares, then invariants.
    const input = transactionInputSchema.parse(body)
    const { totalCents, shares } = buildShares(
      { ...input, kind: 'expense', date: input.date as never },
      {
        groupType: 'house',
        ownerPersonId: 'alice',
        callerPersonId: 'alice',
        members: MEMBERS.map((m) => ({
          personId: m.personId,
          joinedOn: m.joinedOn,
          leftOn: m.leftOn,
        })) as never,
      },
    )
    expect(totalCents).toBe(-3000)
    expect(() =>
      assertShareInvariants(
        { kind: 'expense', totalCents },
        shares,
        MEMBERS.map((m) => m.personId),
      ),
    ).not.toThrow()
    expect(shares.find((s) => s.personId === 'bob')).toMatchObject({ givenCents: -3000 })
    expect(shares.reduce((sum, s) => sum + s.receivedCents, 0)).toBe(-3000)
  })

  it('words a discount that pushes someone below zero', () => {
    const preview = previewShares(
      toHouseExpenseBody(
        flow7({
          items: [
            item({ name: 'Beer', amount: '20', excluded: ['alice', 'cara'] }),
            item({ name: 'Big coupon', amount: '15', discount: true }),
          ],
        }),
        IDS,
        'AUD',
      ),
      { ownerPersonId: 'alice' },
      MEMBERS,
      'alice',
    )
    expect(preview).toEqual({ error: 'A discount can’t make anyone’s part go below zero.' })
  })

  it('words a refund’s item that pushes someone above zero as a refund', () => {
    // −30.00 back for all three; Bob's beer makes his part −10.00 + 20.00.
    const preview = previewShares(
      toHouseExpenseBody(
        flow7({
          items: [
            item({ name: 'Returned kettle', amount: '-30' }),
            item({ name: 'Beer', amount: '20', excluded: ['alice', 'cara'] }),
          ],
        }),
        IDS,
        'AUD',
      ),
      { ownerPersonId: 'alice' },
      MEMBERS,
      'alice',
    )
    expect(preview).toEqual({
      error: 'On a refund, an item can’t make anyone’s part go above zero.',
    })
  })

  it('keeps a typed minus negative when the discount box is ticked too', () => {
    expect(itemCents(item({ amount: '-2.00', discount: true }), 'AUD')).toBe(-200)
    expect(itemCents(item({ amount: '2.00', discount: true }), 'AUD')).toBe(-200)
    expect(itemCents(item({ amount: '-2.00' }), 'AUD')).toBe(-200)
  })

  it('checks each item, then the total', () => {
    expect(
      itemProblems(
        flow7({
          items: [
            item({ name: ' ', amount: '' }),
            item({ name: 'Eggs', amount: 'lots', excluded: everyone }),
            item({ name: 'Wine', amount: '0', mode: 'weights', shares: { alice: '0', bob: '' } }),
          ],
        }),
        'AUD',
      ),
    ).toEqual({
      items: {
        0: { name: 'Required', amount: 'Required', shares: {} },
        1: {
          amount: 'Enter an amount like 40.50',
          people: 'Tick at least one person for this item.',
          shares: {},
        },
        2: {
          amount: 'Enter an amount other than 0',
          shares: {
            alice: 'Enter a whole number from 1 to 10000',
            bob: 'Required',
            cara: 'Required',
          },
        },
      },
    })
    expect(itemProblems(flow7(), 'AUD')).toEqual({ items: {} })
    expect(
      itemProblems(
        flow7({
          items: [
            item({ name: 'A', amount: '5' }),
            item({ name: 'B', amount: '5', discount: true }),
          ],
        }),
        'AUD',
      ).total,
    ).toBe('The items add up to 0.')
    expect(itemProblems(flow7({ items: [] }), 'AUD').total).toBe('Add at least one item.')
    // Each item may be up to $100,000,000.00; their sum, either way, may not.
    const big = (amount: string) => item({ name: 'Car', amount })
    expect(itemProblems(flow7({ items: [big('99999999'), big('1.00')] }), 'AUD')).toEqual({
      items: {},
    })
    for (const [first, second] of [
      ['100000000', '1.01'],
      ['-100000000', '-1.01'],
    ] as const) {
      expect(itemProblems(flow7({ items: [big(first), big(second)] }), 'AUD').total).toMatch(
        /^The items add up to more than .*100,000,000\.00\.$/,
      )
    }
    expect(
      itemProblems(flow7({ items: [item({ name: 'x'.repeat(121), amount: '1' })] }), 'AUD').items,
    ).toEqual({ 0: { name: 'At most 120 characters', shares: {} } })
    expect(
      itemProblems(flow7({ items: [item({ name: 'x'.repeat(120), amount: '1' })] }), 'AUD').items,
    ).toEqual({})
    expect(
      itemProblems(
        flow7({ items: Array.from({ length: 31 }, () => item({ name: 'X', amount: '1' })) }),
        'AUD',
      ).total,
    ).toBe('A receipt can have at most 30 items.')
  })
})
