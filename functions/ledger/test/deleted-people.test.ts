import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

// Part 3 of #50 sets it when they delete their account.
function deleteAccount(db: Db, personId: string) {
  return withTransaction(db, (tx) =>
    tx.write({
      action: 'update',
      tableId: 'persons',
      rowId: personId,
      data: { deletedAt: '2026-10-17T00:00:00.000Z' },
    }),
  )
}

const refused = { status: 400, code: 'VALIDATION_FAILED' }

function outcome(response: Awaited<ReturnType<typeof call>>) {
  return response.status === 200
    ? { status: 200 }
    : { status: response.status, code: (response.body as { error: { code: string } }).error.code }
}

// functions-api.md#ledger ("Deleted people").
describe('a person who deleted their account, in a group they had joined', () => {
  it('can’t be named in a new expense', async () => {
    const db = seed()
    await deleteAccount(db, 'bob')
    expect(outcome(await call(db, 'POST', '/transactions', expense()))).toEqual(refused)
    expect(rows.transactions(db)).toEqual([])
  })

  it('can be named where they never joined (a placeholder), so nothing shows the deletion', async () => {
    const db = seed()
    await deleteAccount(db, 'pat')
    const withPat = expense({ split: { mode: 'equal', personIds: ['alice', 'pat'] } })
    expect(outcome(await call(db, 'POST', '/transactions', withPat))).toEqual({ status: 200 })
  })

  it('can still be paid or adjusted, so balances with them can be settled', async () => {
    const db = seed()
    await deleteAccount(db, 'bob')
    const payment = {
      id: 'p1',
      groupId: 'house',
      kind: 'payment',
      date: '2026-10-10',
      description: 'Settling up',
      totalCents: 4500,
      payment: { fromPersonId: 'alice', toPersonId: 'bob' },
    }
    expect(outcome(await call(db, 'POST', '/transactions', payment))).toEqual({ status: 200 })
    const adjustment = {
      id: 'a1',
      groupId: 'house',
      kind: 'adjustment',
      date: '2026-10-10',
      description: 'Fix',
      totalCents: 100,
      adjustment: {
        reason: 'Fix',
        shares: [
          { personId: 'alice', givenCents: 100, receivedCents: 0 },
          { personId: 'bob', givenCents: 0, receivedCents: 100 },
        ],
      },
    }
    expect(outcome(await call(db, 'POST', '/transactions', adjustment))).toEqual({ status: 200 })
  })

  it('stays on a transaction that already names them, which can still be changed', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    await deleteAccount(db, 'bob')
    const changed = expense({ description: 'Food', totalCents: 9500 })
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', changed))).toEqual({ status: 200 })
    expect(rows.transactions(db)[0]?.description).toBe('Food')
  })

  it('can’t be added to an existing transaction', async () => {
    const db = seed()
    const aliceOnly = expense({ split: { mode: 'equal', personIds: ['alice'] } })
    await call(db, 'POST', '/transactions', aliceOnly)
    await deleteAccount(db, 'bob')
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', expense()))).toEqual(refused)
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '').split.personIds).toEqual(['alice'])
  })

  it('stays on a due bill that names them, which can still be paid, but can’t become its payer', async () => {
    const db = seed()
    const bill = {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-12',
      description: 'Power',
      totalCents: 9000,
      bill: { status: 'due', dueOn: '2026-10-15' },
      split: { mode: 'equal', personIds: ['alice', 'cara'] },
    }
    await call(db, 'POST', '/transactions', bill)
    await call(db, 'POST', '/transactions', {
      ...bill,
      id: 'b2',
      split: { mode: 'equal', personIds: ['alice', 'bob'] },
    })
    await deleteAccount(db, 'bob')
    const bobPays = { payers: [{ personId: 'bob', cents: 9000 }] }
    expect(outcome(await call(db, 'POST', '/transactions/b1/post', bobPays))).toEqual(refused)
    expect(outcome(await call(db, 'POST', '/transactions/b2/post', {}))).toEqual({ status: 200 })
  })

  it('is refused when the deletion commits while the write is being made', async () => {
    const db = seed()
    // The deletion lands after the person's row is guarded, just before the commit.
    const commit = db.updateTransaction.bind(db)
    let done = false
    vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
      if (!done && params.commit) {
        done = true
        await deleteAccount(db, 'bob')
      }
      return commit(params)
    })
    expect(outcome(await call(db, 'POST', '/transactions', expense()))).toEqual(refused)
    expect(rows.transactions(db)).toEqual([])
  })
})
