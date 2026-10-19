import type { Members } from '@ledgerly/core/generated/rows'
import { describe, expect, it } from 'vitest'
import {
  defaultTicks,
  type HouseExpenseValues,
  previewShares,
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
    splitBetween: ['alice', 'bob', 'cara'],
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
