import * as invariants from '@ledgerly/core/ledger/invariants'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, NOW, rows, seed } from './harness'

vi.mock('@ledgerly/core/ledger/invariants', async (importOriginal) => {
  const original = await importOriginal<typeof invariants>()
  return { assertShareInvariants: vi.fn(original.assertShareInvariants) }
})

const assertShareInvariants = vi.mocked(invariants.assertShareInvariants)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  assertShareInvariants.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('ledger invariants', () => {
  it('are checked with the shares and every member before a write', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    expect(assertShareInvariants).toHaveBeenCalledWith(
      { kind: 'expense', totalCents: 9000 },
      [
        { personId: 'alice', givenCents: 9000, receivedCents: 4500 },
        { personId: 'bob', givenCents: 0, receivedCents: 4500 },
      ],
      ['alice', 'bob', 'cara', 'pat', 'lee'],
    )
  })

  it.each([
    ['POST', '/transactions', () => expense({ id: 't2' })],
    ['PATCH', '/transactions/t1', () => expense({ totalCents: 9100 })],
    ['POST', '/transactions/b1/post', () => ({})],
  ])('stop %s %s with INVARIANT_VIOLATION, writing nothing', async (method, path, body) => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    await call(db, 'POST', '/transactions', {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 12000,
      bill: { status: 'due', dueOn: '2026-10-25' },
    })
    const before = JSON.stringify([rows.transactions(db), rows.shares(db), rows.activity(db)])
    assertShareInvariants.mockImplementationOnce(() => {
      throw new LedgerError('INVARIANT_VIOLATION', 'Ledger invariant I-1 (balanced) would break')
    })
    const response = await call(db, method, path, body())
    expect(response.status).toBe(500)
    expect(response.body.error?.code).toBe('INVARIANT_VIOLATION')
    expect(JSON.stringify([rows.transactions(db), rows.shares(db), rows.activity(db)])).toBe(before)
  })
})
