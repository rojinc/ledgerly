import { describe, expect, it } from 'vitest'
import type { LocalDate } from '../dates/local-date'
import { buildShares } from '../ledger/build-shares'
import { type TransactionTemplate, transactionTemplateSchema } from '../schemas/ledger'
import { type SplitSpec, splitSpecSchema } from '../schemas/split'
import { mergeInput, mergeSplit } from './merge-input'

// P is merged into U; X and Y are other people.
const merge = { from: 'P', into: 'U' }

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
    const groceries: TransactionTemplate = {
      totalCents: 9000,
      payers: [{ personId: 'X', cents: 9000 }],
    }
    expect(mergeInput(groceries, 'expense', merge, ['X', 'U', 'P', 'X']).input).toEqual({
      ...groceries,
      split: {
        mode: 'weights',
        weights: [
          { personId: 'U', weight: 2 },
          { personId: 'X', weight: 1 },
        ],
      },
    })
    // A loan's default goes to its borrowers, which is who splitPeople lists.
    const loan: TransactionTemplate = { totalCents: 100 }
    expect(mergeInput(loan, 'loan', merge, ['P', 'U']).input.split).toEqual({
      mode: 'weights',
      weights: [{ personId: 'U', weight: 2 }],
    })
  })

  it('keeps the default where only one of them had a part, or the row has a split or items', () => {
    const groceries: TransactionTemplate = { totalCents: 9000 }
    expect(mergeInput(groceries, 'expense', merge, ['X', 'P']).input).toEqual(groceries)
    expect(mergeInput(groceries, 'expense', merge, ['X', 'U']).input).toEqual(groceries)
    expect(mergeInput(groceries, 'expense', merge).input).toEqual(groceries)
    const split: TransactionTemplate = {
      totalCents: 9000,
      split: { mode: 'equal', personIds: ['X', 'P'] },
    }
    expect(mergeInput(split, 'expense', merge, ['X', 'P', 'U']).input.split).toEqual({
      mode: 'equal',
      personIds: ['X', 'U'],
    })
    const items: TransactionTemplate = {
      items: [{ name: 'Milk', amountCents: 300, split: { mode: 'equal', personIds: ['P'] } }],
    }
    expect(mergeInput(items, 'expense', merge, ['P', 'U']).input.split).toBeUndefined()
    // Only expenses, bills and loans have a default split.
    expect(mergeInput(groceries, 'income', merge, ['P', 'U']).input.split).toBeUndefined()
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
