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

const AT = '2026-10-18T00:00:00.000Z'

// Whole rows with every required column, for staged creates and upserts.
const rowsFor = {
  activity: (extra = {}) => ({ groupId: 'g1', action: 'test', summary: 'Test', at: AT, ...extra }),
  member: (groupId: string, personId: string, extra = {}) => ({
    groupId,
    personId,
    displayName: 'Sam',
    role: 'member',
    status: 'active',
    joinedOn: '2026-10-01',
    ...extra,
  }),
  share: (extra = {}) => ({
    transactionId: 't1',
    personId: 'p1',
    givenCents: 0,
    receivedCents: 0,
    groupId: 'g1',
    date: '2026-10-18',
    kind: 'expense',
    ...extra,
  }),
}

function op(action: string, tableId: string, rowId: string, data?: object) {
  return { action, databaseId: 'main', tableId, rowId, ...(data && { data }) }
}

describe('FakeDb transactions', () => {
  it('reports the staged operation count and status', async () => {
    const db = new FakeDb()
    const { $id } = await db.createTransaction()
    const staged = await db.createOperations({
      transactionId: $id,
      operations: [op('create', 'activity', 'a1', rowsFor.activity())],
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
      operations: [op('create', 'activity', 'a1', rowsFor.activity())],
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

  // The four cases checked on ledgerly-dev with real TablesDB transactions (#105): a staged
  // update of member m1, then another transaction commits first.
  describe('when another transaction commits a change to a staged row first', () => {
    async function race(other: object | null) {
      const db = new FakeDb({ members: [{ $id: 'm1', ...rowsFor.member('g1', 'p1') }] })
      const { $id } = await db.createTransaction()
      await db.createOperations({
        transactionId: $id,
        operations: [op('update', 'members', 'm1', { displayName: 'Sam L' })],
      })
      if (other) await commit(db, [other])
      return { db, commit: db.updateTransaction({ transactionId: $id, commit: true }) }
    }

    it('A: a same-value update is no change, so the staged commit goes through', async () => {
      const { db, commit: staged } = await race(op('update', 'members', 'm1', { role: 'member' }))
      await expect(staged).resolves.toMatchObject({ status: 'committed' })
      expect(db.rows('members')[0]).toMatchObject({ displayName: 'Sam L' })
    })

    it('B: a different value fails the staged commit with 409', async () => {
      const { commit: staged } = await race(op('update', 'members', 'm1', { role: 'admin' }))
      await expect(staged).rejects.toMatchObject({ code: 409, type: 'transaction_conflict' })
    })

    it('C: nothing in between commits as usual', async () => {
      const { commit: staged } = await race(null)
      await expect(staged).resolves.toMatchObject({ status: 'committed' })
    })

    it('D: a delete fails the staged commit with 404', async () => {
      const { commit: staged } = await race(op('delete', 'members', 'm1'))
      await expect(staged).rejects.toMatchObject({ code: 404, type: 'row_not_found' })
    })

    it('leaves $updatedAt alone on an update that changes nothing', async () => {
      const db = new FakeDb({
        members: [{ $id: 'm1', $updatedAt: AT, ...rowsFor.member('g1', 'p1') }],
      })
      await commit(db, [op('update', 'members', 'm1', { role: 'member' })])
      expect(db.rows('members')[0]?.$updatedAt).toBe(AT)
    })
  })

  it('replays operations in order, so a row can be deleted and created again', async () => {
    const db = new FakeDb({ shares: [{ $id: 't1_p1', ...rowsFor.share({ givenCents: 100 }) }] })
    await commit(db, [
      op('delete', 'shares', 't1_p1'),
      op('create', 'shares', 't1_p1', rowsFor.share({ givenCents: 90 })),
    ])
    expect(db.rows('shares')).toEqual([expect.objectContaining({ $id: 't1_p1', givenCents: 90 })])
  })

  it('fails the whole commit when one operation fails', async () => {
    const db = new FakeDb({ activity: [{ $id: 'a1' }] })
    await expect(
      commit(db, [
        op('create', 'activity', 'a2', rowsFor.activity()),
        // Missing its required columns, which Appwrite checks when it applies the row.
        op('create', 'activity', 'a3', {}),
      ]),
    ).rejects.toMatchObject({ code: 400, type: 'document_invalid_structure' })
    expect(db.rows('activity').map((row) => row.$id)).toEqual(['a1'])
  })

  // Checked on ledgerly-dev (#238): a row deleted before an update or delete of it is staged
  // fails the staging, not the commit.
  describe('staging an update or delete of a row that is not there', () => {
    it.each([
      ['an update', op('update', 'activity', 'gone', { summary: 'x' })],
      ['a delete', op('delete', 'activity', 'gone')],
    ])('refuses %s at once with 404, staging nothing of the request', async (_, missing) => {
      const db = new FakeDb({ activity: [{ $id: 'a1', ...rowsFor.activity() }] })
      const { $id } = await db.createTransaction()
      const staging = db.createOperations({
        transactionId: $id,
        operations: [op('update', 'activity', 'a1', { summary: 'y' }), missing],
      })
      await expect(staging).rejects.toMatchObject({ code: 404, type: 'row_not_found' })
      expect(await db.createOperations({ transactionId: $id, operations: [] })).toMatchObject({
        operations: 0,
      })
    })

    it('sees rows this transaction created or deleted, in this request or an earlier one', async () => {
      const db = new FakeDb({ activity: [{ $id: 'a1', ...rowsFor.activity() }] })
      const { $id } = await db.createTransaction()
      await db.createOperations({
        transactionId: $id,
        operations: [op('create', 'activity', 'a2', rowsFor.activity())],
      })
      await db.createOperations({
        transactionId: $id,
        operations: [
          op('update', 'activity', 'a2', { summary: 'x' }),
          op('create', 'activity', 'a3', rowsFor.activity()),
          op('delete', 'activity', 'a3'),
        ],
      })
      await expect(
        db.createOperations({ transactionId: $id, operations: [op('delete', 'activity', 'a3')] }),
      ).rejects.toMatchObject({ code: 404, type: 'row_not_found' })
      await db.createOperations({
        transactionId: $id,
        operations: [
          op('delete', 'activity', 'a1'),
          op('create', 'activity', 'a1', rowsFor.activity()),
        ],
      })
    })
  })

  it('sets permissions from $permissions and refuses unknown operations', async () => {
    const db = new FakeDb({ members: [{ $id: 'm1', ...rowsFor.member('g1', 'p1') }] })
    await commit(db, [
      op('upsert', 'members', 'm1', {
        ...rowsFor.member('g1', 'p1', { role: 'admin' }),
        $permissions: ['read("team:g1")'],
      }),
      op('upsert', 'members', 'm2', rowsFor.member('g1', 'p2', { role: 'viewer' })),
    ])
    expect(
      db.rows('members').map(({ $id: id, role, $permissions }) => [id, role, $permissions]),
    ).toEqual([
      ['m1', 'admin', ['read("team:g1")']],
      ['m2', 'viewer', []],
    ])
    const { $id } = await db.createTransaction()
    await expect(
      db.createOperations({ transactionId: $id, operations: [op('increment', 'members', 'm1')] }),
    ).rejects.toThrow('does not support the "increment" operation')
  })

  it('replaces the whole row on upsert, keeping only system fields, like Appwrite', async () => {
    const db = new FakeDb({
      members: [
        {
          $id: 'm1',
          ...rowsFor.member('g1', 'p1', { leftOn: '2026-10-05' }),
          $createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    await commit(db, [op('upsert', 'members', 'm1', rowsFor.member('g1', 'p1', { role: 'admin' }))])
    const [row] = db.rows('members')
    expect(row).toMatchObject({ role: 'admin', $createdAt: '2026-01-01T00:00:00.000Z' })
    expect(row).not.toHaveProperty('leftOn')
  })

  it('refuses a create or upsert without every required column, like Appwrite', async () => {
    const db = new FakeDb({ members: [{ $id: 'm1', ...rowsFor.member('g1', 'p1') }] })
    for (const partial of [
      op('upsert', 'members', 'm1', { role: 'admin' }),
      op('create', 'members', 'm2', { groupId: 'g1', personId: 'p2' }),
      op('create', 'members', 'm3', rowsFor.member('g1', 'p3', { displayName: null })),
    ]) {
      await expect(commit(db, [partial])).rejects.toMatchObject({
        code: 400,
        type: 'document_invalid_structure',
      })
    }
    expect(db.rows('members')).toEqual([expect.objectContaining({ $id: 'm1', role: 'member' })])
  })

  it('checks only the columns an update sets: none unknown, none required set to null', async () => {
    const db = new FakeDb({
      members: [{ $id: 'm1', role: 'member', $permissions: ['read("team:g1")'] }],
    })
    await commit(db, [op('update', 'members', 'm1', { role: 'admin' })])
    expect(db.rows('members')[0]).toMatchObject({
      role: 'admin',
      $permissions: ['read("team:g1")'],
    })
    for (const data of [{ rol: 'viewer' }, { role: null }]) {
      await expect(commit(db, [op('update', 'members', 'm1', data)])).rejects.toMatchObject({
        code: 400,
        type: 'document_invalid_structure',
      })
    }
  })

  it('drops undefined keys when staging, as the SDK does, so an update leaves those columns', async () => {
    const db = new FakeDb({
      transactions: [{ $id: 't1', description: 'Rent', totalCents: 100 }],
    })
    await commit(db, [
      op('update', 'transactions', 't1', { description: undefined, totalCents: 200 }),
    ])
    expect(db.rows('transactions')[0]).toMatchObject({ description: 'Rent', totalCents: 200 })
  })

  it('shows staged writes to reads that pass the transactionId, and only to them', async () => {
    const db = new FakeDb({ members: [{ $id: 'm1', ...rowsFor.member('g1', 'p1') }] })
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        op('update', 'members', 'm1', { role: 'admin' }),
        op('create', 'members', 'm2', rowsFor.member('g1', 'p2')),
      ],
    })
    const inside = { databaseId: 'main', tableId: 'members', transactionId: $id }
    expect(await db.getRow({ ...inside, rowId: 'm1' })).toMatchObject({
      groupId: 'g1',
      role: 'admin',
    })
    const listed = await db.listRows({ ...inside, queries: [Query.equal('groupId', 'g1')] })
    expect(listed.total).toBe(2)
    expect(await db.getRow({ databaseId: 'main', tableId: 'members', rowId: 'm1' })).toMatchObject({
      role: 'member',
    })
    await expect(
      db.getRow({ databaseId: 'main', tableId: 'members', rowId: 'm2' }),
    ).rejects.toMatchObject({ code: 404 })
  })

  it('enforces the unique indexes from appwrite/tables.json, ignoring nulls', async () => {
    const db = new FakeDb({
      members: [{ $id: 'm1', ...rowsFor.member('g1', 'p1') }],
      // Seed rows aren't checked, so two null keys can sit side by side, as in MariaDB.
      identities: [
        { $id: 'i1', key: null },
        { $id: 'i2', key: null },
      ],
    })
    await expect(
      commit(db, [op('create', 'members', 'm2', rowsFor.member('g1', 'p1'))]),
    ).rejects.toMatchObject({ code: 409, type: 'row_already_exists' })
    await commit(db, [
      op('create', 'members', 'm3', rowsFor.member('g2', 'p1')),
      op('create', 'identities', 'i3', {
        key: 'email:sam@example.com',
        type: 'email',
        personId: 'p1',
      }),
    ])
    expect(db.rows('members')).toHaveLength(2)
    expect(db.rows('identities')).toHaveLength(3)
  })

  it('refuses tables and query columns that are not in appwrite/tables.json', async () => {
    const db = new FakeDb()
    await expect(db.listRows({ databaseId: 'main', tableId: 'member' })).rejects.toMatchObject({
      code: 404,
      type: 'table_not_found',
    })
    expect(() => new FakeDb({ member: [{ $id: 'm1' }] })).toThrow('Table member not found')
    for (const query of [Query.equal('groupID', 'g1'), Query.orderAsc('joined')]) {
      await expect(
        db.listRows({ databaseId: 'main', tableId: 'members', queries: [query] }),
      ).rejects.toMatchObject({ code: 400, type: 'general_query_invalid' })
    }
    const bySystemColumn = await db.listRows({
      databaseId: 'main',
      tableId: 'members',
      queries: [Query.orderDesc('$createdAt'), Query.equal('$id', 'm1')],
    })
    expect(bySystemColumn.total).toBe(0)
  })
})

async function commit(db: FakeDb, operations: object[]) {
  const { $id } = await db.createTransaction()
  await db.createOperations({ transactionId: $id, operations })
  await db.updateTransaction({ transactionId: $id, commit: true })
}
