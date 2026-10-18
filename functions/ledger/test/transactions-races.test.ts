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

  it('a member removed before the write is checked can no longer get a share (I-3)', async () => {
    const db = seed()
    before(db, () => commitNow(db, [removeCara]))
    const response = await call(db, 'POST', '/transactions', withCara)
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)).toEqual([])
  })

  it('a member removed between the check and the commit makes the write run again (I-3)', async () => {
    const db = seed()
    beforeCommit(db, () => commitNow(db, [removeCara]))
    const response = await call(db, 'POST', '/transactions', withCara)
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)).toEqual([])
    expect(rows.shares(db)).toEqual([])
  })

  it('a due bill naming a member removed before the commit runs again, though it has no shares', async () => {
    const db = seed()
    beforeCommit(db, () => commitNow(db, [removeCara]))
    const response = await call(db, 'POST', '/transactions', {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 12000,
      split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
      bill: { status: 'due', dueOn: '2026-10-25' },
    })
    // Posting it later would give a share to someone with no member row (I-3).
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)).toEqual([])
  })

  it('someone named with nothing to pay or get is guarded too', async () => {
    const db = seed()
    beforeCommit(db, () => commitNow(db, [removeCara]))
    const response = await call(
      db,
      'POST',
      '/transactions',
      expense({
        split: {
          mode: 'exact',
          amounts: [
            { personId: 'bob', cents: 9000 },
            { personId: 'cara', cents: 0 },
          ],
        },
      }),
    )
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)).toEqual([])
  })

  it('a member row given to another person meanwhile (a merge) reruns the write, and stays theirs', async () => {
    const db = seed()
    before(db, () =>
      commitNow(db, [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm-cara',
          data: { personId: 'cara2' },
        },
      ]),
    )
    const response = await call(db, 'POST', '/transactions', withCara)
    // The rerun finds Cara no longer in the group (I-3).
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(db.rows('members').find((row) => row.$id === 'm-cara')?.personId).toBe('cara2')
    expect(rows.transactions(db)).toEqual([])
  })

  it('a statement that starts finalizing before the guard stages makes the write LOCKED', async () => {
    const db = seed({
      statements: [
        {
          $id: 'st1',
          groupId: 'house',
          type: 'divide',
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          status: 'draft',
          snapshotJson: '{}',
        },
      ],
    })
    before(db, () =>
      commitNow(db, [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'statements',
          rowId: 'st1',
          data: { status: 'finalizing' },
        },
      ]),
    )
    const response = await call(db, 'POST', '/transactions', expense())
    expect(response.body.error?.code).toBe('LOCKED')
    expect(rows.transactions(db)).toEqual([])
  })

  it('a void that loses to an archive runs again and is refused', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    beforeCommit(db, () =>
      commitNow(db, [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'groups',
          rowId: 'house',
          data: { archivedAt: '2026-10-18T00:00:00.000Z' },
        },
      ]),
    )
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(response.body.error?.code).toBe('ARCHIVED')
    expect(rows.transactions(db)[0]?.status).toBe('posted')
  })

  it('a transaction deleted before the guard stages gives NOT_FOUND, not an error', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    // A schedule edit removes the row (and its shares) meanwhile.
    before(db, () =>
      commitNow(db, [
        ...rows.shares(db).map((share) => ({
          action: 'delete',
          databaseId: 'main',
          tableId: 'shares',
          rowId: share.$id,
        })),
        { action: 'delete', databaseId: 'main', tableId: 'transactions', rowId: 't1' },
      ]),
    )
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: 'Gone' })
    expect(response.body.error?.code).toBe('NOT_FOUND')
  })

  it('a group settings change before the guard stages makes the write run again', async () => {
    const db = seed()
    before(db, () =>
      commitNow(db, [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'groups',
          rowId: 'house',
          data: { timezone: 'Australia/Perth' },
        },
      ]),
    )
    const run = vi.spyOn(db, 'listRows')
    const response = await call(db, 'POST', '/transactions', expense())
    expect(response.status).toBe(200)
    // The rerun read the group (and everything else) again.
    expect(
      run.mock.calls.filter(([params]) => params.tableId === 'members').length,
    ).toBeGreaterThan(2)
  })

  // ledgerly-dev (#105): Appwrite only counts real changes, so the guard writes a fresh rev.
  it('a member delete staged before the write fails once the write commits (I-3)', async () => {
    const db = seed()
    const { $id } = await db.createTransaction()
    await db.createOperations({ transactionId: $id, operations: [removeCara] })
    expect((await call(db, 'POST', '/transactions', withCara)).status).toBe(200)
    await expect(db.updateTransaction({ transactionId: $id, commit: true })).rejects.toMatchObject({
      code: 409,
    })
    expect(db.rows('members').some((row) => row.$id === 'm-cara')).toBe(true)
  })

  it('a currency change staged before the write fails once the write commits', async () => {
    const db = seed()
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'groups',
          rowId: 'house',
          data: { currency: 'USD' },
        },
      ],
    })
    expect((await call(db, 'POST', '/transactions', expense())).status).toBe(200)
    await expect(db.updateTransaction({ transactionId: $id, commit: true })).rejects.toMatchObject({
      code: 409,
    })
    expect(db.rows('groups').find((row) => row.$id === 'house')?.currency).toBe('AUD')
  })

  it('a currency change between the check and the commit makes the write run again', async () => {
    const db = seed()
    beforeCommit(db, () =>
      commitNow(db, [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'groups',
          rowId: 'house',
          data: { currency: 'USD' },
        },
      ]),
    )
    const response = await call(db, 'POST', '/transactions', expense())
    expect(response.status).toBe(200)
    // The second run read the new currency.
    expect(rows.activity(db)).toMatchObject([{ summary: expect.stringContaining('USD') }])
    expect(rows.transactions(db)).toHaveLength(1)
  })
})

const removeCara = {
  action: 'delete',
  databaseId: 'main',
  tableId: 'members',
  rowId: 'm-cara',
}

/** Another request's transaction, committed at once. */
async function commitNow(db: Db, operations: object[]) {
  const { $id } = await db.createTransaction()
  await db.createOperations({ transactionId: $id, operations })
  await db.updateTransaction({ transactionId: $id, commit: true })
}

/** Runs `meanwhile` to completion just before the request commits. */
function beforeCommit(db: Db, meanwhile: () => Promise<unknown>) {
  const update = db.updateTransaction.bind(db)
  vi.spyOn(db, 'updateTransaction').mockImplementationOnce(async (params) => {
    if (params.commit) await meanwhile()
    return update(params)
  })
}
