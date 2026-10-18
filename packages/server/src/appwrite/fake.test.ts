import type { Transactions } from '@ledgerly/core/generated/rows'
import { AppwriteException, Query } from 'node-appwrite'
import { describe, expect, it } from 'vitest'
import { FakeDb } from './fake'

const DB = { databaseId: 'main', tableId: 'transactions' }

function transactions() {
  return new FakeDb({
    transactions: [
      { $id: 't1', groupId: 'g1', date: '2026-10-01', status: 'posted', statementId: null },
      { $id: 't2', groupId: 'g1', date: '2026-10-15', status: 'due', statementId: null },
      { $id: 't3', groupId: 'g1', date: '2026-09-30', status: 'posted', statementId: 's1' },
      { $id: 't4', groupId: 'g2', date: '2026-10-05', status: 'posted' },
    ],
  })
}

async function ids(db: FakeDb, queries: string[]) {
  const { rows } = await db.listRows({ ...DB, queries })
  return rows.map((row) => row.$id)
}

describe('FakeDb reads', () => {
  it('gets a row with Appwrite system fields', async () => {
    const db = new FakeDb({
      persons: [{ $id: 'p1', userId: 'u1', $createdAt: '2026-01-01T00:00:00.000Z' }],
    })
    expect(await db.getRow({ databaseId: 'main', tableId: 'persons', rowId: 'p1' })).toEqual({
      $id: 'p1',
      userId: 'u1',
      $createdAt: '2026-01-01T00:00:00.000Z',
      $updatedAt: expect.any(String),
      $permissions: [],
      $sequence: '1',
      $tableId: 'persons',
      $databaseId: 'main',
    })
  })

  it('throws Appwrite 404s for a missing row or database', async () => {
    const db = transactions()
    const missingRow = db.getRow({ ...DB, rowId: 'nope' })
    await expect(missingRow).rejects.toBeInstanceOf(AppwriteException)
    await expect(missingRow).rejects.toMatchObject({ code: 404, type: 'row_not_found' })
    await expect(db.listRows({ databaseId: 'other', tableId: 'x' })).rejects.toMatchObject({
      code: 404,
      type: 'database_not_found',
    })
  })

  it('returns copies, so callers cannot change stored rows', async () => {
    const db = transactions()
    const row = await db.getRow<Transactions>({ ...DB, rowId: 't1' })
    row.status = 'void'
    expect((await db.getRow<Transactions>({ ...DB, rowId: 't1' })).status).toBe('posted')
  })

  it('filters with the Query helpers', async () => {
    const db = transactions()
    expect(await ids(db, [Query.equal('groupId', 'g1'), Query.isNull('statementId')])).toEqual([
      't1',
      't2',
    ])
    expect(await ids(db, [Query.equal('status', ['due', 'void'])])).toEqual(['t2'])
    expect(await ids(db, [Query.notEqual('status', 'posted')])).toEqual(['t2'])
    expect(await ids(db, [Query.isNotNull('statementId')])).toEqual(['t3'])
    expect(await ids(db, [Query.between('date', '2026-10-01', '2026-10-05')])).toEqual(['t1', 't4'])
    expect(await ids(db, [Query.lessThan('date', '2026-10-01')])).toEqual(['t3'])
    expect(await ids(db, [Query.lessThanEqual('date', '2026-10-01')])).toEqual(['t1', 't3'])
    expect(await ids(db, [Query.greaterThan('date', '2026-10-05')])).toEqual(['t2'])
    expect(await ids(db, [Query.greaterThanEqual('date', '2026-10-05')])).toEqual(['t2', 't4'])
  })

  it('orders, pages and counts the total before paging', async () => {
    const db = transactions()
    const page = await db.listRows({
      ...DB,
      queries: [Query.orderDesc('date'), Query.offset(1), Query.limit(2)],
    })
    expect(page.total).toBe(4)
    expect(page.rows.map((row) => row.$id)).toEqual(['t4', 't1'])
    expect(
      await ids(db, [Query.orderAsc('status'), Query.orderDesc('date'), Query.cursorAfter('t2')]),
    ).toEqual(['t4', 't1', 't3'])
    await expect(
      db.listRows({ ...DB, queries: [Query.cursorAfter('nope')] }),
    ).rejects.toMatchObject({
      code: 400,
    })
  })

  it('returns 25 rows when no limit is given, like Appwrite', async () => {
    const db = new FakeDb({ activity: Array.from({ length: 30 }, (_, i) => ({ $id: `a${i}` })) })
    const { rows, total } = await db.listRows({ databaseId: 'main', tableId: 'activity' })
    expect(rows).toHaveLength(25)
    expect(total).toBe(30)
  })

  it('sorts nulls and numbers like Appwrite', async () => {
    const db = new FakeDb({
      items: [
        { $id: 'i1', position: 10 },
        { $id: 'i2', position: 9 },
        { $id: 'i3', position: null },
      ],
    })
    const { rows } = await db.listRows({
      databaseId: 'main',
      tableId: 'items',
      queries: [Query.orderAsc('position')],
    })
    expect(rows.map((row) => row.$id)).toEqual(['i3', 'i2', 'i1'])
  })

  it('refuses queries it does not model, instead of ignoring them', async () => {
    const db = transactions()
    await expect(
      db.listRows({ ...DB, queries: [Query.contains('description', 'rent')] }),
    ).rejects.toThrow('FakeDb does not support the "contains" query')
  })
})

describe('FakeDb transactions', () => {
  it('reports the staged operation count and status', async () => {
    const db = new FakeDb()
    const { $id } = await db.createTransaction()
    const staged = await db.createOperations({
      transactionId: $id,
      operations: [
        { action: 'create', databaseId: 'main', tableId: 'activity', rowId: 'a1', data: {} },
      ],
    })
    expect(staged).toMatchObject({ $id, status: 'pending', operations: 1 })
    expect(staged).not.toHaveProperty('staged')
    expect(await db.updateTransaction({ transactionId: $id, commit: true })).toMatchObject({
      status: 'committed',
    })
  })

  it('applies nothing on rollback and refuses to reuse a finished transaction', async () => {
    const db = new FakeDb()
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        { action: 'create', databaseId: 'main', tableId: 'activity', rowId: 'a1', data: {} },
      ],
    })
    await db.updateTransaction({ transactionId: $id, rollback: true })
    expect(db.rows('activity')).toEqual([])
    await expect(db.updateTransaction({ transactionId: $id, commit: true })).rejects.toMatchObject({
      code: 400,
    })
    await expect(db.createOperations({ transactionId: 'nope' })).rejects.toMatchObject({
      code: 404,
    })
  })

  it('replays operations in order, so a row can be deleted and created again', async () => {
    const db = new FakeDb({ shares: [{ $id: 't1_p1', givenCents: 100 }] })
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        { action: 'delete', databaseId: 'main', tableId: 'shares', rowId: 't1_p1' },
        {
          action: 'create',
          databaseId: 'main',
          tableId: 'shares',
          rowId: 't1_p1',
          data: { givenCents: 90 },
        },
      ],
    })
    await db.updateTransaction({ transactionId: $id, commit: true })
    expect(db.rows('shares')).toEqual([expect.objectContaining({ $id: 't1_p1', givenCents: 90 })])
  })

  it('fails the whole commit when one operation fails', async () => {
    const db = new FakeDb({ activity: [{ $id: 'a1' }] })
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        { action: 'create', databaseId: 'main', tableId: 'activity', rowId: 'a2', data: {} },
        { action: 'update', databaseId: 'main', tableId: 'activity', rowId: 'missing', data: {} },
      ],
    })
    await expect(db.updateTransaction({ transactionId: $id, commit: true })).rejects.toMatchObject({
      code: 404,
      type: 'row_not_found',
    })
    expect(db.rows('activity').map((row) => row.$id)).toEqual(['a1'])
  })

  it('upserts, sets permissions from $permissions and refuses unknown operations', async () => {
    const db = new FakeDb({ members: [{ $id: 'm1', role: 'member' }] })
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        {
          action: 'upsert',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm1',
          data: { role: 'admin', $permissions: ['read("team:g1")'] },
        },
        {
          action: 'upsert',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm2',
          data: { role: 'viewer' },
        },
      ],
    })
    await db.updateTransaction({ transactionId: $id, commit: true })
    expect(
      db.rows('members').map(({ $id: id, role, $permissions }) => [id, role, $permissions]),
    ).toEqual([
      ['m1', 'admin', ['read("team:g1")']],
      ['m2', 'viewer', []],
    ])
    const second = await db.createTransaction()
    await expect(
      db.createOperations({
        transactionId: second.$id,
        operations: [{ action: 'increment', databaseId: 'main', tableId: 'members', rowId: 'm1' }],
      }),
    ).rejects.toThrow('does not support the "increment" operation')
  })

  it('replaces the whole row on upsert, keeping only system fields, like Appwrite', async () => {
    const db = new FakeDb({
      members: [
        { $id: 'm1', role: 'member', leftOn: '2026-10-01', $createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    })
    await commit(db, [
      {
        action: 'upsert',
        databaseId: 'main',
        tableId: 'members',
        rowId: 'm1',
        data: { role: 'admin' },
      },
    ])
    const [row] = db.rows('members')
    expect(row).toMatchObject({ role: 'admin', $createdAt: '2026-01-01T00:00:00.000Z' })
    expect(row).not.toHaveProperty('leftOn')
  })

  it('keeps permissions on an update that does not set them', async () => {
    const db = new FakeDb({
      members: [{ $id: 'm1', role: 'member', $permissions: ['read("team:g1")'] }],
    })
    await commit(db, [
      {
        action: 'update',
        databaseId: 'main',
        tableId: 'members',
        rowId: 'm1',
        data: { role: 'admin' },
      },
    ])
    expect(db.rows('members')[0]).toMatchObject({
      role: 'admin',
      $permissions: ['read("team:g1")'],
    })
  })

  it('shows staged writes to reads that pass the transactionId, and only to them', async () => {
    const db = new FakeDb({ members: [{ $id: 'm1', groupId: 'g1', role: 'member' }] })
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm1',
          data: { role: 'admin' },
        },
        {
          action: 'create',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm2',
          data: { groupId: 'g1' },
        },
      ],
    })
    const inside = { databaseId: 'main', tableId: 'members', transactionId: $id }
    expect(await db.getRow({ ...inside, rowId: 'm1' })).toMatchObject({
      groupId: 'g1',
      role: 'admin',
    })
    expect((await db.listRows({ ...inside, queries: [Query.equal('groupId', 'g1')] })).total).toBe(
      2,
    )
    expect(await db.getRow({ databaseId: 'main', tableId: 'members', rowId: 'm1' })).toMatchObject({
      role: 'member',
    })
    await expect(
      db.getRow({ databaseId: 'main', tableId: 'members', rowId: 'm2' }),
    ).rejects.toMatchObject({ code: 404 })
  })

  it('enforces the unique indexes from appwrite/tables.json, ignoring nulls', async () => {
    const db = new FakeDb({
      members: [{ $id: 'm1', groupId: 'g1', personId: 'p1' }],
      identities: [{ $id: 'i1', key: null }],
    })
    await expect(
      commit(db, [
        {
          action: 'create',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm2',
          data: { groupId: 'g1', personId: 'p1' },
        },
      ]),
    ).rejects.toMatchObject({ code: 409, type: 'row_already_exists' })
    await commit(db, [
      {
        action: 'create',
        databaseId: 'main',
        tableId: 'members',
        rowId: 'm3',
        data: { groupId: 'g2', personId: 'p1' },
      },
      {
        action: 'create',
        databaseId: 'main',
        tableId: 'identities',
        rowId: 'i2',
        data: { key: null },
      },
    ])
    expect(db.rows('members')).toHaveLength(2)
    expect(db.rows('identities')).toHaveLength(2)
  })

  it('refuses tables that are not in appwrite/tables.json', async () => {
    const db = new FakeDb()
    await expect(db.listRows({ databaseId: 'main', tableId: 'member' })).rejects.toMatchObject({
      code: 404,
      type: 'table_not_found',
    })
    expect(() => new FakeDb({ member: [{ $id: 'm1' }] })).toThrow('Table member not found')
  })
})

async function commit(db: FakeDb, operations: object[]) {
  const { $id } = await db.createTransaction()
  await db.createOperations({ transactionId: $id, operations })
  await db.updateTransaction({ transactionId: $id, commit: true })
}
