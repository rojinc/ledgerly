import { createGroupBodySchema } from '@ledgerly/core/schemas/groups'
import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { describe, expect, it } from 'vitest'
import {
  balanceText,
  debtor,
  type EntryValues,
  owedBy,
  toEntryBody,
  toPairBody,
} from './pair-values'

const ids = { id: 't1', groupId: 'g1' }
const people = { me: 'p1', them: 'p2' }

function entry(extra: Partial<EntryValues>): EntryValues {
  return {
    type: 'lent',
    amount: '50',
    date: '2026-10-19',
    description: '',
    note: '',
    from: 'them',
    ...extra,
  }
}

describe('toPairBody', () => {
  it('makes a pair group whose counterpart is the person named', () => {
    const body = toPairBody(
      { name: ' Sam ', email: ' sam@example.com ', phone: '', currency: 'aud' },
      'g1',
    )
    expect(body).toStrictEqual({
      id: 'g1',
      type: 'pair',
      name: 'Sam',
      currency: 'AUD',
      counterpart: { displayName: 'Sam', email: 'sam@example.com' },
    })
    expect(createGroupBodySchema.safeParse(body).success).toBe(true)
  })

  it('leaves out an email and phone that weren’t given', () => {
    const body = toPairBody(
      { name: 'Sam', email: '', phone: '+61 400 000 000', currency: 'AUD' },
      'g1',
    )
    expect(body.counterpart).toStrictEqual({ displayName: 'Sam', phone: '+61 400 000 000' })
  })
})

describe('toEntryBody', () => {
  it('records money lent as a loan the user pays and the other person gets', () => {
    const body = toEntryBody(entry({ amount: '50' }), ids, 'AUD', people)
    expect(body).toStrictEqual({
      id: 't1',
      groupId: 'g1',
      date: '2026-10-19',
      description: 'Lent',
      totalCents: 5000,
      kind: 'loan',
      payers: [{ personId: 'p1', cents: 5000 }],
      split: { mode: 'equal', personIds: ['p2'] },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('records money borrowed with the two people swapped', () => {
    const body = toEntryBody(
      entry({ type: 'borrowed', amount: '20.50', description: ' Taxi ', note: ' Friday ' }),
      ids,
      'AUD',
      people,
    )
    expect(body).toMatchObject({
      kind: 'loan',
      description: 'Taxi',
      note: 'Friday',
      totalCents: 2050,
      payers: [{ personId: 'p2', cents: 2050 }],
      split: { mode: 'equal', personIds: ['p1'] },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it.each([
    ['them', 'p2', 'p1'],
    ['me', 'p1', 'p2'],
  ] as const)('records a repayment by %s as a payment with no payers', (from, payer, payee) => {
    const body = toEntryBody(entry({ type: 'repaid', amount: '30', from }), ids, 'AUD', people)
    expect(body).toStrictEqual({
      id: 't1',
      groupId: 'g1',
      date: '2026-10-19',
      description: 'Repaid',
      totalCents: 3000,
      kind: 'payment',
      payment: { fromPersonId: payer, toPersonId: payee },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('reads the amount in the group’s currency, and NaN for text that isn’t one', () => {
    expect(toEntryBody(entry({ amount: '4050' }), ids, 'JPY', people).totalCents).toBe(4050)
    expect(toEntryBody(entry({ amount: '40.5.0' }), ids, 'AUD', people).totalCents).toBeNaN()
  })
})

describe('balanceText', () => {
  it('words the balance from the viewer’s side', () => {
    // Sam owes the user $50: the user's net is +5000, Sam's is −5000.
    expect(balanceText(5000, 'Sam', 'AUD')).toMatch(/^Sam owes you .*50\.00$/)
    expect(balanceText(-5000, 'Alex', 'AUD')).toMatch(/^You owe Alex .*50\.00$/)
    expect(balanceText(0, 'Sam', 'AUD')).toBe('All square')
  })
})

describe('repayment defaults', () => {
  it('has the one who owes repay what they owe', () => {
    expect(debtor(5000)).toBe('them')
    expect(debtor(-2000)).toBe('me')
    expect(debtor(0)).toBe('them')
    expect(owedBy('them', 5000)).toBe(5000)
    expect(owedBy('me', 5000)).toBe(0)
    expect(owedBy('me', -2000)).toBe(2000)
    expect(owedBy('them', -2000)).toBe(0)
  })
})
