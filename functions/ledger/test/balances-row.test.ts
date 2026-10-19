import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import { balancesFromShares } from '@ledgerly/core/settle/balances'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, member, NOW, rows, seed } from './harness'

// ledger.md#balances: every write of shares keeps the group's `balances` row.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Db = ReturnType<typeof seed>

const EMPTY = [{ $id: 'house', peopleJson: '[]' }]

/** The house's stored row, as people. */
function stored(db: Db, groupId = 'house') {
  const row = db.rows('balances').find((balances) => balances.$id === groupId)
  return row && JSON.parse(String(row.peopleJson))
}

/** What a fresh sum of the group's shares builds. */
function fresh(db: Db, groupId = 'house') {
  return balancesFromShares(rows.shares(db).filter((share) => share.groupId === groupId))
}

/** The operations each request staged, by table, from here on. */
function staged(db: Db) {
  const spy = vi.spyOn(db, 'createOperations')
  return () =>
    spy.mock.calls.flatMap(([params]) =>
      (params.operations as { tableId: string }[]).map((operation) => operation.tableId),
    )
}

/** Another request's transaction, committed at once. */
async function commitNow(db: Db, operations: object[]) {
  const { $id } = await db.createTransaction()
  await db.createOperations({ transactionId: $id, operations })
  await db.updateTransaction({ transactionId: $id, commit: true })
}

function create(tableId: string, rowId: string, data: Record<string, unknown>) {
  const { $id: _, ...columns } = data
  return { action: 'create', databaseId: 'main', tableId, rowId, data: columns }
}

const withCara = expense({ split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] } })

describe('the balances row', () => {
  it('follows a create, an edit and a void', async () => {
    const db = seed({ balances: EMPTY })
    await call(db, 'POST', '/transactions', expense())
    expect(stored(db)).toEqual([
      { personId: 'alice', netCents: 4500, shares: 1 },
      { personId: 'bob', netCents: -4500, shares: 1 },
    ])
    await call(db, 'PATCH', '/transactions/t1', withCara)
    expect(stored(db)).toEqual([
      { personId: 'alice', netCents: 6000, shares: 1 },
      { personId: 'bob', netCents: -3000, shares: 1 },
      { personId: 'cara', netCents: -3000, shares: 1 },
    ])
    await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(stored(db)).toEqual([])
  })

  it('follows a post', async () => {
    const db = seed({ balances: EMPTY })
    const bill = {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-17',
      description: 'Electricity',
      totalCents: 9000,
      bill: { status: 'due', dueOn: '2026-10-17' },
      split: { mode: 'equal', personIds: ['alice', 'bob'] },
    }
    await call(db, 'POST', '/transactions', bill)
    // A due bill has no shares yet.
    expect(stored(db)).toEqual([])
    expect((await call(db, 'POST', '/transactions/b1/post', {})).status).toBe(200)
    expect(stored(db)).toEqual(fresh(db))
    expect(stored(db)).toEqual([
      { personId: 'alice', netCents: 4500, shares: 1 },
      { personId: 'bob', netCents: -4500, shares: 1 },
    ])
  })

  it('follows a timer stop', async () => {
    const db = seed({ balances: [{ $id: 'job', peopleJson: '[]' }] })
    await call(db, 'POST', '/timer/start', { id: 'sh1', groupId: 'job' }, 'u-sam')
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60 * 60 * 1000))
    const response = await call(db, 'POST', '/timer/stop', { transactionId: 'sh1' }, 'u-sam')
    expect(response.status).toBe(200)
    expect(stored(db, 'job')).toEqual(fresh(db, 'job'))
    expect(stored(db, 'job')).toEqual([
      { personId: 'acme', netCents: -5000, shares: 1 },
      { personId: 'sam', netCents: 5000, shares: 1 },
    ])
  })

  it('isn’t written by an edit that changes no share, or a timer start', async () => {
    const db = seed({ balances: EMPTY })
    await call(db, 'POST', '/transactions', expense())
    const tables = staged(db)
    await call(db, 'PATCH', '/transactions/t1', expense({ description: 'Food' }))
    await call(db, 'POST', '/timer/start', { id: 'sh1', groupId: 'job' }, 'u-sam')
    expect(tables()).not.toContain('balances')
    expect(rows.transactions(db).find((row) => row.$id === 't1')?.description).toBe('Food')
  })

  it('stays missing for a group that has none yet', async () => {
    const db = seed()
    const tables = staged(db)
    await call(db, 'POST', '/transactions', expense())
    await call(db, 'PATCH', '/transactions/t1', withCara)
    await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(tables()).not.toContain('balances')
    expect(db.rows('balances')).toEqual([])
  })

  it('is deleted when it doesn’t fit, and the write still goes through', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = seed({ balances: EMPTY })
    await call(db, 'POST', '/transactions', withCara)
    // A wrong row: Bob and Cara aren't in it, so taking their shares off can't fit.
    const wrong = [{ personId: 'alice', netCents: 0, shares: 1 }]
    await commitNow(db, [
      {
        action: 'update',
        databaseId: 'main',
        tableId: 'balances',
        rowId: 'house',
        data: { peopleJson: JSON.stringify(wrong) },
      },
    ])
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.status).toBe('void')
    expect(db.rows('balances')).toEqual([])
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ event: 'balances_row_deleted', groupId: 'house' }),
    ])
  })

  it('runs a write again when another write commits after it read the row', async () => {
    const db = seed({ balances: EMPTY })
    await call(db, 'POST', '/transactions', expense())
    const get = db.getRow.bind(db)
    let reads = 0
    vi.spyOn(db, 'getRow').mockImplementation(async (params) => {
      const row = await get(params)
      // Bob's own expense commits just after the void read the row.
      if (params.tableId === 'balances' && ++reads === 1) {
        await call(db, 'POST', '/transactions', expense({ id: 't2', totalCents: 3000 }), 'u-bob')
      }
      return row
    })
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(response.status).toBe(200)
    // The void read the row again, with Bob's expense in it.
    expect(stored(db)).toEqual(fresh(db))
    expect(stored(db)).toEqual([
      { personId: 'alice', netCents: -1500, shares: 1 },
      { personId: 'bob', netCents: 1500, shares: 1 },
    ])
  })

  it('fits the biggest edit, 15 people to 15 others with 30 items, in 65 writes', async () => {
    const people = Array.from({ length: 30 }, (_, index) => `p${String(index).padStart(2, '0')}`)
    const db = seed({ balances: EMPTY })
    // 30 placeholders in the house.
    for (const personId of people) {
      await commitNow(db, [
        create('persons', personId, { userId: null, displayName: personId }),
        create('members', `m-${personId}`, member('', 'house', personId, 'member', 'placeholder')),
      ])
    }
    const receipt = (payer: string, split: string[]) =>
      expense({
        totalCents: undefined,
        payers: [{ personId: payer, cents: 30 * 140 }],
        split: undefined,
        items: Array.from({ length: 30 }, (_, index) => ({
          name: `Item ${index}`,
          amountCents: 140,
          split: { mode: 'equal', personIds: split },
        })),
      })
    const created = await call(db, 'POST', '/transactions', receipt('p00', people.slice(1, 15)))
    expect(created.status).toBe(200)
    const tables = staged(db)
    const edited = await call(db, 'PATCH', '/transactions/t1', receipt('p15', people.slice(16, 30)))
    expect(edited.status).toBe(200)
    expect(tables()).toHaveLength(65)
    expect(tables().filter((table) => table === 'balances')).toHaveLength(1)
    expect(65).toBeLessThanOrEqual(MAX_OPS_PER_DB_TRANSACTION)
    expect(stored(db)).toEqual(fresh(db))
    expect(stored(db).map((person: { personId: string }) => person.personId)).toEqual(
      people.slice(15),
    )
  })
})
