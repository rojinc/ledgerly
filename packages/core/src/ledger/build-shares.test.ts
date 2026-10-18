import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import { parseLocalDate } from '../dates/local-date'
import { buildShares as build, type LedgerContext, type ShareInput } from './build-shares'
import { LedgerError } from './ledger-error'

const sharesOf = (input: ShareInput, ctx: LedgerContext) => build(input, ctx).shares

const d = parseLocalDate
const member = (personId: string, joinedOn = '2026-01-01', leftOn: string | null = null) => ({
  personId,
  joinedOn: d(joinedOn),
  leftOn: leftOn === null ? null : d(leftOn),
})

const house: LedgerContext = {
  groupType: 'house',
  ownerPersonId: 'alice',
  callerPersonId: 'alice',
  members: [member('alice'), member('bob'), member('cara', '2026-08-01')],
}
const employer: LedgerContext = {
  groupType: 'employer',
  ownerPersonId: 'worker',
  callerPersonId: 'worker',
  members: [member('worker'), member('boss')],
}
const personal: LedgerContext = {
  groupType: 'personal',
  ownerPersonId: 'me',
  callerPersonId: 'me',
  members: [member('me')],
}
const pair: LedgerContext = {
  groupType: 'pair',
  ownerPersonId: 'me',
  callerPersonId: 'me',
  members: [member('me'), member('sam')],
}

const tx = (fields: Partial<ShareInput> & Pick<ShareInput, 'kind'>): ShareInput => ({
  date: d('2026-10-10'),
  ...fields,
})

const expectInvalid = (run: () => unknown, message?: RegExp) => {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LedgerError)
  expect((caught as LedgerError).code).toBe('VALIDATION_FAILED')
  if (message) expect((caught as LedgerError).message).toMatch(message)
}

describe('buildShares', () => {
  it('only allows the kinds each group type has', () => {
    expectInvalid(
      () => sharesOf(tx({ kind: 'shift', shift: { minutes: 60, rateCents: 100 } }), house),
      /house groups can't have shift transactions/,
    )
    expectInvalid(() =>
      sharesOf(
        tx({ kind: 'payment', totalCents: 100, payment: { fromPersonId: 'me', toPersonId: 'me' } }),
        personal,
      ),
    )
    expectInvalid(() => sharesOf(tx({ kind: 'income', totalCents: 100 }), house))
    expectInvalid(() => sharesOf(tx({ kind: 'loan', totalCents: 100 }), employer))
  })

  it('refuses payers on kinds that have none', () => {
    expectInvalid(
      () =>
        sharesOf(
          tx({
            kind: 'payment',
            totalCents: 100,
            payment: { fromPersonId: 'bob', toPersonId: 'alice' },
            payers: [{ personId: 'bob', cents: 100 }],
          }),
          house,
        ),
      /can't have payers/,
    )
  })

  describe('shift', () => {
    it('the worker gives and the employer receives minutes × rate', () => {
      expect(
        sharesOf(tx({ kind: 'shift', shift: { minutes: 300, rateCents: 2500 } }), employer),
      ).toEqual([
        { personId: 'boss', givenCents: 0, receivedCents: 12500 },
        { personId: 'worker', givenCents: 12500, receivedCents: 0 },
      ])
    })

    it('rejects a total that doesn’t match, a missing shift, or an amount over the limit', () => {
      expectInvalid(
        () =>
          sharesOf(
            tx({ kind: 'shift', totalCents: 1, shift: { minutes: 300, rateCents: 2500 } }),
            employer,
          ),
        /doesn’t match/,
      )
      expectInvalid(() => sharesOf(tx({ kind: 'shift' }), employer), /needs minutes/)
      expectInvalid(
        () =>
          sharesOf(
            tx({ kind: 'shift', shift: { minutes: 61, rateCents: MAX_AMOUNT_CENTS } }),
            employer,
          ),
        /more than the maximum/,
      )
    })

    it('returns the computed total', () => {
      expect(
        build(tx({ kind: 'shift', shift: { minutes: 90, rateCents: 2533 } }), employer).totalCents,
      ).toBe(3800)
    })

    it('treats an employer group without exactly one employer as broken data', () => {
      let caught: unknown
      try {
        sharesOf(tx({ kind: 'shift', shift: { minutes: 60, rateCents: 100 } }), {
          ...employer,
          members: [...employer.members, member('boss2')],
        })
      } catch (error) {
        caught = error
      }
      expect((caught as LedgerError).code).toBe('INVARIANT_VIOLATION')
    })
  })

  describe('payment', () => {
    it('from gives and to receives the total', () => {
      expect(
        sharesOf(
          tx({
            kind: 'payment',
            totalCents: 3000,
            payment: { fromPersonId: 'bob', toPersonId: 'alice' },
          }),
          house,
        ),
      ).toEqual([
        { personId: 'alice', givenCents: 0, receivedCents: 3000 },
        { personId: 'bob', givenCents: 3000, receivedCents: 0 },
      ])
    })

    it('needs who paid whom and a total', () => {
      expectInvalid(
        () => sharesOf(tx({ kind: 'payment', totalCents: 3000 }), house),
        /who paid whom/,
      )
      expectInvalid(
        () =>
          sharesOf(
            tx({ kind: 'payment', payment: { fromPersonId: 'bob', toPersonId: 'alice' } }),
            house,
          ),
        /totalCents/,
      )
    })
  })

  describe('income', () => {
    it('is given and received by the owner, so it nets to 0', () => {
      expect(sharesOf(tx({ kind: 'income', totalCents: 80000 }), personal)).toEqual([
        { personId: 'me', givenCents: 80000, receivedCents: 80000 },
      ])
      expectInvalid(() => sharesOf(tx({ kind: 'income' }), personal), /totalCents/)
    })
  })

  describe('adjustment', () => {
    it('takes explicit shares, and they may mix signs', () => {
      const shares = [
        { personId: 'alice', givenCents: 500, receivedCents: -200 },
        { personId: 'bob', givenCents: -200, receivedCents: 500 },
      ]
      expect(
        sharesOf(tx({ kind: 'adjustment', adjustment: { shares, reason: 'fix' } }), house),
      ).toEqual(shares)
      expect(
        sharesOf(
          tx({ kind: 'adjustment', totalCents: 300, adjustment: { shares, reason: 'fix' } }),
          house,
        ),
      ).toEqual(shares)
    })

    it('must balance, match totalCents and have shares', () => {
      const shares = [{ personId: 'alice', givenCents: 500, receivedCents: 0 }]
      expectInvalid(
        () => sharesOf(tx({ kind: 'adjustment', adjustment: { shares, reason: 'x' } }), house),
        /balance/,
      )
      const balanced = [
        { personId: 'alice', givenCents: 500, receivedCents: 0 },
        { personId: 'bob', givenCents: 0, receivedCents: 500 },
      ]
      expectInvalid(
        () =>
          sharesOf(
            tx({
              kind: 'adjustment',
              totalCents: 1,
              adjustment: { shares: balanced, reason: 'x' },
            }),
            house,
          ),
        /doesn’t match/,
      )
      expectInvalid(() => sharesOf(tx({ kind: 'adjustment' }), house), /needs shares/)
    })
  })

  describe('expense, bill and loan', () => {
    it('defaults to the caller paying and an equal split between everyone present', () => {
      // Cara joins on 1 Aug, so she isn't present on 10 Jul.
      expect(
        sharesOf(tx({ kind: 'expense', totalCents: 1000, date: d('2026-07-10') }), house),
      ).toEqual([
        { personId: 'alice', givenCents: 1000, receivedCents: 500 },
        { personId: 'bob', givenCents: 0, receivedCents: 500 },
      ])
    })

    it('leaves out people who have left from the default split', () => {
      const ctx = {
        ...house,
        members: [member('alice'), member('bob', '2026-01-01', '2026-09-30')],
      }
      expect(sharesOf(tx({ kind: 'expense', totalCents: 1000 }), ctx)).toEqual([
        { personId: 'alice', givenCents: 1000, receivedCents: 1000 },
      ])
    })

    it('takes several payers, which must add up to the total', () => {
      const payers = [
        { personId: 'alice', cents: 5000 },
        { personId: 'bob', cents: 4000 },
      ]
      expect(
        sharesOf(
          tx({
            kind: 'expense',
            totalCents: 9000,
            payers,
            split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
          }),
          house,
        ),
      ).toEqual([
        { personId: 'alice', givenCents: 5000, receivedCents: 3000 },
        { personId: 'bob', givenCents: 4000, receivedCents: 3000 },
        { personId: 'cara', givenCents: 0, receivedCents: 3000 },
      ])
      expectInvalid(
        () => sharesOf(tx({ kind: 'expense', totalCents: 9001, payers }), house),
        /Payers must add up/,
      )
    })

    it('needs a total unless it has items', () => {
      expectInvalid(() => sharesOf(tx({ kind: 'expense' }), house), /totalCents/)
    })

    it('drops people whose share is zero both ways', () => {
      expect(
        sharesOf(
          tx({
            kind: 'expense',
            totalCents: 1,
            split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
          }),
          house,
        ),
      ).toEqual([{ personId: 'alice', givenCents: 1, receivedCents: 1 }])
    })

    it('splits a house bill by days present unless the group prefers equal', () => {
      const bill = {
        status: 'paid' as const,
        periodStart: d('2026-07-01'),
        periodEnd: d('2026-09-30'),
      }
      expect(
        sharesOf(tx({ kind: 'bill', totalCents: 27000, bill }), house).map((s) => s.receivedCents),
      ).toEqual([10139, 10139, 6722])
      expect(
        sharesOf(tx({ kind: 'bill', totalCents: 27000, bill }), {
          ...house,
          defaultBillSplit: 'equal',
        }).map((s) => s.receivedCents),
      ).toEqual([9000, 9000, 9000])
    })

    it('splits a bill outside a house equally between everyone present', () => {
      expect(
        sharesOf(tx({ kind: 'bill', totalCents: 40000, bill: { status: 'paid' } }), personal),
      ).toEqual([{ personId: 'me', givenCents: 40000, receivedCents: 40000 }])
    })

    it('gives a loan to everyone present except the lender', () => {
      expect(sharesOf(tx({ kind: 'loan', totalCents: 5000 }), pair)).toEqual([
        { personId: 'me', givenCents: 5000, receivedCents: 0 },
        { personId: 'sam', givenCents: 0, receivedCents: 5000 },
      ])
      expectInvalid(
        () =>
          sharesOf(tx({ kind: 'loan', totalCents: 5000 }), { ...pair, members: [member('me')] }),
        /Nobody to split/,
      )
    })

    it('adds up items, each with its own split', () => {
      const items = [
        {
          name: 'Milk',
          amountCents: 400,
          split: { mode: 'equal' as const, personIds: ['alice', 'bob'] },
        },
        { name: 'Beer', amountCents: 2000, split: { mode: 'equal' as const, personIds: ['bob'] } },
      ]
      expect(sharesOf(tx({ kind: 'expense', items }), { ...house, callerPersonId: 'bob' })).toEqual(
        [
          { personId: 'alice', givenCents: 0, receivedCents: 200 },
          { personId: 'bob', givenCents: 2400, receivedCents: 2200 },
        ],
      )
      expectInvalid(
        () => sharesOf(tx({ kind: 'expense', items, totalCents: 1 }), house),
        /doesn’t match/,
      )
    })

    it('fails when a discount or a payer would push someone past zero', () => {
      const items = [
        { name: 'Milk', amountCents: 100, split: { mode: 'equal' as const, personIds: ['alice'] } },
        {
          name: 'Voucher',
          amountCents: -50,
          split: { mode: 'equal' as const, personIds: ['bob'] },
        },
      ]
      expectInvalid(() => sharesOf(tx({ kind: 'expense', items }), house), /mix signs/)
      const payers = [
        { personId: 'alice', cents: 150 },
        { personId: 'bob', cents: -50 },
      ]
      expectInvalid(
        () => sharesOf(tx({ kind: 'expense', totalCents: 100, payers }), house),
        /mix signs/,
      )
      // A refund can't make anyone positive either.
      const refundPayers = [
        { personId: 'alice', cents: -150 },
        { personId: 'bob', cents: 50 },
      ]
      expectInvalid(
        () => sharesOf(tx({ kind: 'expense', totalCents: -100, payers: refundPayers }), house),
        /mix signs/,
      )
    })
  })

  describe('stricter input rules', () => {
    it('refuses people who aren’t members, wherever they are named', () => {
      expectInvalid(
        () =>
          sharesOf(
            tx({ kind: 'expense', totalCents: 100, split: { mode: 'equal', personIds: ['zoe'] } }),
            house,
          ),
        /Only members/,
      )
      expectInvalid(
        () =>
          sharesOf(
            tx({
              kind: 'expense',
              totalCents: 100,
              payers: [{ personId: 'zoe', cents: 100 }],
              split: { mode: 'equal', personIds: ['alice'] },
            }),
            house,
          ),
        /Only members/,
      )
      expectInvalid(
        () =>
          sharesOf(
            tx({
              kind: 'payment',
              totalCents: 100,
              payment: { fromPersonId: 'zoe', toPersonId: 'alice' },
            }),
            house,
          ),
        /Only members/,
      )
    })

    it('caps the total of items', () => {
      const big = { mode: 'equal' as const, personIds: ['alice'] }
      const items = [
        { name: 'A', amountCents: MAX_AMOUNT_CENTS, split: big },
        { name: 'B', amountCents: 1, split: big },
      ]
      expectInvalid(() => sharesOf(tx({ kind: 'expense', items }), house), /over the maximum/)
    })

    it('refuses items and a split together', () => {
      expectInvalid(
        () =>
          sharesOf(
            tx({
              kind: 'expense',
              items: [
                { name: 'A', amountCents: 100, split: { mode: 'equal', personIds: ['alice'] } },
              ],
              split: { mode: 'equal', personIds: ['bob'] },
            }),
            house,
          ),
        /either items or a split/,
      )
    })

    it('allows negative totals only for expenses, bills and adjustments', () => {
      expectInvalid(
        () =>
          sharesOf(
            tx({
              kind: 'payment',
              totalCents: -100,
              payment: { fromPersonId: 'bob', toPersonId: 'alice' },
            }),
            house,
          ),
        /refunds/,
      )
      expectInvalid(() => sharesOf(tx({ kind: 'loan', totalCents: -100 }), pair), /refunds/)
      expectInvalid(() => sharesOf(tx({ kind: 'income', totalCents: -100 }), personal), /refunds/)
      expect(
        sharesOf(tx({ kind: 'bill', totalCents: -300, bill: { status: 'paid' } }), personal),
      ).toEqual([{ personId: 'me', givenCents: -300, receivedCents: -300 }])
    })

    it('needs a split for an employer expense (the presets always send one)', () => {
      expectInvalid(
        () => sharesOf(tx({ kind: 'expense', totalCents: 100 }), employer),
        /needs a split/,
      )
    })

    it('refuses more than 15 people', () => {
      const big: LedgerContext = {
        ...house,
        members: Array.from({ length: 16 }, (_, i) => member(`p${String(i).padStart(2, '0')}`)),
      }
      expectInvalid(
        () =>
          sharesOf(tx({ kind: 'expense', totalCents: 1600 }), { ...big, callerPersonId: 'p00' }),
        /At most 15/,
      )
    })

    it('ignores join dates outside houses, so back-dated entries work', () => {
      const newPair: LedgerContext = {
        ...pair,
        members: [member('me', '2026-10-01'), member('sam', '2026-10-01')],
      }
      expect(
        sharesOf(tx({ kind: 'loan', totalCents: 5000, date: d('2026-06-01') }), newPair),
      ).toEqual([
        { personId: 'me', givenCents: 5000, receivedCents: 0 },
        { personId: 'sam', givenCents: 0, receivedCents: 5000 },
      ])
    })

    it('splits a house bill without a period equally between everyone present', () => {
      expect(
        sharesOf(tx({ kind: 'bill', totalCents: 900, bill: { status: 'paid' } }), house).map(
          (s) => s.receivedCents,
        ),
      ).toEqual([300, 300, 300])
    })

    it('gives the same result whatever order the members come in', () => {
      const reversed = { ...house, members: [...house.members].reverse() }
      const input = tx({ kind: 'expense', totalCents: 1000 })
      expect(sharesOf(input, reversed)).toEqual(sharesOf(input, house))
      const bill = tx({
        kind: 'bill',
        totalCents: 1000,
        bill: { status: 'paid', periodStart: d('2026-07-01'), periodEnd: d('2026-09-30') },
      })
      expect(sharesOf(bill, reversed)).toEqual(sharesOf(bill, house))
    })
  })
})
