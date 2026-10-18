import { describe, expect, it } from 'vitest'
import { parseLocalDate } from '../dates/local-date'
import type { SplitSpec } from '../schemas/split'
import {
  buildShares as build,
  type LedgerContext,
  type Share,
  type ShareInput,
} from './build-shares'
import { assertShareInvariants } from './invariants'
import { LedgerError } from './ledger-error'

const sharesOf = (input: ShareInput, ctx: LedgerContext) => build(input, ctx).shares

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
    const shares = sharesOf(
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
    const shares = sharesOf(
      tx({
        kind: 'payment',
        totalCents: 3000,
        payment: { fromPersonId: 'bob', toPersonId: 'alice' },
      }),
      house,
    )
    expect(shares).toEqual([
      { personId: 'alice', givenCents: 0, receivedCents: 3000 },
      { personId: 'bob', givenCents: 3000, receivedCents: 0 },
    ])
    expect(nets(shares)).toEqual({ bob: 3000, alice: -3000 })
  })

  const employer = ctx('employer', ['worker', 'employer'])

  it('Thursday shift 5h × $25', () => {
    const shares = sharesOf(
      tx({ kind: 'shift', shift: { minutes: 300, rateCents: 2500 } }),
      employer,
    )
    expect(shares).toEqual([
      { personId: 'employer', givenCents: 0, receivedCents: 12500 },
      { personId: 'worker', givenCents: 12500, receivedCents: 0 },
    ])
    expect(nets(shares)).toEqual({ worker: 12500, employer: -12500 })
  })

  it('Employer pays $500', () => {
    const shares = sharesOf(
      tx({
        kind: 'payment',
        totalCents: 50000,
        payment: { fromPersonId: 'employer', toPersonId: 'worker' },
      }),
      employer,
    )
    expect(shares).toEqual([
      { personId: 'employer', givenCents: 50000, receivedCents: 0 },
      { personId: 'worker', givenCents: 0, receivedCents: 50000 },
    ])
    expect(nets(shares)).toEqual({ employer: 50000, worker: -50000 })
  })

  it('$120 on the employer’s card for work (preset: bought on their card)', () => {
    const shares = sharesOf(
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
    const reimbursable = sharesOf(
      tx({ kind: 'expense', totalCents: 4000, split: equal('employer') }),
      employer,
    )
    expect(reimbursable).toEqual([
      { personId: 'employer', givenCents: 0, receivedCents: 4000 },
      { personId: 'worker', givenCents: 4000, receivedCents: 0 },
    ])
    expect(nets(reimbursable)).toEqual({ worker: 4000, employer: -4000 })
    const personalOnTheirCard = sharesOf(
      tx({
        kind: 'expense',
        totalCents: 2500,
        payers: [{ personId: 'employer', cents: 2500 }],
        split: equal('worker'),
      }),
      employer,
    )
    expect(personalOnTheirCard).toEqual([
      { personId: 'employer', givenCents: 2500, receivedCents: 0 },
      { personId: 'worker', givenCents: 0, receivedCents: 2500 },
    ])
    expect(nets(personalOnTheirCard)).toEqual({ employer: 2500, worker: -2500 })
  })

  it('Lend Sam $50', () => {
    const shares = sharesOf(tx({ kind: 'loan', totalCents: 5000 }), ctx('pair', ['you', 'sam']))
    expect(shares).toEqual([
      { personId: 'sam', givenCents: 0, receivedCents: 5000 },
      { personId: 'you', givenCents: 5000, receivedCents: 0 },
    ])
  })

  it('Refund of $20 on a shared $60 purchase Alice paid (split Alice/Bob)', () => {
    const shares = sharesOf(
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
    const shares = sharesOf(
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
    const shares = sharesOf(
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
  it('every group type, kind and split mode, with and without defaults, 5000 cases', () => {
    const random = seededRandom(20261018)
    const int = (max: number) => Math.floor(random() * (max + 1))
    const pick = <T>(list: readonly T[]) => list[int(list.length - 1)] as T
    const chance = (p: number) => random() < p

    const houseMembers = [
      member('p01'),
      member('p02'),
      member('p03', '2026-08-01'),
      { personId: 'p04', joinedOn: d('2026-01-01'), leftOn: d('2026-08-15') },
      member('p05'),
    ]
    const contexts: LedgerContext[] = [
      { groupType: 'house', ownerPersonId: 'p01', callerPersonId: 'p02', members: houseMembers },
      {
        groupType: 'house',
        ownerPersonId: 'p01',
        callerPersonId: 'p01',
        members: houseMembers,
        defaultBillSplit: 'equal',
      },
      {
        groupType: 'employer',
        ownerPersonId: 'w',
        callerPersonId: 'w',
        members: [member('w'), member('e')],
      },
      { groupType: 'personal', ownerPersonId: 'me', callerPersonId: 'me', members: [member('me')] },
      {
        groupType: 'pair',
        ownerPersonId: 'me',
        callerPersonId: 'me',
        members: [member('me'), member('sam')],
      },
    ]
    const KINDS: Record<LedgerContext['groupType'], readonly ShareInput['kind'][]> = {
      employer: ['shift', 'expense', 'payment', 'adjustment'],
      house: ['expense', 'bill', 'payment', 'loan', 'adjustment'],
      personal: ['expense', 'bill', 'income', 'adjustment'],
      pair: ['expense', 'bill', 'payment', 'loan', 'adjustment'],
    }

    const randomSplit = (amount: number, people: string[], isBill: boolean): SplitSpec => {
      const chosen = people.filter(() => chance(0.6))
      const named = chosen.length > 0 ? chosen : [people[0] as string]
      const mode = pick(
        isBill
          ? (['equal', 'percent', 'weights', 'exact', 'days'] as const)
          : (['equal', 'percent', 'weights', 'exact'] as const),
      )
      switch (mode) {
        case 'equal':
          return { mode, personIds: named }
        case 'days':
          return chance(0.5) ? { mode } : { mode, personIds: named }
        case 'weights':
          return { mode, weights: named.map((personId) => ({ personId, weight: 1 + int(99) })) }
        case 'percent': {
          const points = named.map(() => int(100))
          const sum = points.reduce((a, b) => a + b, 0) || 1
          const basis = points.map((p) => Math.floor((p * 10000) / sum))
          basis[0] = (basis[0] as number) + 10000 - basis.reduce((a, b) => a + b, 0)
          return {
            mode,
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
    const randomPayers = (total: number, people: string[]) => {
      const payer = pick(people)
      const other = pick(people.filter((p) => p !== payer))
      if (other === undefined || chance(0.5)) return [{ personId: payer, cents: total }]
      const part = Math.trunc(total / 2)
      return [
        { personId: payer, cents: total - part },
        { personId: other, cents: part },
      ]
    }

    const seen = new Set<string>()
    let refused = 0
    for (let run = 0; run < 5000; run++) {
      const ctx = pick(contexts)
      const people = ctx.members.map((m) => m.personId)
      const kind = pick(KINDS[ctx.groupType])
      const refund = (kind === 'expense' || kind === 'bill') && chance(0.15)
      const amount = (max: number) => (refund ? -1 : 1) * int(max)
      const date = pick([d('2026-07-10'), d('2026-08-20'), d('2026-10-10')])
      const bill =
        kind === 'bill'
          ? {
              status: 'paid' as const,
              ...(chance(0.7) ? { periodStart: d('2026-07-01'), periodEnd: d('2026-09-30') } : {}),
            }
          : undefined
      const base = { kind, date, ...(bill ? { bill } : {}) }
      let input: ShareInput
      switch (kind) {
        case 'shift':
          input = { ...base, shift: { minutes: int(1440), rateCents: int(20_000) } }
          break
        case 'income':
          input = { ...base, totalCents: int(1_000_000) }
          break
        case 'payment': {
          const from = pick(people)
          input = {
            ...base,
            totalCents: int(1_000_000),
            payment: { fromPersonId: from, toPersonId: pick(people.filter((p) => p !== from)) },
          }
          break
        }
        case 'adjustment': {
          const a = pick(people)
          const total = int(100_000) * (chance(0.3) ? -1 : 1)
          const r = int(1000)
          const shares = [{ personId: a, givenCents: total, receivedCents: r }]
          const b = people.find((p) => p !== a)
          if (b) shares.push({ personId: b, givenCents: 0, receivedCents: total - r })
          else (shares[0] as Share).receivedCents = total
          input = { ...base, adjustment: { shares, reason: 'random' } }
          break
        }
        default: {
          const useItems = kind !== 'loan' && chance(0.3)
          if (useItems) {
            const items = Array.from({ length: 1 + int(4) }, (_, i) => {
              const amountCents = amount(200_000)
              return {
                name: `item ${i}`,
                amountCents,
                split: randomSplit(amountCents, people, kind === 'bill'),
              }
            })
            input = { ...base, items }
          } else {
            const total = amount(5_000_000)
            const split =
              chance(0.3) || ctx.groupType === 'employer'
                ? randomSplit(total, people, kind === 'bill')
                : undefined
            input = {
              ...base,
              totalCents: total,
              ...(split ? { split } : {}),
              ...(chance(0.5) ? { payers: randomPayers(total, people) } : {}),
            }
          }
        }
      }
      try {
        const { totalCents, shares } = build(input, ctx)
        assertShareInvariants({ kind, totalCents }, shares, people)
        if (input.totalCents !== undefined) expect(totalCents).toBe(input.totalCents)
        seen.add(`${ctx.groupType}:${kind}`)
      } catch (error) {
        // Random inputs can be legitimately refused (a days split nobody was
        // present for, a loan whose only person is the lender); never as a bug.
        expect(error).toBeInstanceOf(LedgerError)
        expect((error as LedgerError).code).toBe('VALIDATION_FAILED')
        refused++
      }
    }
    // Every allowed kind in every group type was built at least once.
    expect(seen.size).toBe(Object.values(KINDS).reduce((n, kinds) => n + kinds.length, 0))
    expect(refused).toBeLessThan(500)
  })

  it('a rule-breaking input is refused as bad input, never written', () => {
    const house: LedgerContext = {
      groupType: 'house',
      ownerPersonId: 'a',
      callerPersonId: 'a',
      members: [member('a'), member('b')],
    }
    let caught: unknown
    try {
      sharesOf(
        tx({
          kind: 'expense',
          totalCents: 100,
          split: { mode: 'exact', amounts: [{ personId: 'a', cents: 1 }] },
        }),
        house,
      )
    } catch (error) {
      caught = error
    }
    expect((caught as LedgerError).code).toBe('VALIDATION_FAILED')
  })
})
