import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amounts, call, expense, MEMBERS, member, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

const dueBill = {
  id: 'b1',
  groupId: 'house',
  kind: 'bill',
  date: '2026-10-20',
  description: 'Electricity',
  totalCents: 12000,
  split: { mode: 'equal', personIds: ['alice', 'bob'] },
  bill: { status: 'due', dueOn: '2026-10-25' },
}

// A Thursday shift the scheduler made: 5 hours at $25.00, not posted yet.
const scheduledShift = {
  $id: 'sch1_20261016',
  groupId: 'job',
  kind: 'shift',
  status: 'scheduled',
  date: '2026-10-16',
  description: 'Thursday',
  totalCents: 12500,
  inputJson: JSON.stringify({ shift: { minutes: 300, rateCents: 2500 } }),
  scheduleId: 'sch1',
  overridden: false,
  statementId: null,
  createdBy: 'sam',
  updatedBy: 'sam',
}

describe('POST /transactions/{id}/post', () => {
  it('pays a due bill: whoever posts it paid, on the day given', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', dueBill, 'u-bob')
    const response = await call(
      db,
      'POST',
      '/transactions/b1/post',
      { date: '2026-10-22' },
      'u-bob',
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({
      status: 'posted',
      date: '2026-10-22',
      dueOn: '2026-10-25',
      updatedBy: 'bob',
    })
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '').payers).toEqual([
      { personId: 'bob', cents: 12000 },
    ])
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'alice', givenCents: 0, receivedCents: 6000 },
      { personId: 'bob', givenCents: 12000, receivedCents: 6000 },
    ])
    expect(rows.shares(db)[0]).toMatchObject({ date: '2026-10-22', kind: 'bill' })
    const posted = rows.activity(db).find((row) => row.action === 'transaction.posted')
    expect(posted).toMatchObject({
      actorPersonId: 'bob',
      summary: 'Posted “Electricity” ($120.00)',
    })
    expect(JSON.parse(posted?.changesJson ?? '')).toMatchObject({
      status: { before: 'due', after: 'posted' },
      date: { before: '2026-10-20', after: '2026-10-22' },
    })
  })

  it('takes payers from the body', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', dueBill, 'u-bob')
    await call(
      db,
      'POST',
      '/transactions/b1/post',
      {
        payers: [{ personId: 'alice', cents: 12000 }],
      },
      'u-bob',
    )
    expect(amounts(rows.shares(db))[0]).toEqual({
      personId: 'alice',
      givenCents: 12000,
      receivedCents: 6000,
    })
  })

  it('posts a scheduled shift with the hours actually worked', async () => {
    const db = seed({ transactions: [scheduledShift] })
    const response = await call(
      db,
      'POST',
      '/transactions/sch1_20261016/post',
      { shift: { minutes: 330 } },
      'u-sam',
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({ status: 'posted', totalCents: 13750 })
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '').shift).toEqual({
      minutes: 330,
      rateCents: 2500,
    })
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'acme', givenCents: 0, receivedCents: 13750 },
      { personId: 'sam', givenCents: 13750, receivedCents: 0 },
    ])
  })

  it('turns a shift worth more than the maximum into VALIDATION_FAILED', async () => {
    const db = seed({ transactions: [scheduledShift] })
    const response = await call(
      db,
      'POST',
      '/transactions/sch1_20261016/post',
      { shift: { minutes: 1440, rateCents: 1_000_000_000 } },
      'u-sam',
    )
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.status).toBe('scheduled')
  })

  it.each([
    [
      'a posted transaction on another day',
      async (db: ReturnType<typeof seed>) => {
        await call(db, 'POST', '/transactions', expense())
        return call(db, 'POST', '/transactions/t1/post', { date: '2026-10-11' })
      },
    ],
    [
      'shift hours on an expense',
      async (db: ReturnType<typeof seed>) => {
        await call(db, 'POST', '/transactions', dueBill)
        return call(db, 'POST', '/transactions/b1/post', { shift: { minutes: 60 } })
      },
    ],
  ])('refuses to post %s', async (_case, run) => {
    const response = await run(seed())
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('checks the body and the stored input together, as for a new transaction', async () => {
    // Alice and 14 others share the bill; payers from the body would make it sixteen.
    const others = Array.from({ length: 14 }, (_, index) => `p${index}`)
    const people = ['alice', ...others]
    const db = seed({
      members: [
        ...MEMBERS,
        ...[...others, 'q'].map((id) => member(`m-${id}`, 'house', id, 'member', 'placeholder')),
      ],
    })
    await call(db, 'POST', '/transactions', {
      ...dueBill,
      totalCents: 1500,
      split: { mode: 'equal', personIds: people },
    })
    const response = await call(db, 'POST', '/transactions/b1/post', {
      payers: [
        { personId: 'p0', cents: 1500 },
        { personId: 'q', cents: 0 },
      ],
    })
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.status).toBe('due')
  })

  it('refuses payers on a shift', async () => {
    const db = seed({ transactions: [scheduledShift] })
    const response = await call(
      db,
      'POST',
      '/transactions/sch1_20261016/post',
      { payers: [{ personId: 'sam', cents: 12500 }] },
      'u-sam',
    )
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.status).toBe('scheduled')
  })

  it('gives a retried post the posted transaction back, writing nothing', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', dueBill, 'u-bob')
    const first = await call(db, 'POST', '/transactions/b1/post', { date: '2026-10-22' }, 'u-bob')
    const again = await call(db, 'POST', '/transactions/b1/post', { date: '2026-10-22' }, 'u-bob')
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual(first.body.data)
    expect(rows.activity(db).map((row) => row.action)).toEqual([
      'transaction.created',
      'transaction.posted',
    ])
  })

  it('refuses a viewer', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', dueBill)
    const response = await call(db, 'POST', '/transactions/b1/post', {}, 'u-cara')
    expect(response.body.error?.code).toBe('FORBIDDEN')
  })
})

describe('POST /transactions/{id}/void', () => {
  it('voids: keeps the row and its items, deletes the shares', async () => {
    const db = seed()
    await call(
      db,
      'POST',
      '/transactions',
      expense({
        totalCents: undefined,
        split: undefined,
        items: [{ name: 'Milk', amountCents: 300, split: { mode: 'equal', personIds: ['bob'] } }],
      }),
    )
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: ' Duplicate ' })
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({ status: 'void', voidReason: 'Duplicate' })
    expect(rows.shares(db)).toEqual([])
    expect(rows.items(db)).toHaveLength(1)
    const voided = rows.activity(db).find((row) => row.action === 'transaction.voided')
    expect(voided).toMatchObject({ summary: 'Voided “Groceries”' })
    expect(JSON.parse(voided?.changesJson ?? '')).toEqual({
      status: { before: 'posted', after: 'void' },
      voidReason: { before: null, after: 'Duplicate' },
    })
  })

  it('gives a retried void the voided transaction back, writing nothing', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    const first = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    const again = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual(first.body.data)
    expect(rows.activity(db)).toHaveLength(2)
  })

  it('voids a schedule occurrence, which then keeps blocking its re-creation', async () => {
    const db = seed({ transactions: [scheduledShift] })
    const response = await call(
      db,
      'POST',
      '/transactions/sch1_20261016/void',
      { reason: 'Sick' },
      'u-sam',
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)).toMatchObject([{ $id: 'sch1_20261016', status: 'void' }])
  })

  it.each([
    ['an empty reason', { reason: '  ' }, 'VALIDATION_FAILED'],
    ['an unknown field', { reason: 'x', extra: 1 }, 'VALIDATION_FAILED'],
  ])('refuses %s', async (_case, body, code) => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    expect((await call(db, 'POST', '/transactions/t1/void', body)).body.error?.code).toBe(code)
  })

  it('refuses a void with another reason, a member who did not add it, and a lock', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    expect(
      (await call(db, 'POST', '/transactions/t1/void', { reason: 'x' }, 'u-bob')).body.error?.code,
    ).toBe('FORBIDDEN')
    await call(db, 'POST', '/transactions/t1/void', { reason: 'x' })
    expect(
      (await call(db, 'POST', '/transactions/t1/void', { reason: 'y' })).body.error?.code,
    ).toBe('VALIDATION_FAILED')
    const locked = seed({
      transactions: [{ ...scheduledShift, status: 'posted', statementId: 'st1' }],
    })
    const response = await call(
      locked,
      'POST',
      '/transactions/sch1_20261016/void',
      { reason: 'x' },
      'u-sam',
    )
    expect(response.body.error?.code).toBe('LOCKED')
  })
})
