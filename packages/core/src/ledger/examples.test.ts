import { describe, expect, it } from 'vitest'
import { parseLocalDate } from '../dates/local-date'
import type { SplitSpec } from '../schemas/split'
import { buildShares, type LedgerContext, type Share, type ShareInput } from './build-shares'
import { assertShareInvariants } from './invariants'
import { LedgerError } from './ledger-error'

// The golden examples: ledger.md#worked-examples and user flows 6 and 7, with
// exact cents (testing.md#golden-examples). If a doc example changes, this file
// changes in the same PR, and the other way round.

const d = parseLocalDate
const member = (personId: string, joinedOn = '2026-01-01') => ({
  personId,
  joinedOn: d(joinedOn),
  leftOn: null,
})
const ctx = (
  groupType: LedgerContext['groupType'],
  people: string[],
  caller = people[0] as string,
) => ({
  groupType,
  ownerPersonId: people[0] as string,
  callerPersonId: caller,
  members: people.map((personId) => member(personId)),
})
const tx = (fields: Partial<ShareInput> & Pick<ShareInput, 'kind'>): ShareInput => ({
  date: d('2026-10-10'),
  ...fields,
})
const nets = (shares: Share[]) =>
  Object.fromEntries(
    shares.map((share) => [share.personId, share.givenCents - share.receivedCents]),
  )
const equal = (...personIds: string[]): SplitSpec => ({ mode: 'equal', personIds })

describe('ledger.md worked examples', () => {
  const house = ctx('house', ['alice', 'bob', 'cara'])

  it('Electricity $90, Alice paid, split equally between 3', () => {
    const shares = buildShares(
      tx({
        kind: 'bill',
        totalCents: 9000,
        bill: { status: 'paid' },
        split: equal('alice', 'bob', 'cara'),
      }),
      house,
    )
    expect(shares).toEqual([
      { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
      { personId: 'bob', givenCents: 0, receivedCents: 3000 },
      { personId: 'cara', givenCents: 0, receivedCents: 3000 },
    ])
    expect(nets(shares)).toEqual({ alice: 6000, bob: -3000, cara: -3000 })
  })

  it('Bob pays Alice $30', () => {
    const shares = buildShares(
      tx({
        kind: 'payment',
        totalCents: 3000,
        payment: { fromPersonId: 'bob', toPersonId: 'alice' },
      }),
      house,
    )
    expect(nets(shares)).toEqual({ bob: 3000, alice: -3000 })
  })

  const employer = ctx('employer', ['worker', 'employer'])

  it('Thursday shift 5h × $25', () => {
    const shares = buildShares(
      tx({ kind: 'shift', shift: { minutes: 300, rateCents: 2500 } }),
      employer,
    )
    expect(nets(shares)).toEqual({ worker: 12500, employer: -12500 })
  })

  it('Employer pays $500', () => {
    const shares = buildShares(
      tx({
        kind: 'payment',
        totalCents: 50000,
        payment: { fromPersonId: 'employer', toPersonId: 'worker' },
      }),
      employer,
    )
    expect(nets(shares)).toEqual({ employer: 50000, worker: -50000 })
  })

  it('$120 on the employer’s card for work (preset: bought on their card)', () => {
    const shares = buildShares(
      tx({
        kind: 'expense',
        totalCents: 12000,
        payers: [{ personId: 'employer', cents: 12000 }],
        split: equal('employer'),
      }),
      employer,
    )
    expect(shares).toEqual([{ personId: 'employer', givenCents: 12000, receivedCents: 12000 }])
  })

  it('Employer presets: I paid for them, and a personal purchase on their card', () => {
    const reimbursable = buildShares(
      tx({ kind: 'expense', totalCents: 4000, split: equal('employer') }),
      employer,
    )
    expect(nets(reimbursable)).toEqual({ worker: 4000, employer: -4000 })
    const personalOnTheirCard = buildShares(
      tx({
        kind: 'expense',
        totalCents: 2500,
        payers: [{ personId: 'employer', cents: 2500 }],
        split: equal('worker'),
      }),
      employer,
    )
    expect(nets(personalOnTheirCard)).toEqual({ employer: 2500, worker: -2500 })
  })

  it('Lend Sam $50', () => {
    const shares = buildShares(tx({ kind: 'loan', totalCents: 5000 }), ctx('pair', ['you', 'sam']))
    expect(shares).toEqual([
      { personId: 'sam', givenCents: 0, receivedCents: 5000 },
      { personId: 'you', givenCents: 5000, receivedCents: 0 },
    ])
  })

  it('Refund of $20 on a shared $60 purchase Alice paid (split Alice/Bob)', () => {
    const shares = buildShares(
      tx({ kind: 'expense', totalCents: -2000, split: equal('alice', 'bob') }),
      house,
    )
    expect(shares).toEqual([
      { personId: 'alice', givenCents: -2000, receivedCents: -1000 },
      { personId: 'bob', givenCents: 0, receivedCents: -1000 },
    ])
    expect(nets(shares)).toEqual({ alice: -1000, bob: 1000 })
  })
})

describe('user flows', () => {
  it('flow 6: electricity $270, 1 Jul–30 Sep, Cara moved in on 1 Aug, Alice paid on 10 Oct', () => {
    const house = {
      ...ctx('house', ['alice', 'bob', 'cara']),
      members: [member('alice'), member('bob'), member('cara', '2026-08-01')],
    }
    const shares = buildShares(
      tx({
        kind: 'bill',
        totalCents: 27000,
        bill: { status: 'paid', periodStart: d('2026-07-01'), periodEnd: d('2026-09-30') },
      }),
      house,
    )
    expect(shares).toEqual([
      { personId: 'alice', givenCents: 27000, receivedCents: 10139 },
      { personId: 'bob', givenCents: 0, receivedCents: 10139 },
      { personId: 'cara', givenCents: 0, receivedCents: 6722 },
    ])
  })

  it('flow 7: itemised groceries Bob paid: milk $4, bread $5 (everyone), beer $20 (Bob), discount −$2 (everyone)', () => {
    const everyone = equal('alice', 'bob', 'cara')
    const shares = buildShares(
      tx({
        kind: 'expense',
        items: [
          { name: 'Milk', amountCents: 400, split: everyone },
          { name: 'Bread', amountCents: 500, split: everyone },
          { name: 'Beer', amountCents: 2000, split: equal('bob') },
          { name: 'Discount', amountCents: -200, split: everyone },
        ],
      }),
      ctx('house', ['alice', 'bob', 'cara'], 'bob'),
    )
    // milk 134/133/133, bread 167/167/166, discount −67/−67/−66
    expect(shares).toEqual([
      { personId: 'alice', givenCents: 0, receivedCents: 234 },
      { personId: 'bob', givenCents: 2700, receivedCents: 2233 },
      { personId: 'cara', givenCents: 0, receivedCents: 233 },
    ])
  })
})

// Seeded, so a failing case repeats on every run.
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('invariants hold for random transactions', () => {
  it('every kind and split mode, 3000 cases', () => {
    const random = seededRandom(20261018)
    const int = (max: number) => Math.floor(random() * (max + 1))
    const pick = <T>(list: readonly T[]) => list[int(list.length - 1)] as T
    const people = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06']
    const house: LedgerContext = {
      groupType: 'house',
      ownerPersonId: 'p01',
      callerPersonId: 'p02',
      members: people.map((p) => member(p)),
    }

    const randomSplit = (amount: number): SplitSpec => {
      const chosen = people.filter(() => random() < 0.6)
      const named = chosen.length > 0 ? chosen : ['p03']
      switch (pick(['equal', 'percent', 'weights', 'exact'] as const)) {
        case 'equal':
          return { mode: 'equal', personIds: named }
        case 'weights':
          return {
            mode: 'weights',
            weights: named.map((personId) => ({ personId, weight: 1 + int(99) })),
          }
        case 'percent': {
          const points = named.map(() => int(100))
          const sum = points.reduce((a, b) => a + b, 0) || 1
          const basis = points.map((p) => Math.floor((p * 10000) / sum))
          basis[0] = (basis[0] as number) + 10000 - basis.reduce((a, b) => a + b, 0)
          return {
            mode: 'percent',
            percents: named.map((personId, i) => ({ personId, basisPoints: basis[i] as number })),
          }
        }
        default: {
          const rest = named
            .slice(1)
            .map((personId) => ({ personId, cents: Math.trunc(amount / named.length) }))
          const first = amount - rest.reduce((a, b) => a + b.cents, 0)
          return {
            mode: 'exact',
            amounts: [{ personId: named[0] as string, cents: first }, ...rest],
          }
        }
      }
    }

    let checked = 0
    for (let run = 0; run < 3000; run++) {
      const sign = random() < 0.15 ? -1 : 1
      const total = sign * int(5_000_000)
      const kind = pick(['expense', 'bill', 'loan', 'payment', 'adjustment'] as const)
      let input: ShareInput
      if (kind === 'payment') {
        input = tx({ kind, totalCents: total, payment: { fromPersonId: 'p02', toPersonId: 'p04' } })
      } else if (kind === 'adjustment') {
        const shares = [
          { personId: 'p01', givenCents: total, receivedCents: int(1000) },
          { personId: 'p05', givenCents: 0, receivedCents: 0 },
        ]
        ;(shares[1] as Share).receivedCents = total - (shares[0] as Share).receivedCents
        input = tx({ kind, adjustment: { shares, reason: 'random' } })
      } else if (random() < 0.4) {
        const items = Array.from({ length: 1 + int(5) }, (_, i) => {
          const amountCents = sign * int(200_000)
          return { name: `item ${i}`, amountCents, split: randomSplit(amountCents) }
        })
        input = tx({
          kind,
          items,
          ...(kind === 'bill' ? { bill: { status: 'paid' as const } } : {}),
        })
      } else {
        input = tx({
          kind,
          totalCents: total,
          split: randomSplit(total),
          ...(kind === 'bill' ? { bill: { status: 'paid' as const } } : {}),
        })
      }

      const shares = buildShares(input, house)
      const totalCents = shares.reduce((sum, share) => sum + share.givenCents, 0)
      assertShareInvariants({ kind, totalCents }, shares, people)
      if (input.totalCents !== undefined) expect(totalCents).toBe(input.totalCents)
      checked++
    }
    expect(checked).toBe(3000)
  })

  it('a rule-breaking input is refused as bad input, never written', () => {
    const house: LedgerContext = {
      groupType: 'house',
      ownerPersonId: 'a',
      callerPersonId: 'a',
      members: [member('a'), member('b')],
    }
    expect(() =>
      buildShares(
        tx({
          kind: 'expense',
          totalCents: 100,
          split: { mode: 'exact', amounts: [{ personId: 'a', cents: 1 }] },
        }),
        house,
      ),
    ).toThrow(LedgerError)
  })
})
