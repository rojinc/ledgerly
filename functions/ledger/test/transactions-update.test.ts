import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amounts, call, expense, MEMBERS, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

// A house with t1 (Alice's $90.00 expense) already posted by Bob or Alice.
async function withExpense(by = 'u-alice') {
  const db = seed()
  const response = await call(db, 'POST', '/transactions', expense(), by)
  expect(response.status).toBe(200)
  return db
}

describe('PATCH /transactions/{id}', () => {
  it('rebuilds the shares and records before and after in activity', async () => {
    const db = await withExpense()
    const [oldShare] = rows.shares(db)
    const response = await call(
      db,
      'PATCH',
      '/transactions/t1',
      expense({ description: 'Big shop', totalCents: 12000 }),
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({
      description: 'Big shop',
      totalCents: 12000,
      updatedBy: 'alice',
      createdBy: 'alice',
    })
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 12000, receivedCents: 6000 },
      { personId: 'bob', givenCents: 0, receivedCents: 6000 },
    ])
    // The share rows are rewritten whole, reusing their IDs (D-007).
    expect(rows.shares(db)[0]?.$id).toBe(oldShare?.$id)
    const updated = rows.activity(db).find((row) => row.action === 'transaction.updated')
    expect(updated).toMatchObject({
      actorPersonId: 'alice',
      transactionId: 't1',
      summary: 'Changed “Big shop”: $90.00 → $120.00',
    })
    expect(JSON.parse(updated?.changesJson ?? '')).toMatchObject({
      description: { before: 'Groceries', after: 'Big shop' },
      totalCents: { before: 9000, after: 12000 },
    })
  })

  it('drops shares and items nobody has any more, and adds new ones', async () => {
    const db = await withExpense()
    const response = await call(
      db,
      'PATCH',
      '/transactions/t1',
      expense({
        totalCents: undefined,
        split: undefined,
        items: [{ name: 'Milk', amountCents: 300, split: { mode: 'equal', personIds: ['bob'] } }],
      }),
    )
    expect(response.status).toBe(200)
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 300, receivedCents: 0 },
      { personId: 'bob', givenCents: 0, receivedCents: 300 },
    ])
    expect(rows.items(db)).toMatchObject([{ position: 0, name: 'Milk', amountCents: 300 }])
  })

  it('stays within one transaction when 15 people and 30 items all change', async () => {
    const people = Array.from({ length: 15 }, (_, index) => `p${String(index).padStart(2, '0')}`)
    const db = seed({
      members: [
        ...MEMBERS,
        ...people.map((personId) => ({
          $id: `m-${personId}`,
          groupId: 'house',
          personId,
          displayName: personId,
          role: 'member',
          status: 'placeholder',
          joinedOn: '2026-01-01',
        })),
      ],
    })
    const items = (name: string) =>
      Array.from({ length: 30 }, (_, index) => ({
        name: `${name} ${index}`,
        amountCents: 1500,
        split: { mode: 'equal', personIds: people },
      }))
    const body = (name: string) =>
      expense({
        totalCents: undefined,
        split: undefined,
        payers: [{ personId: 'p00', cents: 45000 }],
        items: items(name),
      })
    const created = await call(db, 'POST', '/transactions', body('Old'))
    expect(created.body.error).toBeUndefined()
    const response = await call(db, 'PATCH', '/transactions/t1', body('New'))
    expect(response.status).toBe(200)
    expect(rows.items(db).map((item) => item.name)).toEqual(items('New').map((item) => item.name))
  })

  it('keeps who paid when an admin edits without payers', async () => {
    const db = await withExpense('u-bob')
    const response = await call(db, 'PATCH', '/transactions/t1', expense({ totalCents: 8000 }))
    expect(response.status).toBe(200)
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 0, receivedCents: 4000 },
      { personId: 'bob', givenCents: 8000, receivedCents: 4000 },
    ])
  })

  it('edits a due bill after the person who added it was removed from the group', async () => {
    const db = seed()
    const bill = {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 1200,
      split: { mode: 'equal', personIds: ['alice', 'cara'] },
      bill: { status: 'due', dueOn: '2026-10-25' },
    }
    expect((await call(db, 'POST', '/transactions', bill, 'u-bob')).status).toBe(200)
    // groups DELETE: Bob has no shares and the bill doesn't name him.
    const { $id } = await db.createTransaction()
    await db.createOperations({
      transactionId: $id,
      operations: [{ action: 'delete', databaseId: 'main', tableId: 'members', rowId: 'm-bob' }],
    })
    await db.updateTransaction({ transactionId: $id, commit: true })
    const response = await call(db, 'PATCH', '/transactions/b1', {
      ...bill,
      bill: { status: 'due', dueOn: '2026-10-26' },
    })
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({ status: 'due', dueOn: '2026-10-26' })
  })

  it('records changed items in the activity row', async () => {
    const items = (name: string) => [
      { name, amountCents: 9000, split: { mode: 'equal', personIds: ['alice', 'bob'] } },
    ]
    const db = seed()
    await call(
      db,
      'POST',
      '/transactions',
      expense({ totalCents: undefined, split: undefined, items: items('Milk') }),
    )
    await call(
      db,
      'PATCH',
      '/transactions/t1',
      expense({ totalCents: undefined, split: undefined, items: items('Oat milk') }),
    )
    const updated = rows.activity(db).find((row) => row.action === 'transaction.updated')
    expect(JSON.parse(updated?.changesJson ?? '')).toEqual({
      items: {
        before: [{ name: 'Milk', amountCents: 9000 }],
        after: [{ name: 'Oat milk', amountCents: 9000 }],
      },
    })
  })

  it('writes nothing when nothing changed', async () => {
    const db = await withExpense()
    const response = await call(db, 'PATCH', '/transactions/t1', {
      ...expense(),
      payers: [{ personId: 'alice', cents: 9000 }],
    })
    expect(response.status).toBe(200)
    expect(rows.activity(db).map((row) => row.action)).toEqual(['transaction.created'])
  })

  it('marks an edited schedule occurrence as overridden', async () => {
    const db = seed({
      transactions: [
        {
          $id: 'sch1_20261020',
          groupId: 'house',
          kind: 'expense',
          status: 'scheduled',
          date: '2026-10-20',
          description: 'Cleaner',
          totalCents: 9000,
          inputJson: JSON.stringify({ split: { mode: 'equal', personIds: ['alice', 'bob'] } }),
          scheduleId: 'sch1',
          overridden: false,
          statementId: null,
          createdBy: 'alice',
          updatedBy: 'alice',
        },
      ],
    })
    const response = await call(
      db,
      'PATCH',
      '/transactions/sch1_20261020',
      expense({ id: 'sch1_20261020', date: '2026-10-21', description: 'Cleaner' }),
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({
      status: 'scheduled',
      date: '2026-10-21',
      overridden: true,
    })
    // Not posted yet, so still no shares (I-6).
    expect(rows.shares(db)).toEqual([])
  })

  it('clears remindedAt when a due bill gets a new due date, and only then', async () => {
    const bill = (dueOn: string) => ({
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 12000,
      bill: { status: 'due', dueOn },
    })
    const db = seed({
      transactions: [
        {
          $id: 'b1',
          groupId: 'house',
          kind: 'bill',
          status: 'due',
          date: '2026-10-20',
          description: 'Power',
          totalCents: 12000,
          inputJson: JSON.stringify({ bill: {} }),
          dueOn: '2026-10-25',
          remindedAt: '2026-10-23T20:00:00.000Z',
          createdBy: 'alice',
          updatedBy: 'alice',
        },
      ],
    })
    await call(db, 'PATCH', '/transactions/b1', bill('2026-10-25'))
    expect(rows.transactions(db)[0]?.remindedAt).toBe('2026-10-23T20:00:00.000Z')
    await call(db, 'PATCH', '/transactions/b1', bill('2026-10-30'))
    expect(rows.transactions(db)[0]).toMatchObject({ dueOn: '2026-10-30', remindedAt: null })
  })

  it('lets an admin edit what someone else added, but not another member', async () => {
    const db = await withExpense('u-bob')
    expect((await call(db, 'PATCH', '/transactions/t1', expense(), 'u-alice')).status).toBe(200)
    const db2 = await withExpense('u-alice')
    const response = await call(db2, 'PATCH', '/transactions/t1', expense(), 'u-bob')
    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe('FORBIDDEN')
  })

  it.each([
    ['a viewer', 'u-cara', 'FORBIDDEN'],
    ['someone outside the group', 'u-dan', 'NOT_A_MEMBER'],
  ])('refuses %s', async (_case, user, code) => {
    const db = await withExpense()
    const response = await call(db, 'PATCH', '/transactions/t1', expense(), user)
    expect(response.body.error?.code).toBe(code)
  })

  it('returns NOT_FOUND for a transaction that does not exist', async () => {
    const response = await call(seed(), 'PATCH', '/transactions/t1', expense())
    expect(response.body.error?.code).toBe('NOT_FOUND')
  })

  it.each([
    ['an id that differs from the path', expense({ id: 't2' })],
    ['another group', expense({ groupId: 'job' })],
    ['another kind', expense({ kind: 'loan' })],
  ])('refuses %s with VALIDATION_FAILED', async (_case, body) => {
    const db = await withExpense()
    const response = await call(db, 'PATCH', '/transactions/t1', body)
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('refuses to edit a voided transaction or to pay a due bill by editing it', async () => {
    const db = await withExpense()
    await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect((await call(db, 'PATCH', '/transactions/t1', expense())).body.error?.code).toBe(
      'VALIDATION_FAILED',
    )
    const bill = {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-20',
      description: 'Electricity',
      totalCents: 12000,
      bill: { status: 'due', dueOn: '2026-10-25' },
    }
    await call(db, 'POST', '/transactions', bill)
    const paid = await call(db, 'PATCH', '/transactions/b1', {
      ...bill,
      bill: { status: 'paid' },
    })
    expect(paid.body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('refuses a locked transaction with LOCKED, admins included', async () => {
    const db = await withExpense()
    const locked = seed({
      transactions: rows.transactions(db).map((row) => ({ ...row, statementId: 'st1' })),
    })
    const response = await call(locked, 'PATCH', '/transactions/t1', expense({ totalCents: 1 }))
    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('LOCKED')
  })

  it('refuses to move a transaction out of a period being finalized', async () => {
    const db = await withExpense()
    await db.updateTransaction({
      transactionId: (
        await db.createOperations({
          transactionId: (await db.createTransaction()).$id,
          operations: [
            {
              action: 'create',
              databaseId: 'main',
              tableId: 'statements',
              rowId: 'st1',
              data: {
                groupId: 'house',
                type: 'divide',
                periodStart: '2026-10-01',
                periodEnd: '2026-10-31',
                status: 'finalizing',
                snapshotJson: '{}',
              },
            },
          ],
        })
      ).$id,
      commit: true,
    })
    const response = await call(db, 'PATCH', '/transactions/t1', expense({ date: '2026-11-02' }))
    expect(response.body.error?.code).toBe('LOCKED')
    expect(rows.transactions(db)[0]?.date).toBe('2026-10-10')
  })

  it('returns LOCKED, writing nothing, when finalize locks the row before the edit stages', async () => {
    const db = await withExpense()
    const stage = db.createOperations.bind(db)
    // Finalize commits its lock just before the edit's first staging.
    vi.spyOn(db, 'createOperations').mockImplementationOnce(async (params) => {
      const lock = await db.createTransaction()
      await stage({
        transactionId: lock.$id,
        operations: [
          {
            action: 'update',
            databaseId: 'main',
            tableId: 'transactions',
            rowId: 't1',
            data: { statementId: 'st1' },
          },
        ],
      })
      await db.updateTransaction({ transactionId: lock.$id, commit: true })
      return stage(params)
    })
    const response = await call(db, 'PATCH', '/transactions/t1', expense({ totalCents: 1 }))
    expect(response.body.error?.code).toBe('LOCKED')
    expect(rows.transactions(db)[0]?.totalCents).toBe(9000)
  })
})
