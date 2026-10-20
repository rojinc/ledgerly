import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { buildShares } from '@ledgerly/core/ledger/build-shares'
import { reportByMonth } from '@ledgerly/core/reports/personal-report'
import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { describe, expect, it } from 'vitest'
import {
  type EntryValues,
  readStored,
  toEntryBody,
  toEntryValues,
  toPersonalBody,
  toPersonalValues,
} from './presets'

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

  it('matches no choice for a payment with a category, or an empty note, which saving would drop', () => {
    const payment = toEntryBody({ ...BASE, type: 'paymentReceived' }, IDS, 'AUD', PEOPLE)
    expect(toEntryValues({ ...stored(payment), category: 'work' }, PEOPLE, 'AUD')).toBeUndefined()
    const expense = toEntryBody(BASE, IDS, 'AUD', PEOPLE)
    const { payers, split } = expense
    expect(
      toEntryValues(
        { ...stored(expense), inputJson: JSON.stringify({ payers, split, note: '' }) },
        PEOPLE,
        'AUD',
      ),
    ).toBeUndefined()
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
      // The other person first, so only the head count refuses it.
      'an equal split of two',
      'expense',
      {
        payers: [{ personId: 'pw', cents: 4000 }],
        split: { mode: 'equal', personIds: ['pe', 'pw'] },
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

// #402: the personal group's owner, Sam, is its only member.
const ME = 'pw'
const MINE = { id: 'x1', groupId: 'me1' }
const INCOME: EntryValues = {
  type: 'income',
  // Not a whole number of cents as a float (19.99 × 100 = 1998.999…): core parses it exactly.
  amount: '19.99',
  date: '2026-10-19',
  description: ' Tax refund ',
  category: '',
  note: ' ATO ',
}

describe('toPersonalBody', () => {
  it('sends income with no payers or split: the owner gives and gets it all (ledger.md)', () => {
    const body = toPersonalBody(INCOME, MINE, 'AUD', ME)
    expect(body).toEqual({
      id: 'x1',
      groupId: 'me1',
      kind: 'income',
      date: '2026-10-19',
      description: 'Tax refund',
      totalCents: 1999,
      note: 'ATO',
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('sends an expense paid by the owner, for the owner, with its category', () => {
    const body = toPersonalBody(
      { ...INCOME, type: 'expense', description: 'Groceries', category: 'groceries', note: '' },
      MINE,
      'AUD',
      ME,
    )
    expect(body).toEqual({
      id: 'x1',
      groupId: 'me1',
      kind: 'expense',
      date: '2026-10-19',
      description: 'Groceries',
      totalCents: 1999,
      category: 'groceries',
      payers: [{ personId: 'pw', cents: 1999 }],
      split: { mode: 'equal', personIds: ['pw'] },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('sends NaN for an amount that isn’t one, so the schema refuses it', () => {
    const body = toPersonalBody({ ...INCOME, amount: '19.999' }, MINE, 'AUD', ME)
    expect(body.totalCents).toBeNaN()
    expect(transactionInputSchema.safeParse(body).success).toBe(false)
  })

  // The dashboard reads the user's shares with reportByMonth() (features/dashboard), so shares
  // built from these bodies are what its personal lines show.
  it('gives shares the dashboard counts as personal income and as spending', () => {
    const ctx = {
      groupType: 'personal' as const,
      ownerPersonId: ME,
      callerPersonId: ME,
      members: [{ personId: ME, joinedOn: '2026-01-01' as LocalDate, leftOn: null }],
    }
    const shares = (['income', 'expense'] as const).flatMap((type) => {
      const body = toPersonalBody({ ...INCOME, type, category: 'other' }, MINE, 'AUD', ME)
      const input = transactionInputSchema.parse(body)
      const built = buildShares({ ...input, date: input.date as LocalDate }, ctx)
      return built.shares.map((share) => ({
        ...share,
        groupId: 'me1',
        date: input.date,
        kind: input.kind,
        category: input.category ?? null,
      }))
    })
    // ledger.md#transaction-kinds: the owner gives and gets each total, so the nets are 0.
    expect(shares.map(({ givenCents, receivedCents }) => [givenCents, receivedCents])).toEqual([
      [1999, 1999],
      [1999, 1999],
    ])
    const [month] = reportByMonth(ME, shares as never, [
      { id: 'me1', type: 'personal', currency: 'AUD' },
    ])
    expect(month?.reports[0]).toMatchObject({
      personalIncomeCents: 1999,
      incomeCents: 1999,
      spendingCents: 1999,
      spendingByCategory: { other: 1999 },
    })
  })
})

describe('toPersonalValues', () => {
  it.each([
    ['income', ''],
    ['income', 'work'],
    ['expense', 'groceries'],
    ['expense', ''],
  ] as const)(
    'gives %s (category “%s”) back, so saving it unchanged sends the stored input',
    (type, category) => {
      const values: EntryValues = { ...INCOME, type, category, description: 'Refund', note: 'ATO' }
      const body = toPersonalBody(values, MINE, 'AUD', ME)
      const back = toPersonalValues(stored(body), ME, 'AUD')
      expect(back).toEqual(values)
      expect(toPersonalBody(back as EntryValues, MINE, 'AUD', ME)).toEqual(body)
    },
  )

  it('reads a row with no note, and an amount in a currency without cents', () => {
    const body = toPersonalBody({ ...INCOME, amount: '2500', note: '' }, MINE, 'JPY', ME)
    expect(toPersonalValues(stored(body), ME, 'JPY')).toMatchObject({ amount: '2500', note: '' })
  })

  const paidByMe = { payers: [{ personId: 'pw', cents: 4000 }] }
  it.each([
    ['an expense with no payers or split', 'expense', 4000, {}],
    ['an expense with no split', 'expense', 4000, paidByMe],
    [
      'someone else paying',
      'expense',
      4000,
      { payers: [{ personId: 'px', cents: 4000 }], split: { mode: 'equal', personIds: ['pw'] } },
    ],
    [
      'a payer of part of it',
      'expense',
      4000,
      { payers: [{ personId: 'pw', cents: 3000 }], split: { mode: 'equal', personIds: ['pw'] } },
    ],
    [
      'a split for someone else',
      'expense',
      4000,
      { ...paidByMe, split: { mode: 'equal', personIds: ['px'] } },
    ],
    [
      'a split for them and someone else',
      'expense',
      4000,
      { ...paidByMe, split: { mode: 'equal', personIds: ['pw', 'px'] } },
    ],
    [
      'a split that isn’t equal',
      'expense',
      4000,
      { ...paidByMe, split: { mode: 'exact', amounts: [{ personId: 'pw', cents: 4000 }] } },
    ],
    [
      'a refund',
      'expense',
      -4000,
      { payers: [{ personId: 'pw', cents: -4000 }], split: { mode: 'equal', personIds: ['pw'] } },
    ],
    ['an income of 0', 'income', 0, {}],
    ['an empty note', 'income', 4000, { note: '' }],
    ['a bill', 'bill', 4000, {}],
    ['an adjustment', 'adjustment', 4000, {}],
  ] as const)('matches no choice for %s', (_, kind, totalCents, input) => {
    const row = {
      kind,
      date: '2026-10-18',
      description: 'Groceries',
      totalCents,
      category: null,
      inputJson: JSON.stringify(input),
    }
    expect(toPersonalValues(row, ME, 'AUD')).toBeUndefined()
  })
})

describe('readStored', () => {
  it('reads an empty input for JSON that isn’t an object, or isn’t JSON', () => {
    expect(readStored('null')).toEqual({})
    expect(readStored('{')).toEqual({})
    expect(readStored('{"note":"Hi"}')).toEqual({ note: 'Hi' })
  })
})
