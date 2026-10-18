import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amounts, call, expense, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

/**
 * Runs `meanwhile` to completion just before the request's first staging, which is its guard:
 * another request that read the same row and committed first.
 */
function before(db: Db, meanwhile: () => Promise<unknown>) {
  const stage = db.createOperations.bind(db)
  vi.spyOn(db, 'createOperations').mockImplementationOnce(async (params) => {
    await meanwhile()
    return stage(params)
  })
}

const withCara = expense({ split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] } })

describe('a request that read the row before another one committed', () => {
  it('two identical edits leave one share per person (I-5)', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    before(db, () => call(db, 'PATCH', '/transactions/t1', withCara))
    const response = await call(db, 'PATCH', '/transactions/t1', withCara)
    expect(response.status).toBe(200)
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 9000, receivedCents: 3000 },
      { personId: 'bob', givenCents: 0, receivedCents: 3000 },
      { personId: 'cara', givenCents: 0, receivedCents: 3000 },
    ])
  })

  it('a void deletes the shares an edit added meanwhile (I-6)', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    before(db, () => call(db, 'PATCH', '/transactions/t1', withCara))
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.status).toBe('void')
    expect(rows.shares(db)).toEqual([])
  })

  it('a post uses the items an edit changed meanwhile', async () => {
    const bill = (amountCents: number) => ({
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      bill: { status: 'due', dueOn: '2026-10-25' },
      items: [
        { name: 'Usage', amountCents, split: { mode: 'equal', personIds: ['alice', 'bob'] } },
      ],
    })
    const db = seed()
    await call(db, 'POST', '/transactions', bill(1000))
    before(db, () => call(db, 'PATCH', '/transactions/b1', bill(5000)))
    const response = await call(db, 'POST', '/transactions/b1/post', {})
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({ status: 'posted', totalCents: 5000 })
    expect(rows.items(db)).toMatchObject([{ amountCents: 5000 }])
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 5000, receivedCents: 2500 },
      { personId: 'bob', givenCents: 0, receivedCents: 2500 },
    ])
  })

  it('a post that lost to a void is refused, not applied', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 12000,
      bill: { status: 'due', dueOn: '2026-10-25' },
    })
    before(db, () => call(db, 'POST', '/transactions/b1/void', { reason: 'Wrong' }))
    const response = await call(db, 'POST', '/transactions/b1/post', {})
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.status).toBe('void')
    expect(rows.shares(db)).toEqual([])
  })
})
