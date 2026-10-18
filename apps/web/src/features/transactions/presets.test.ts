import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { describe, expect, it } from 'vitest'
import { type EntryValues, toEntryBody } from './presets'

const PEOPLE = { worker: 'pw', employer: 'pe' }
const IDS = { id: 'x1', groupId: 'g1' }
const BASE: EntryValues = {
  type: 'reimbursable',
  amount: '40.00',
  date: '2026-10-18',
  description: ' Supplies ',
  category: 'work',
  note: '',
}

describe('toEntryBody', () => {
  it.each([
    // ledger.md#employer-presets: payers, then who it's for.
    ['reimbursable', 'pw', 'pe'],
    ['onTheirCard', 'pe', 'pe'],
    ['personalOnTheirCard', 'pe', 'pw'],
  ] as const)('sends %s as an expense paid by %s, for %s', (type, payer, forWhom) => {
    const body = toEntryBody({ ...BASE, type }, IDS, 'AUD', PEOPLE)
    expect(body).toEqual({
      id: 'x1',
      groupId: 'g1',
      kind: 'expense',
      date: '2026-10-18',
      description: 'Supplies',
      totalCents: 4000,
      category: 'work',
      payers: [{ personId: payer, cents: 4000 }],
      split: { mode: 'equal', personIds: [forWhom] },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('sends a payment received from the employer to the worker, with no payers or category', () => {
    const body = toEntryBody(
      { ...BASE, type: 'paymentReceived', amount: '500', note: ' Bank transfer ' },
      IDS,
      'AUD',
      PEOPLE,
    )
    expect(body).toEqual({
      id: 'x1',
      groupId: 'g1',
      kind: 'payment',
      date: '2026-10-18',
      description: 'Supplies',
      totalCents: 50000,
      note: 'Bank transfer',
      payment: { fromPersonId: 'pe', toPersonId: 'pw' },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('leaves out an empty category and note, and uses the currency’s minor unit', () => {
    const body = toEntryBody({ ...BASE, category: '', amount: '2500' }, IDS, 'JPY', PEOPLE)
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('note')
    expect(body.totalCents).toBe(2500)
  })

  it('sends NaN for an amount that isn’t one, so the schema refuses it', () => {
    const body = toEntryBody({ ...BASE, amount: '12.345' }, IDS, 'AUD', PEOPLE)
    expect(body.totalCents).toBeNaN()
    expect(transactionInputSchema.safeParse(body).success).toBe(false)
  })
})
