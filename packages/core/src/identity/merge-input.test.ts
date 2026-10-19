import { describe, expect, it } from 'vitest'
import type { LocalDate } from '../dates/local-date'
import { buildShares } from '../ledger/build-shares'
import { type TransactionTemplate, transactionTemplateSchema } from '../schemas/ledger'
import { type SplitSpec, splitSpecSchema } from '../schemas/split'
import { mergeInput, mergePostedSplit, mergeSplit } from './merge-input'

// P is merged into U; X and Y are other people.
const merge = { from: 'P', into: 'U' }

const JAN = '2026-01-01'

/**
 * A house as step 2 leaves it, splitting bills by days: U (P's row gone) and X, there since
 * January unless `members` says otherwise, as [person, joinedOn, leftOn].
 */
function house(
  members: [string, string, string | null][] = [
    ['U', JAN, null],
    ['X', JAN, null],
  ],
) {
  return {
    groupType: 'house' as const,
    ownerPersonId: 'X',
    callerPersonId: 'U',
    defaultBillSplit: 'days' as const,
    members: members.map(([personId, joinedOn, leftOn]) => ({
      personId,
      joinedOn: joinedOn as LocalDate,
      leftOn: leftOn as LocalDate | null,
    })),
  }
}

/**
 * A posted row dated 1 October, posted by X, with what its shares gave each person as
 * [person, cents].
 */
function posted(parts: [string, number][], ctx = house(), payer = 'X') {
  return {
    date: '2026-10-01' as LocalDate,
    totalCents: parts.reduce((sum, [, cents]) => sum + cents, 0),
    shares: parts.map(([personId, receivedCents]) => ({ personId, receivedCents })),
    ctx,
    payer,
  }
}

const paidByX = (cents: number): TransactionTemplate => ({ payers: [{ personId: 'X', cents }] })
const SEPTEMBER = {
  status: 'paid' as const,
  periodStart: '2026-09-01' as LocalDate,
  periodEnd: '2026-09-30' as LocalDate,
}

describe('mergeSplit', () => {
  it('renames P in an equal split, and leaves a split without P alone', () => {
    expect(mergeSplit({ mode: 'equal', personIds: ['X', 'P'] }, merge)).toEqual({
      mode: 'equal',
      personIds: ['X', 'U'],
    })
    expect(mergeSplit({ mode: 'equal', personIds: ['X', 'U'] }, merge)).toEqual({
      mode: 'equal',
      personIds: ['X', 'U'],
    })
  })

  it('turns an equal split naming both into weights, U 2, at the first of their places', () => {
    expect(mergeSplit({ mode: 'equal', personIds: ['X', 'P', 'Y', 'U'] }, merge)).toEqual({
      mode: 'weights',
      weights: [
        { personId: 'X', weight: 1 },
        { personId: 'U', weight: 2 },
        { personId: 'Y', weight: 1 },
      ],
    })
  })

  it('lists U once in a days split, and keeps one with no personIds as it is', () => {
    expect(mergeSplit({ mode: 'days', personIds: ['U', 'X', 'P'] }, merge)).toEqual({
      mode: 'days',
      personIds: ['U', 'X'],
    })
    expect(mergeSplit({ mode: 'days', personIds: ['P'] }, merge)).toEqual({
      mode: 'days',
      personIds: ['U'],
    })
    const everyone = { mode: 'days' } as const
    expect(mergeSplit(everyone, merge)).toBe(everyone)
  })

  it('adds up exact cents, percent basis points and weights', () => {
    expect(
      mergeSplit(
        {
          mode: 'exact',
          amounts: [
            { personId: 'P', cents: 2500 },
            { personId: 'X', cents: 1000 },
            { personId: 'U', cents: 500 },
          ],
        },
        merge,
      ),
    ).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'U', cents: 3000 },
        { personId: 'X', cents: 1000 },
      ],
    })
    expect(
      mergeSplit(
        {
          mode: 'percent',
          percents: [
            { personId: 'U', basisPoints: 2500 },
            { personId: 'P', basisPoints: 2500 },
            { personId: 'X', basisPoints: 5000 },
          ],
        },
        merge,
      ),
    ).toEqual({
      mode: 'percent',
      percents: [
        { personId: 'U', basisPoints: 5000 },
        { personId: 'X', basisPoints: 5000 },
      ],
    })
    expect(
      mergeSplit(
        {
          mode: 'weights',
          weights: [
            { personId: 'P', weight: 3 },
            { personId: 'U', weight: 2 },
          ],
        },
        merge,
      ),
    ).toEqual({ mode: 'weights', weights: [{ personId: 'U', weight: 5 }] })
  })

  it('renames P alone in amounts, percents and weights', () => {
    expect(mergeSplit({ mode: 'exact', amounts: [{ personId: 'P', cents: 100 }] }, merge)).toEqual({
      mode: 'exact',
      amounts: [{ personId: 'U', cents: 100 }],
    })
    expect(
      mergeSplit({ mode: 'percent', percents: [{ personId: 'P', basisPoints: 10000 }] }, merge),
    ).toEqual({ mode: 'percent', percents: [{ personId: 'U', basisPoints: 10000 }] })
    expect(mergeSplit({ mode: 'weights', weights: [{ personId: 'P', weight: 1 }] }, merge)).toEqual(
      { mode: 'weights', weights: [{ personId: 'U', weight: 1 }] },
    )
  })

  it('always gives a split the schema accepts, with each person once', () => {
    const splits: SplitSpec[] = [
      { mode: 'equal', personIds: ['P', 'U', 'X'] },
      { mode: 'days', personIds: ['P', 'U'] },
      {
        mode: 'exact',
        amounts: [
          { personId: 'P', cents: 1 },
          { personId: 'U', cents: 2 },
        ],
      },
      {
        mode: 'percent',
        percents: [
          { personId: 'U', basisPoints: 1 },
          { personId: 'P', basisPoints: 9999 },
        ],
      },
      {
        mode: 'weights',
        weights: [
          { personId: 'P', weight: 1 },
          { personId: 'U', weight: 1 },
        ],
      },
    ]
    for (const split of splits) {
      expect(splitSpecSchema.safeParse(mergeSplit(split, merge)).success).toBe(true)
    }
  })
})

describe('mergeInput', () => {
  it('renames P in payers, the split, items and an adjustment, adding up where U is there', () => {
    const template: TransactionTemplate = {
      totalCents: 9000,
      payers: [
        { personId: 'P', cents: 4000 },
        { personId: 'U', cents: 5000 },
      ],
      items: [{ name: 'Milk', amountCents: 9000, split: { mode: 'equal', personIds: ['P', 'X'] } }],
      note: 'kept',
    }
    const { input, voided } = mergeInput(template, 'expense', merge)
    expect(input).toEqual({
      totalCents: 9000,
      payers: [{ personId: 'U', cents: 9000 }],
      items: [{ name: 'Milk', amountCents: 9000, split: { mode: 'equal', personIds: ['U', 'X'] } }],
      note: 'kept',
    })
    expect(voided).toBe(false)
    // The input it was given is left as it was.
    expect(template.payers?.[0]).toEqual({ personId: 'P', cents: 4000 })

    expect(
      mergeInput(
        {
          adjustment: {
            reason: 'Fix',
            shares: [
              { personId: 'U', givenCents: 100, receivedCents: 0 },
              { personId: 'X', givenCents: 0, receivedCents: 150 },
              { personId: 'P', givenCents: 50, receivedCents: 0 },
            ],
          },
        },
        'adjustment',
        merge,
      ).input.adjustment,
    ).toEqual({
      reason: 'Fix',
      shares: [
        { personId: 'U', givenCents: 150, receivedCents: 0 },
        { personId: 'X', givenCents: 0, receivedCents: 150 },
      ],
    })
  })

  it('keeps an input that names nobody, and one without P, the same', () => {
    const shift: TransactionTemplate = { note: 'Shift' }
    expect(mergeInput(shift, 'shift', merge)).toEqual({ input: { note: 'Shift' }, voided: false })
    const withoutP: TransactionTemplate = { split: { mode: 'equal', personIds: ['U', 'X'] } }
    expect(mergeInput(withoutP, 'expense', merge).input).toEqual(withoutP)
  })

  it('voids a payment or a loan from U to U, and nothing else', () => {
    expect(
      mergeInput({ payment: { fromPersonId: 'P', toPersonId: 'U' } }, 'payment', merge),
    ).toEqual({ input: { payment: { fromPersonId: 'U', toPersonId: 'U' } }, voided: true })
    expect(
      mergeInput({ payment: { fromPersonId: 'X', toPersonId: 'P' } }, 'payment', merge),
    ).toEqual({ input: { payment: { fromPersonId: 'X', toPersonId: 'U' } }, voided: false })
    const loan: TransactionTemplate = {
      payers: [{ personId: 'U', cents: 500 }],
      split: { mode: 'equal', personIds: ['P'] },
    }
    expect(mergeInput(loan, 'loan', merge).voided).toBe(true)
    expect(
      mergeInput({ ...loan, split: { mode: 'equal', personIds: ['X'] } }, 'loan', merge).voided,
    ).toBe(false)
    // An expense U paid for themselves is still an expense.
    expect(mergeInput(loan, 'expense', merge).voided).toBe(false)
    // A loan that names nobody (not one a client can send) isn't voided.
    const nobody: TransactionTemplate = {}
    expect(mergeInput(nobody, 'loan', merge).voided).toBe(false)
    expect(mergeInput(nobody, 'payment', merge).voided).toBe(false)
  })

  it('never voids a loan whose borrowers or lender come from the default split', () => {
    // No split: everyone but the lender borrows, X and Y included (ledger.md#default-split).
    expect(mergeInput({ payers: [{ personId: 'P', cents: 900 }] }, 'loan', merge)).toEqual({
      input: { payers: [{ personId: 'U', cents: 900 }] },
      voided: false,
    })
    // No payers: whoever posts it lends.
    expect(mergeInput({ split: { mode: 'equal', personIds: ['P'] } }, 'loan', merge).voided).toBe(
      false,
    )
    // A payment's two sides are always stated; one from X still moves money.
    expect(
      mergeInput({ payment: { fromPersonId: 'P', toPersonId: 'X' } }, 'payment', merge).voided,
    ).toBe(false)
  })

  it('writes out a default split both P and U had a part of, as weights with U at 2', () => {
    const groceries: TransactionTemplate = paidByX(9000)
    // In any order.
    const thirds = posted([
      ['X', 3000],
      ['U', 3000],
      ['P', 3000],
    ])
    expect(mergeInput(groceries, 'expense', merge, thirds)).toEqual({
      input: {
        ...groceries,
        split: {
          mode: 'weights',
          weights: [
            { personId: 'U', weight: 2 },
            { personId: 'X', weight: 1 },
          ],
        },
      },
      voided: false,
    })
  })

  it('writes out a loan’s default where one of P and U lent and the other borrowed', () => {
    // U lent 90 to P and X: once P is U, the default would make X owe it all.
    const lentByU: TransactionTemplate = { payers: [{ personId: 'U', cents: 9000 }] }
    const toPAndX = posted([
      ['P', 4500],
      ['X', 4500],
    ])
    expect(mergeInput(lentByU, 'loan', merge, toPAndX)).toEqual({
      input: { ...lentByU, split: { mode: 'equal', personIds: ['U', 'X'] } },
      voided: false,
    })
    const lentByP: TransactionTemplate = { payers: [{ personId: 'P', cents: 9000 }] }
    const toUAndX = posted([
      ['U', 4500],
      ['X', 4500],
    ])
    expect(mergeInput(lentByP, 'loan', merge, toUAndX).input.split).toEqual({
      mode: 'equal',
      personIds: ['U', 'X'],
    })
    // U lent to P alone: a loan from U to U, voided.
    expect(mergeInput(lentByU, 'loan', merge, posted([['P', 9000]])).voided).toBe(true)
    // So is one that stores no payers, posted by U, who lent it.
    const posting: TransactionTemplate = {}
    const byU = posted([['P', 9000]], house(), 'U')
    expect(mergeInput(posting, 'loan', merge, byU)).toEqual({
      input: { split: { mode: 'equal', personIds: ['U'] } },
      voided: true,
    })
  })

  it('writes out as exact a split whose leftover cent would fall elsewhere once merged', () => {
    // 1.00 split equally by A, P and U: A 34, P 33, U 33. As weights A 1, U 2, A would get 33.
    const split: TransactionTemplate = {
      ...paidByX(100),
      split: { mode: 'equal', personIds: ['A', 'P', 'U'] },
    }
    const ctx = house([
      ['A', JAN, null],
      ['U', JAN, null],
      ['X', JAN, null],
    ])
    const parts = posted(
      [
        ['A', 34],
        ['P', 33],
        ['U', 33],
      ],
      ctx,
    )
    const exact = {
      mode: 'exact',
      amounts: [
        { personId: 'A', cents: 34 },
        { personId: 'U', cents: 66 },
      ],
    }
    expect(mergeInput(split, 'expense', merge, parts).input.split).toEqual(exact)
    // The default split of the same people, too.
    expect(mergeInput(paidByX(100), 'expense', merge, parts).input.split).toEqual(exact)
  })

  it('writes out as exact a days split, stated or by default, that U’s kept row would change', () => {
    // A September bill of 90 split by days: P 20, U 30, X 40.
    const byDays = posted([
      ['P', 2000],
      ['U', 3000],
      ['X', 4000],
    ])
    const days: TransactionTemplate = {
      ...paidByX(9000),
      bill: SEPTEMBER,
      split: { mode: 'days', personIds: ['P', 'U', 'X'] },
    }
    const exact = (amounts: [string, number][]) => ({
      mode: 'exact',
      amounts: amounts.map(([personId, cents]) => ({ personId, cents })),
    })
    expect(mergeInput(days, 'bill', merge, byDays).input.split).toEqual(
      exact([
        ['U', 5000],
        ['X', 4000],
      ]),
    )
    const byDefault: TransactionTemplate = { ...paidByX(9000), bill: SEPTEMBER }
    expect(mergeInput(byDefault, 'bill', merge, byDays).input.split).toEqual(
      exact([
        ['U', 5000],
        ['X', 4000],
      ]),
    )
    // P lived there until March, and U came on 16 September. U's kept row starts in January, so
    // a bill U alone had a part of would now give U all of September, and so would one neither
    // had. Neither is P's, so both are left as they are (lead, #242).
    const uFromThe16th = posted([
      ['U', 3000],
      ['X', 6000],
    ])
    expect(mergeInput(byDefault, 'bill', merge, uFromThe16th).input).toEqual(byDefault)
    expect(mergeInput(byDefault, 'bill', merge, posted([['X', 9000]])).input).toEqual(byDefault)
  })

  it('keeps a split that plans the same parts once merged', () => {
    // P alone had a part of the default: U counts once, which is right.
    const groceries: TransactionTemplate = paidByX(9000)
    const halves = posted([
      ['P', 4500],
      ['X', 4500],
    ])
    expect(mergeInput(groceries, 'expense', merge, halves).input).toEqual(groceries)
    // U wasn't a member, so P's row became U's with P's dates: the days come out the same.
    const days: TransactionTemplate = {
      ...paidByX(9000),
      bill: SEPTEMBER,
      split: { mode: 'days', personIds: ['P', 'X'] },
    }
    expect(mergeInput(days, 'bill', merge, halves).input.split).toEqual({
      mode: 'days',
      personIds: ['U', 'X'],
    })
    // X paid for P and U alone: X's share received nothing.
    const forBoth: TransactionTemplate = {
      ...paidByX(9000),
      split: { mode: 'equal', personIds: ['P', 'U'] },
    }
    const paidFor = posted([
      ['P', 4500],
      ['U', 4500],
      ['X', 0],
    ])
    expect(mergeInput(forBoth, 'expense', merge, paidFor).input.split).toEqual({
      mode: 'weights',
      weights: [{ personId: 'U', weight: 2 }],
    })
  })

  it('writes out as exact a split the rename leaves invalid', () => {
    const heavy: TransactionTemplate = {
      ...paidByX(9000),
      split: {
        mode: 'weights',
        weights: [
          { personId: 'P', weight: 6000 },
          { personId: 'U', weight: 6000 },
        ],
      },
    }
    expect(
      mergeInput(
        heavy,
        'expense',
        merge,
        posted([
          ['P', 4500],
          ['U', 4500],
        ]),
      ).input.split,
    ).toEqual({ mode: 'exact', amounts: [{ personId: 'U', cents: 9000 }] })
  })

  it('checks only posted rows with a split of their own to keep', () => {
    const groceries: TransactionTemplate = paidByX(9000)
    const thirds = posted([
      ['P', 3000],
      ['U', 3000],
      ['X', 3000],
    ])
    // Unposted, or with no shares to go by: renamed only.
    expect(mergeInput(groceries, 'expense', merge).input).toEqual(groceries)
    const namesP: TransactionTemplate = {
      ...paidByX(9000),
      split: { mode: 'equal', personIds: ['P', 'X'] },
    }
    expect(mergeInput(namesP, 'expense', merge, posted([])).input.split).toEqual({
      mode: 'equal',
      personIds: ['U', 'X'],
    })
    // Items have splits of their own, and only expenses, bills and loans have a split.
    const items: TransactionTemplate = {
      items: [{ name: 'Milk', amountCents: 300, split: { mode: 'equal', personIds: ['P'] } }],
    }
    expect(mergeInput(items, 'expense', merge, thirds).input.split).toBeUndefined()
    expect(mergeInput(groceries, 'income', merge, thirds).input.split).toBeUndefined()
  })

  it('gives a template the schema accepts', () => {
    const { input } = mergeInput(
      {
        totalCents: 3000,
        payers: [
          { personId: 'P', cents: 1000 },
          { personId: 'U', cents: 2000 },
        ],
        split: { mode: 'equal', personIds: ['P', 'U', 'X'] },
      },
      'expense',
      merge,
    )
    expect(transactionTemplateSchema.safeParse(input).success).toBe(true)
  })

  it('leaves each person with the same part of an exact split once it is posted (I-1, I-5)', () => {
    const members = ['P', 'U', 'X'].map((personId) => ({
      personId,
      joinedOn: '2026-01-01' as LocalDate,
      leftOn: null,
    }))
    const ctx = { groupType: 'house' as const, ownerPersonId: 'U', callerPersonId: 'U' }
    const input = {
      kind: 'expense' as const,
      date: '2026-10-19' as LocalDate,
      totalCents: 9000,
      payers: [
        { personId: 'P', cents: 4000 },
        { personId: 'X', cents: 5000 },
      ],
      split: {
        mode: 'exact' as const,
        amounts: [
          { personId: 'P', cents: 2000 },
          { personId: 'U', cents: 3000 },
          { personId: 'X', cents: 4000 },
        ],
      },
    }
    const before = buildShares(input, { ...ctx, members }).shares
    const after = buildShares(
      { ...input, ...mergeInput(input, 'expense', merge).input },
      { ...ctx, members: members.filter((member) => member.personId !== 'P') },
    ).shares
    const net = (shares: typeof before, ids: string[]) =>
      shares
        .filter((share) => ids.includes(share.personId))
        .reduce((sum, share) => sum + share.givenCents - share.receivedCents, 0)
    expect(net(after, ['U'])).toBe(net(before, ['P', 'U']))
    expect(net(after, ['X'])).toBe(net(before, ['X']))
  })
})

describe('mergeInput: a posted row with a 0 total', () => {
  const heavy: SplitSpec = {
    mode: 'weights',
    weights: [
      { personId: 'P', weight: 6000 },
      { personId: 'U', weight: 6000 },
      { personId: 'X', weight: 1 },
    ],
  }
  const nothing: TransactionTemplate = { payers: [{ personId: 'X', cents: 0 }], split: heavy }

  it('writes out as exact zeros a split the rename takes past MAX_WEIGHT, so it can be stored', () => {
    const { input } = mergeInput(nothing, 'expense', merge, posted([]))
    expect(input.split).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'U', cents: 0 },
        { personId: 'X', cents: 0 },
      ],
    })
    expect(transactionTemplateSchema.safeParse(input).success).toBe(true)
  })

  it('leaves a row with a total but no part as it is, rather than make it not add up', () => {
    // Shares can't be missing from a posted row with a total (I-1): no exact zeros for it.
    const missing = { ...posted([]), totalCents: 9000 }
    expect(mergeInput(nothing, 'expense', merge, missing).input.split).toEqual(
      mergeSplit(heavy, merge),
    )
  })

  it('keeps a split the rename leaves valid, and a row with no split', () => {
    const light: SplitSpec = {
      mode: 'weights',
      weights: [
        { personId: 'P', weight: 1 },
        { personId: 'U', weight: 1 },
      ],
    }
    expect(
      mergeInput({ ...nothing, split: light }, 'expense', merge, posted([])).input.split,
    ).toEqual(mergeSplit(light, merge))
    const noSplit: TransactionTemplate = { payers: [{ personId: 'P', cents: 0 }] }
    expect(mergeInput(noSplit, 'bill', merge, posted([])).input).toEqual({
      payers: [{ personId: 'U', cents: 0 }],
    })
  })
})

describe('mergePostedSplit', () => {
  const ctx = { members: house().members }
  const equal = (...personIds: string[]): SplitSpec => ({ mode: 'equal', personIds })

  it('writes an item split out as exact where its leftover cent would fall elsewhere', () => {
    // 1.00 split equally by A, P and U: A 34, P 33, U 33. As weights A 1, U 2, A would get 33.
    expect(mergePostedSplit(equal('A', 'P', 'U'), merge, 100, ctx)).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'A', cents: 34 },
        { personId: 'U', cents: 66 },
      ],
    })
    // Where it doesn't, the renamed split stays, and so does a split without P.
    expect(mergePostedSplit(equal('P', 'U', 'X'), merge, 900, ctx)).toEqual(
      mergeSplit(equal('P', 'U', 'X'), merge),
    )
    expect(mergePostedSplit(equal('U', 'X'), merge, 100, ctx)).toEqual(equal('U', 'X'))
  })

  it('writes out as exact weights the rename takes past MAX_WEIGHT', () => {
    const heavy: SplitSpec = {
      mode: 'weights',
      weights: [
        { personId: 'P', weight: 6000 },
        { personId: 'U', weight: 6000 },
      ],
    }
    expect(mergePostedSplit(heavy, merge, 300, ctx)).toEqual({
      mode: 'exact',
      amounts: [{ personId: 'U', cents: 300 }],
    })
  })

  it('writes out as exact zeros a 0 item whose weights the rename takes past MAX_WEIGHT', () => {
    const heavy: SplitSpec = {
      mode: 'weights',
      weights: [
        { personId: 'P', weight: 6000 },
        { personId: 'U', weight: 6000 },
        { personId: 'X', weight: 1 },
      ],
    }
    const split = mergePostedSplit(heavy, merge, 0, ctx)
    expect(split).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'U', cents: 0 },
        { personId: 'X', cents: 0 },
      ],
    })
    expect(splitSpecSchema.safeParse(split).success).toBe(true)
  })

  it('plans an item by days as it was before the merge, from the member dates step 1 recorded', () => {
    // A September bill of 75.00 by days: P was there all 30 days, U 15 (from the 16th), X 30.
    const days: SplitSpec = { mode: 'days', personIds: ['P', 'U', 'X'] }
    const september = { start: '2026-09-01' as LocalDate, end: '2026-09-30' as LocalDate }
    const before = {
      members: [
        { personId: 'P', joinedOn: JAN as LocalDate, leftOn: null },
        { personId: 'U', joinedOn: '2026-09-16' as LocalDate, leftOn: null },
        { personId: 'X', joinedOn: JAN as LocalDate, leftOn: null },
      ],
      period: september,
    }
    // After step 2, U's kept row starts in January, so an edit would count U's days once: 37.50.
    expect(mergePostedSplit(days, merge, 7500, { ...ctx, period: september }, before)).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'U', cents: 4500 },
        { personId: 'X', cents: 3000 },
      ],
    })
  })

  it('renames only a split it can’t plan now: days naming P, whose row is gone', () => {
    const days: SplitSpec = { mode: 'days', personIds: ['P', 'X'] }
    const september = { start: '2026-09-01' as LocalDate, end: '2026-09-30' as LocalDate }
    expect(mergePostedSplit(days, merge, 900, { ...ctx, period: september })).toEqual({
      mode: 'days',
      personIds: ['U', 'X'],
    })
  })
})
