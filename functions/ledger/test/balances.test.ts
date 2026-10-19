import type { Balances } from '@ledgerly/core/schemas/ledger'
import { balancesFromShares } from '@ledgerly/core/settle/balances'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, GROUPS, leftOnTheirOwn, NOW, seed } from './harness'

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

const updateShare = (rowId: string, personId: string) => ({
  action: 'update',
  databaseId: 'main',
  tableId: 'shares',
  rowId,
  data: { personId },
})

let revs = 0

/** A ledger write committed at once: its changes, and a fresh `rev` on the group row. */
function ledgerWrite(db: Db, ...operations: object[]) {
  const guard = { action: 'update', databaseId: 'main', tableId: 'groups', rowId: 'house' }
  return commitNow(db, [...operations, { ...guard, data: { rev: `rev${++revs}` } }])
}

// Every group starts with an empty `balances` row, which every write keeps (ledger.md#balances),
// or with none, so the shares are summed: the answers are the same.
const ROWS = [
  { $id: 'house', peopleJson: '[]' },
  { $id: 'job', peopleJson: '[]' },
]

describe.each([
  { from: 'the shares', rows: [] },
  { from: 'the balances row', rows: ROWS },
])('GET /groups/{groupId}/balances, from $from', ({ rows }) => {
  let current: Db | undefined
  const start = () => {
    current = seed({ balances: rows })
    return current
  }

  // Every write kept each row: it is what a fresh sum of the group's shares builds.
  afterEach(() => {
    for (const { $id } of rows) {
      const shares = current?.rows('shares').filter((share) => share.groupId === $id) ?? []
      const row = current?.rows('balances').find((balances) => balances.$id === $id)
      expect(JSON.parse(String(row?.peopleJson))).toEqual(balancesFromShares(shares as never))
    }
  })

  it('nets each person’s shares and suggests the transfers that settle them', async () => {
    const db = start()
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
    const db = start()
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

  it('lists someone whose shares cancel out at 0, with no transfer', async () => {
    const db = start()
    await call(db, 'POST', '/transactions', expense())
    const repaid = {
      id: 'p1',
      groupId: 'house',
      kind: 'payment',
      date: '2026-10-12',
      description: 'Groceries back',
      totalCents: 4500,
      payment: { fromPersonId: 'bob', toPersonId: 'alice' },
    }
    await call(db, 'POST', '/transactions', repaid, 'u-bob')
    expect((await balances(db)).body.data).toEqual({
      people: [
        { personId: 'alice', netCents: 0 },
        { personId: 'bob', netCents: 0 },
      ],
      transfers: [],
    })
  })

  it('is for someone who moved out, not someone who left on their own', async () => {
    const db = start()
    // Lee moved out: a left viewer, still in the team.
    expect((await balances(db, 'house', 'u-lee')).status).toBe(200)
    leftOnTheirOwn(db, 'u-lee')
    expect((await balances(db, 'house', 'u-lee')).body.error?.code).toBe('NOT_A_MEMBER')
  })

  it('is empty for a group with no shares', async () => {
    expect((await balances(start())).body.data).toEqual({ people: [], transfers: [] })
  })
})

describe('GET /groups/{groupId}/balances', () => {
  it('reads the group’s balances row, not its shares', async () => {
    const people = [
      { personId: 'alice', netCents: 2500, shares: 1 },
      { personId: 'bob', netCents: -2500, shares: 1 },
    ]
    const db = seed({ balances: [{ $id: 'house', peopleJson: JSON.stringify(people) }] })
    const spy = vi.spyOn(db, 'listRows')
    expect((await balances(db)).body.data).toEqual({
      people: [
        { personId: 'alice', netCents: 2500 },
        { personId: 'bob', netCents: -2500 },
      ],
      transfers: [{ fromPersonId: 'bob', toPersonId: 'alice', cents: 2500 }],
    })
    expect(spy.mock.calls.filter(([params]) => params.tableId === 'shares')).toEqual([])
  })

  it.each([
    ['doesn’t add up', JSON.stringify([{ personId: 'alice', netCents: 100, shares: 1 }])],
    ['can’t be read', '{'],
  ])('sums the shares when the row %s, and logs it', async (_, peopleJson) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = seed({ balances: [{ $id: 'house', peopleJson }], shares: manyShares() })
    expect((await balances(db)).body.data?.people).toEqual([
      { personId: 'alice', netCents: -5100 },
      { personId: 'bob', netCents: 5100 },
    ])
    expect(error.mock.calls).toEqual([
      ["balances: the row of group house doesn't add up; summed the shares"],
    ])
    error.mockRestore()
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

  it('reads again when a write commits between two pages', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    let pages = 0
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      // t50 is voided after page 1, which had its first share; page 2 misses its last one.
      if (params.tableId === 'shares' && ++pages === 2) {
        await ledgerWrite(db, ...deleteShares('first', 'last'))
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

  it('reads again even when the torn read adds up to 0', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    let pages = 0
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      // t50 is edited from "Bob pays Alice" to "Cara pays Bob", reusing its two share rows. Page 1
      // saw its first share before, and page 2 its last one after: −100 for Alice, +100 for Cara.
      if (params.tableId === 'shares' && ++pages === 2) {
        await ledgerWrite(db, updateShare('first', 'bob'), updateShare('last', 'cara'))
      }
      return list(params)
    })
    expect((await balances(db)).body.data?.people).toEqual([
      { personId: 'alice', netCents: -5000 },
      { personId: 'bob', netCents: 4900 },
      { personId: 'cara', netCents: 100 },
    ])
  })

  it('reads again when the row a page ended on was deleted before the next page', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    let pages = 0
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares' && ++pages === 2) {
        // t49 is voided: its first share is the row page 1 ended on.
        await ledgerWrite(db, ...deleteShares('s49a', 's49b'))
      }
      return list(params)
    })
    const response = await balances(db)
    expect(response.body.data?.people).toEqual([
      { personId: 'alice', netCents: -5000 },
      { personId: 'bob', netCents: 5000 },
    ])
  })

  it('gives CONFLICT when a write commits during every read', async () => {
    const db = seed({ shares: manyShares() })
    const list = db.listRows.bind(db)
    const spy = vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares') await ledgerWrite(db)
      return list(params)
    })
    expect((await balances(db)).body.error?.code).toBe('CONFLICT')
    expect(spy.mock.calls.filter(([params]) => params.tableId === 'shares')).toHaveLength(6)
  })

  it('gives CONFLICT when every read loses its cursor row', async () => {
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

  it('reports a whole read that doesn’t add up as INVARIANT_VIOLATION at once', async () => {
    const db = seed({ shares: manyShares().slice(1) })
    const spy = vi.spyOn(db, 'listRows')
    const response = await balances(db)
    expect(response.status).toBe(500)
    expect(response.body.error?.code).toBe('INVARIANT_VIOLATION')
    // One read of two pages.
    expect(spy.mock.calls.filter(([params]) => params.tableId === 'shares')).toHaveLength(2)
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

  it('is not for a placeholder, even one with an account', async () => {
    const db = seed()
    const persons = { action: 'update', databaseId: 'main', tableId: 'persons', rowId: 'pat' }
    await commitNow(db, [{ ...persons, data: { userId: 'u-pat' } }])
    expect((await balances(db, 'house', 'u-pat')).body.error?.code).toBe('NOT_A_MEMBER')
  })
})
