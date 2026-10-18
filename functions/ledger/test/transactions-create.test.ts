import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amounts, call, expense, GROUPS, leftOnTheirOwn, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('POST /transactions', () => {
  it('writes the transaction, its shares and an activity row in one go', async () => {
    const db = seed()
    const response = await call(db, 'POST', '/transactions', expense())
    expect(response.status).toBe(200)
    const [transaction] = rows.transactions(db)
    expect(transaction).toMatchObject({
      $id: 't1',
      groupId: 'house',
      kind: 'expense',
      status: 'posted',
      date: '2026-10-10',
      description: 'Groceries',
      totalCents: 9000,
      statementId: null,
      overridden: false,
      createdBy: 'alice',
      updatedBy: 'alice',
      $permissions: ['read("team:house")'],
    })
    // No payers given: the caller paid, and that is stored.
    expect(JSON.parse(transaction?.inputJson ?? '')).toEqual({
      payers: [{ personId: 'alice', cents: 9000 }],
      split: { mode: 'equal', personIds: ['alice', 'bob'] },
    })
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 9000, receivedCents: 4500 },
      { personId: 'bob', givenCents: 0, receivedCents: 4500 },
    ])
    expect(rows.shares(db)[0]).toMatchObject({
      transactionId: 't1',
      groupId: 'house',
      date: '2026-10-10',
      kind: 'expense',
      $permissions: ['read("team:house")'],
    })
    expect(rows.activity(db)).toMatchObject([
      {
        groupId: 'house',
        actorPersonId: 'alice',
        action: 'transaction.created',
        transactionId: 't1',
        summary: 'Added “Groceries” ($90.00)',
        changesJson: null,
        at: NOW.toISOString(),
      },
    ])
    expect(response.body.data).toMatchObject({
      transaction: { $id: 't1', totalCents: 9000 },
      shares: [{ personId: 'alice' }, { personId: 'bob' }],
      items: [],
    })
  })

  it('gives a retry with the same id and body the same transaction, writing nothing new', async () => {
    const db = seed()
    const first = await call(db, 'POST', '/transactions', expense())
    const again = await call(db, 'POST', '/transactions', expense())
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual(first.body.data)
    expect(rows.transactions(db)).toHaveLength(1)
    expect(rows.shares(db)).toHaveLength(2)
    expect(rows.activity(db)).toHaveLength(1)
  })

  it('refuses the same id with different content as CONFLICT', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    const response = await call(db, 'POST', '/transactions', expense({ totalCents: 9100 }))
    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('CONFLICT')
    expect(rows.transactions(db)[0]?.totalCents).toBe(9000)
  })

  it('stores the items in order, with the total as their sum', async () => {
    const db = seed()
    const response = await call(
      db,
      'POST',
      '/transactions',
      expense({
        totalCents: undefined,
        split: undefined,
        items: [
          { name: 'Milk', amountCents: 300, split: { mode: 'equal', personIds: ['alice', 'bob'] } },
          {
            name: 'Wine',
            quantity: 2,
            amountCents: 2000,
            split: { mode: 'equal', personIds: ['bob'] },
          },
        ],
      }),
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.totalCents).toBe(2300)
    expect(rows.items(db)).toMatchObject([
      { transactionId: 't1', position: 0, name: 'Milk', quantity: 1, amountCents: 300 },
      { transactionId: 't1', position: 1, name: 'Wine', quantity: 2, amountCents: 2000 },
    ])
    expect(JSON.parse(rows.items(db)[1]?.splitJson ?? '')).toEqual({
      mode: 'equal',
      personIds: ['bob'],
    })
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 2300, receivedCents: 150 },
      { personId: 'bob', givenCents: 0, receivedCents: 2150 },
    ])
  })

  it('keeps a due bill without shares until it is paid (I-6)', async () => {
    const db = seed()
    const response = await call(db, 'POST', '/transactions', {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 12000,
      bill: { status: 'due', dueOn: '2026-10-25' },
    })
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({
      status: 'due',
      dueOn: '2026-10-25',
      totalCents: 12000,
    })
    // Who pays is decided when it's paid, so no payer is stored.
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '')).toEqual({ bill: {} })
    expect(rows.shares(db)).toEqual([])
  })

  it('posts a shift: the worker is owed what the employer receives', async () => {
    const db = seed()
    const response = await call(
      db,
      'POST',
      '/transactions',
      {
        id: 's1',
        groupId: 'job',
        kind: 'shift',
        date: '2026-10-16',
        description: 'Thursday',
        shift: { minutes: 300, rateCents: 2500 },
      },
      'u-sam',
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.totalCents).toBe(12500)
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'acme', givenCents: 0, receivedCents: 12500 },
      { personId: 'sam', givenCents: 12500, receivedCents: 0 },
    ])
  })

  it.each([
    ['a body that fails the schema', expense({ description: '' })],
    ['a date more than a year ahead', expense({ date: '2027-10-20' })],
    ['payers that do not add up', expense({ payers: [{ personId: 'alice', cents: 1 }] })],
    ['someone who is not in the group', expense({ split: { mode: 'equal', personIds: ['dan'] } })],
    ['a receipt, until receipts are checked', expense({ receiptFileIds: ['f1'] })],
    ['a kind the group does not have', expense({ kind: 'income', split: undefined })],
    // Would stop the scheduler creating that occurrence (scheduling.md).
    ['the id of a schedule occurrence', expense({ id: 'sch1_20261101' })],
  ])('refuses %s with VALIDATION_FAILED and writes nothing', async (_case, body) => {
    const db = seed()
    const response = await call(db, 'POST', '/transactions', body)
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)).toEqual([])
    expect(rows.activity(db)).toEqual([])
  })

  it('accepts a date exactly a year (366 days) ahead', async () => {
    const response = await call(seed(), 'POST', '/transactions', expense({ date: '2027-10-19' }))
    expect(response.status).toBe(200)
  })

  it.each([
    ['a viewer', 'u-cara', 403, 'FORBIDDEN'],
    ['someone who moved out', 'u-lee', 403, 'FORBIDDEN'],
    ['someone outside the group', 'u-dan', 403, 'NOT_A_MEMBER'],
    ['nobody signed in', null, 401, 'UNAUTHENTICATED'],
  ])('refuses %s', async (_case, user, status, code) => {
    const db = seed()
    const response = await call(db, 'POST', '/transactions', expense(), user)
    expect(response.status).toBe(status)
    expect(response.body.error?.code).toBe(code)
    expect(rows.transactions(db)).toEqual([])
  })

  it('refuses someone who left on their own as not a member, not as a viewer (#117)', async () => {
    const db = seed()
    leftOnTheirOwn(db, 'u-lee')
    const response = await call(db, 'POST', '/transactions', expense(), 'u-lee')
    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe('NOT_A_MEMBER')
    expect(rows.transactions(db)).toEqual([])
  })

  it('refuses a date covered by a statement being finalized, with LOCKED', async () => {
    const statement = (periodEnd: string, status: string) => ({
      groupId: 'house',
      type: 'divide',
      periodStart: '2026-09-01',
      periodEnd,
      status,
      snapshotJson: '{}',
    })
    const db = seed({
      statements: [
        { $id: 'st1', ...statement('2026-10-31', 'finalizing') },
        { $id: 'st2', ...statement('2026-12-31', 'draft') },
      ],
    })
    const locked = await call(db, 'POST', '/transactions', expense())
    expect(locked.status).toBe(409)
    expect(locked.body.error?.code).toBe('LOCKED')
    // After the period it's fine, and drafts never lock anything.
    const later = await call(db, 'POST', '/transactions', expense({ id: 't2', date: '2026-11-02' }))
    expect(later.status).toBe(200)
  })

  it('refuses an archived group', async () => {
    const db = seed({
      groups: GROUPS.map((group) =>
        group.$id === 'house' ? { ...group, archivedAt: '2026-10-01T00:00:00.000Z' } : group,
      ),
    })
    const response = await call(db, 'POST', '/transactions', expense())
    expect(response.body.error?.code).toBe('ARCHIVED')
  })
})
