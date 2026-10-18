import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Balances } from '../src/routes/balances'
import { call, expense, GROUPS, NOW, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

const balances = (db: Db, groupId = 'house', user: string | null = 'u-alice') =>
  call<Balances>(db, 'GET', `/groups/${groupId}/balances`, undefined, user)

/** Another request's transaction, committed at once. */
async function commitNow(db: Db, operations: object[]) {
  const { $id } = await db.createTransaction()
  await db.createOperations({ transactionId: $id, operations })
  await db.updateTransaction({ transactionId: $id, commit: true })
}

const share = (
  $id: string,
  transactionId: string,
  personId: string,
  givenCents: number,
  receivedCents: number,
) => ({
  $id,
  transactionId,
  personId,
  givenCents,
  receivedCents,
  groupId: 'house',
  date: '2026-10-01',
  kind: 'payment',
  category: null,
})

/**
 * 51 payments of $1.00 from Bob to Alice: 102 share rows, so two pages. t0–t49 have theirs side
 * by side. t50's are the first row and the last, so they are on different pages.
 */
function manyShares() {
  const pairs = Array.from({ length: 50 }, (_, index) => [
    share(`s${index}a`, `t${index}`, 'alice', 0, 100),
    share(`s${index}b`, `t${index}`, 'bob', 100, 0),
  ])
  return [
    share('first', 't50', 'alice', 0, 100),
    ...pairs.flat(),
    share('last', 't50', 'bob', 100, 0),
  ]
}

const deleteShares = (...ids: string[]) =>
  ids.map((rowId) => ({ action: 'delete', databaseId: 'main', tableId: 'shares', rowId }))

describe('GET /groups/{groupId}/balances', () => {
  it('nets each person’s shares and suggests the transfers that settle them', async () => {
    const db = seed()
    // Alice pays $90 for three; Bob pays $30 for two.
    await call(
      db,
      'POST',
      '/transactions',
      expense({ split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] } }),
    )
    await call(
      db,
      'POST',
      '/transactions',
      expense({
        id: 't2',
        totalCents: 3000,
        split: { mode: 'equal', personIds: ['alice', 'bob'] },
      }),
      'u-bob',
    )
    const response = await balances(db)
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      people: [
        { personId: 'alice', netCents: 4500 },
        { personId: 'bob', netCents: -1500 },
        { personId: 'cara', netCents: -3000 },
      ],
      transfers: [
        { fromPersonId: 'cara', toPersonId: 'alice', cents: 3000 },
        { fromPersonId: 'bob', toPersonId: 'alice', cents: 1500 },
      ],
    })
  })

  it('leaves out voided transactions and other groups', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    await call(db, 'POST', '/transactions', expense({ id: 't2' }))
    await call(db, 'POST', '/transactions/t2/void', { reason: 'Duplicate' })
    const shift = {
      id: 'sh1',
      groupId: 'job',
      kind: 'shift',
      date: '2026-10-17',
      description: 'Shift',
      shift: { minutes: 120, rateCents: 2500 },
    }
    await call(db, 'POST', '/transactions', shift, 'u-sam')
    expect((await balances(db)).body.data?.people).toEqual([
      { personId: 'alice', netCents: 4500 },
      { personId: 'bob', netCents: -4500 },
    ])
    expect((await balances(db, 'job', 'u-sam')).body.data).toEqual({
      people: [
        { personId: 'acme', netCents: -5000 },
        { personId: 'sam', netCents: 5000 },
      ],
      transfers: [{ fromPersonId: 'acme', toPersonId: 'sam', cents: 5000 }],
    })
  })

  it('is empty for a group with no shares', async () => {
    expect((await balances(seed())).body.data).toEqual({ people: [], transfers: [] })
  })

  it('reads all the shares, a page at a time', async () => {
    const db = seed({ shares: manyShares() })
    expect((await balances(db)).body.data).toEqual({
      people: [
        { personId: 'alice', netCents: -5100 },
        { personId: 'bob', netCents: 5100 },
      ],
      transfers: [{ fromPersonId: 'alice', toPersonId: 'bob', cents: 5100 }],
    })
  })

  it('reads again when a write between two pages tears the read', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    let pages = 0
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      // t50 is voided after page 1, which had its first share; page 2 misses its last one.
      if (params.tableId === 'shares' && ++pages === 2) {
        await commitNow(db, deleteShares('first', 'last'))
      }
      return list(params)
    })
    const response = await balances(db)
    expect(response.status).toBe(200)
    expect(response.body.data?.people).toEqual([
      { personId: 'alice', netCents: -5000 },
      { personId: 'bob', netCents: 5000 },
    ])
    expect(pages).toBe(4)
  })

  it('reads again when the row a page ended on was deleted before the next page', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    let page = 0
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares' && ++page === 2) {
        // t49 is voided: its first share is the row page 1 ended on.
        await commitNow(db, deleteShares('s49a', 's49b'))
      }
      return list(params)
    })
    const response = await balances(db)
    expect(response.body.data?.people).toEqual([
      { personId: 'alice', netCents: -5000 },
      { personId: 'bob', netCents: 5000 },
    ])
  })

  it('gives CONFLICT when every read is torn that way', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      if (
        params.tableId === 'shares' &&
        params.queries?.some((query) => query.includes('cursorAfter'))
      ) {
        throw new AppwriteException('Cursor row not found', 400, 'general_cursor_not_found')
      }
      return list(params)
    })
    expect((await balances(db)).body.error?.code).toBe('CONFLICT')
  })

  it('reports shares that never add up as INVARIANT_VIOLATION', async () => {
    const db = seed({ shares: manyShares().slice(1) })
    const spy = vi.spyOn(db, 'listRows')
    const response = await balances(db)
    expect(response.status).toBe(500)
    expect(response.body.error?.code).toBe('INVARIANT_VIOLATION')
    // Three reads of two pages each.
    expect(spy.mock.calls.filter(([params]) => params.tableId === 'shares')).toHaveLength(6)
  })

  it('is for every member, viewers and archived groups included', async () => {
    const groups = GROUPS.map((group) =>
      group.$id === 'house' ? { ...group, archivedAt: '2026-10-01T00:00:00.000Z' } : group,
    )
    const db = seed({ groups })
    expect((await balances(db, 'house', 'u-cara')).status).toBe(200)
    expect((await balances(db, 'house', 'u-lee')).status).toBe(200)
    expect((await balances(db, 'house', 'u-dan')).body.error?.code).toBe('NOT_A_MEMBER')
    expect((await balances(db, 'house', null)).body.error?.code).toBe('UNAUTHENTICATED')
    expect((await balances(db, 'nope')).body.error?.code).toBe('NOT_A_MEMBER')
  })
})
