import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { describe, expect, it } from 'vitest'
import { type EntryValues, readStored, toEntryBody, toEntryValues } from './presets'

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

/** A posted row as the ledger stores this body: its own columns, and the rest in `inputJson`. */
function stored(body: ReturnType<typeof toEntryBody>) {
  const { kind, date, description, totalCents, category, payers, split, payment, note } = body
  return {
    kind,
    date,
    description,
    totalCents: totalCents as number,
    category: category ?? null,
    inputJson: JSON.stringify({ payers, split, payment, note }),
  }
}

describe('toEntryValues', () => {
  it.each([
    ['reimbursable', 'work'],
    ['onTheirCard', 'transport'],
    ['personalOnTheirCard', ''],
    ['paymentReceived', ''],
  ] as const)('gives %s back, so saving it unchanged sends the stored input', (type, category) => {
    const values: EntryValues = {
      type,
      amount: '1234.50',
      date: '2026-10-18',
      description: 'Supplies',
      category,
      note: 'Receipt 12',
    }
    const body = toEntryBody(values, IDS, 'AUD', PEOPLE)
    const back = toEntryValues(stored(body), PEOPLE, 'AUD')
    expect(back).toEqual(values)
    expect(toEntryBody(back as EntryValues, IDS, 'AUD', PEOPLE)).toEqual(body)
  })

  it('reads a row with no note, and an amount in a currency without cents', () => {
    const body = toEntryBody({ ...BASE, amount: '2500', category: '' }, IDS, 'JPY', PEOPLE)
    expect(toEntryValues(stored(body), PEOPLE, 'JPY')).toMatchObject({ amount: '2500', note: '' })
  })

  it.each([
    ['a payment the other way', 'payment', { payment: { fromPersonId: 'pw', toPersonId: 'pe' } }],
    ['a payment with no payment', 'payment', {}],
    ['a loan', 'loan', { payers: [{ personId: 'pw', cents: 4000 }] }],
    [
      'two payers',
      'expense',
      {
        payers: [
          { personId: 'pw', cents: 2000 },
          { personId: 'pe', cents: 2000 },
        ],
      },
    ],
    ['a payer of part of it', 'expense', { payers: [{ personId: 'pw', cents: 3000 }] }],
    [
      'a split that isn’t equal',
      'expense',
      {
        payers: [{ personId: 'pw', cents: 4000 }],
        split: { mode: 'exact', amounts: [{ personId: 'pe', cents: 4000 }] },
      },
    ],
    [
      'an equal split of two',
      'expense',
      {
        payers: [{ personId: 'pw', cents: 4000 }],
        split: { mode: 'equal', personIds: ['pw', 'pe'] },
      },
    ],
    [
      'the worker paying for themselves',
      'expense',
      {
        payers: [{ personId: 'pw', cents: 4000 }],
        split: { mode: 'equal', personIds: ['pw'] },
      },
    ],
    [
      'someone else',
      'expense',
      {
        payers: [{ personId: 'px', cents: 4000 }],
        split: { mode: 'equal', personIds: ['pe'] },
      },
    ],
  ] as const)('matches no choice for %s', (_, kind, input) => {
    const row = {
      kind,
      date: '2026-10-18',
      description: 'Supplies',
      totalCents: 4000,
      category: null,
      inputJson: JSON.stringify(input),
    }
    expect(toEntryValues(row, PEOPLE, 'AUD')).toBeUndefined()
  })
})

describe('readStored', () => {
  it('reads an empty input for JSON that isn’t an object, or isn’t JSON', () => {
    expect(readStored('null')).toEqual({})
    expect(readStored('{')).toEqual({})
    expect(readStored('{"note":"Hi"}')).toEqual({ note: 'Hi' })
  })
})
