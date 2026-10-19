import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { describe, expect, it } from 'vitest'
import {
  type BillValues,
  isOverdue,
  monthsBefore,
  storedExtras,
  toBillBody,
  toBillValues,
} from './bill-values'

const BASE: BillValues = {
  description: ' Phone ',
  category: 'phone',
  amount: '45.50',
  dueOn: '2026-10-25',
  paid: false,
  paidOn: '',
}

const IDS = { id: 'b1', groupId: 'g1' }

describe('toBillBody', () => {
  it('sends an unpaid bill as due, dated on its due date', () => {
    const body = toBillBody(BASE, IDS, 'AUD')
    expect(body).toStrictEqual({
      id: 'b1',
      groupId: 'g1',
      kind: 'bill',
      description: 'Phone',
      category: 'phone',
      totalCents: 4550,
      date: '2026-10-25',
      bill: { status: 'due', dueOn: '2026-10-25' },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('sends a bill already paid as paid, dated on the day it was paid', () => {
    const body = toBillBody({ ...BASE, paid: true, paidOn: '2026-10-18' }, IDS, 'AUD')
    expect(body).toMatchObject({ date: '2026-10-18', bill: { status: 'paid' } })
    expect(body.bill).toStrictEqual({ status: 'paid' })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('leaves out an empty category, and makes an amount that isn’t one NaN', () => {
    const body = toBillBody({ ...BASE, category: '', amount: 'lots' }, IDS, 'AUD')
    expect('category' in body).toBe(false)
    expect(body.totalCents).toBeNaN()
  })

  it('reads a currency without cents in whole units', () => {
    expect(toBillBody({ ...BASE, amount: '4550' }, IDS, 'JPY').totalCents).toBe(4550)
  })
})

describe('toBillValues', () => {
  it('starts an edit from the stored bill’s columns', () => {
    expect(
      toBillValues(
        { description: 'Phone', date: '2026-10-25', dueOn: '2026-10-25', category: 'phone' },
        '45.50',
      ),
    ).toStrictEqual({ ...BASE, description: 'Phone' })
  })

  it('falls back to the date, and no category for one it doesn’t know', () => {
    expect(
      toBillValues(
        { description: 'Gas', date: '2026-11-02', dueOn: null, category: 'other-thing' },
        '10.00',
      ),
    ).toMatchObject({ dueOn: '2026-11-02', category: '' })
  })
})

describe('storedExtras', () => {
  it('reads the split, note and billing period, and sends them back', () => {
    const split = { mode: 'equal' as const, personIds: ['p1'] }
    const kept = storedExtras(
      JSON.stringify({
        split,
        note: 'Account 123',
        bill: { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
      }),
    )
    expect(kept).toStrictEqual({
      split,
      note: 'Account 123',
      period: { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
    })
    const body = toBillBody(BASE, IDS, 'AUD', kept)
    expect(body).toMatchObject({
      split,
      note: 'Account 123',
      bill: { status: 'due', dueOn: '2026-10-25', periodStart: '2026-09-01' },
    })
    expect(transactionInputSchema.safeParse(body).success).toBe(true)
  })

  it('keeps nothing from what the ledger stores for a plain bill, or what it can’t read', () => {
    expect(storedExtras(JSON.stringify({ bill: {} }))).toStrictEqual({})
    expect(storedExtras(JSON.stringify({ split: { mode: 'nope' }, note: '' }))).toStrictEqual({})
    expect(storedExtras('not json')).toStrictEqual({})
    expect(storedExtras('null')).toStrictEqual({})
  })
})

describe('isOverdue', () => {
  it('is overdue only before today', () => {
    expect(isOverdue('2026-10-18', '2026-10-19')).toBe(true)
    expect(isOverdue('2026-10-19', '2026-10-19')).toBe(false)
    expect(isOverdue('2026-10-20', '2026-10-19')).toBe(false)
  })
})

describe('monthsBefore', () => {
  it('goes back whole months, across a year', () => {
    expect(monthsBefore('2026-10-19', 3)).toBe('2026-07-19')
    expect(monthsBefore('2026-02-10', 3)).toBe('2025-11-10')
  })

  it('stops at the end of a shorter month', () => {
    expect(monthsBefore('2026-05-31', 3)).toBe('2026-02-28')
    expect(monthsBefore('2028-05-31', 3)).toBe('2028-02-29')
    expect(monthsBefore('2026-07-31', 1)).toBe('2026-06-30')
  })
})
