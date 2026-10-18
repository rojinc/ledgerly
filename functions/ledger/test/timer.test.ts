import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amounts, call, GROUPS, MEMBERS, member, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

// NOW is 12:00 on 18 October in Sydney (AEDT, UTC+11).
const later = (minutes: number, seconds = 0) =>
  vi.setSystemTime(NOW.getTime() + (minutes * 60 + seconds) * 1000)

const start = (extra: Record<string, unknown> = {}) => ({ id: 'tm1', groupId: 'job', ...extra })
const startTimer = (db: Db, body: unknown = start()) =>
  call(db, 'POST', '/timer/start', body, 'u-sam')
const stopTimer = (db: Db, body: Record<string, unknown> = {}) =>
  call(db, 'POST', '/timer/stop', { transactionId: 'tm1', ...body }, 'u-sam')
// The groups, with the employer group changed.
const jobWith = (changes: Record<string, unknown>) =>
  GROUPS.map((group) => (group.$id === 'job' ? { ...group, ...changes } : group))
const shiftOf = (db: Db) => JSON.parse(rows.transactions(db)[0]?.inputJson ?? '{}').shift

// A second employer group, where Sam works for Bolt.
const secondJob = {
  groups: [...GROUPS, { ...GROUPS[1], $id: 'job2', name: 'Bolt' }],
  members: [
    ...MEMBERS,
    member('m-sam2', 'job2', 'sam', 'admin'),
    member('m-bolt', 'job2', 'bolt', 'member', 'placeholder'),
  ],
}

describe('POST /timer/start', () => {
  it('starts a running shift today, at the group’s rate, with no shares (I-6)', async () => {
    const db = seed()
    const response = await startTimer(db)
    expect(response.status).toBe(200)
    expect(response.body.data?.transaction).toMatchObject({
      $id: 'tm1',
      groupId: 'job',
      kind: 'shift',
      status: 'running',
      date: '2026-10-18',
      description: 'Shift',
      totalCents: 0,
      startedAt: NOW.toISOString(),
      createdBy: 'sam',
    })
    expect(shiftOf(db)).toEqual({ minutes: 0, rateCents: 2500, startTime: '12:00' })
    expect(response.body.data?.shares).toEqual([])
    expect(rows.shares(db)).toEqual([])
    expect(rows.activity(db)).toMatchObject([
      {
        action: 'transaction.created',
        actorPersonId: 'sam',
        transactionId: 'tm1',
        summary: 'Started the timer for “Shift”',
      },
    ])
  })

  it('takes the rate and description from the body', async () => {
    const db = seed()
    await startTimer(db, start({ rateCents: 4000, description: 'Night shift' }))
    expect(rows.transactions(db)[0]?.description).toBe('Night shift')
    expect(shiftOf(db).rateCents).toBe(4000)
  })

  it('dates the shift in the group’s time zone', async () => {
    // 23:30 on 17 October in Perth is already 18 October in UTC+11 Sydney.
    vi.setSystemTime(new Date('2026-10-17T15:30:00.000Z'))
    const db = seed({ groups: jobWith({ timezone: 'Australia/Perth' }) })
    await startTimer(db)
    expect(rows.transactions(db)[0]?.date).toBe('2026-10-17')
    expect(shiftOf(db).startTime).toBe('23:30')
  })

  it('refuses a second timer with CONFLICT naming the running one', async () => {
    const db = seed()
    await startTimer(db)
    const response = await startTimer(db, start({ id: 'tm2' }))
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { transactionId: 'tm1' },
    })
    expect(rows.transactions(db)).toHaveLength(1)
  })

  it('counts a timer running in another group too', async () => {
    const db = seed(secondJob)
    await startTimer(db)
    const response = await startTimer(db, start({ id: 'tm2', groupId: 'job2' }))
    expect(response.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { transactionId: 'tm1' },
    })
  })

  it('starts a new timer once the last one has stopped', async () => {
    const db = seed()
    await startTimer(db)
    later(60)
    await stopTimer(db)
    const response = await startTimer(db, start({ id: 'tm2' }))
    expect(response.status).toBe(200)
    expect(response.body.data?.transaction.status).toBe('running')
  })

  it('gives a retry the same timer back, even the next day', async () => {
    const db = seed()
    const first = await startTimer(db)
    later(24 * 60)
    const retry = await startTimer(db)
    expect(retry.status).toBe(200)
    expect(retry.body.data?.transaction).toEqual(first.body.data?.transaction)
    expect(rows.transactions(db)).toHaveLength(1)
    expect(rows.activity(db)).toHaveLength(1)
  })

  it('refuses an ID that another transaction, or a different timer, has', async () => {
    const db = seed()
    await startTimer(db)
    expect((await startTimer(db, start({ rateCents: 3000 }))).body.error?.code).toBe('CONFLICT')
    expect((await startTimer(db, start({ description: 'Other' }))).body.error?.code).toBe(
      'CONFLICT',
    )
    const shift = {
      id: 'sh1',
      groupId: 'job',
      kind: 'shift',
      date: '2026-10-17',
      description: 'Shift',
      shift: { minutes: 60, rateCents: 2500 },
    }
    await call(db, 'POST', '/transactions', shift, 'u-sam')
    expect((await startTimer(db, start({ id: 'sh1' }))).body.error?.code).toBe('CONFLICT')
  })

  it('refuses a voided timer’s ID', async () => {
    const db = seed()
    await startTimer(db)
    await call(db, 'POST', '/transactions/tm1/void', { reason: 'Mistake' }, 'u-sam')
    expect((await startTimer(db)).body.error?.code).toBe('CONFLICT')
  })

  it('refuses an ID kept for schedule occurrences', async () => {
    const db = seed()
    const response = await startTimer(db, start({ id: 'sch1_20261018' }))
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('is for employer groups, and only their admin', async () => {
    const db = seed()
    const house = await call(db, 'POST', '/timer/start', start({ groupId: 'house' }), 'u-alice')
    expect(house.body.error?.code).toBe('VALIDATION_FAILED')
    const bob = await call(db, 'POST', '/timer/start', start({ groupId: 'house' }), 'u-bob')
    expect(bob.body.error?.code).toBe('FORBIDDEN')
    const dan = await call(db, 'POST', '/timer/start', start(), 'u-dan')
    expect(dan.body.error?.code).toBe('NOT_A_MEMBER')
    expect(rows.transactions(db)).toEqual([])
  })

  it('refuses an archived group and a bad body', async () => {
    const groups = jobWith({ archivedAt: '2026-10-01T00:00:00.000Z' })
    expect((await startTimer(seed({ groups }))).body.error?.code).toBe('ARCHIVED')
    const db = seed()
    expect((await startTimer(db, start({ minutes: 5 }))).body.error?.code).toBe('VALIDATION_FAILED')
    expect((await startTimer(db, start({ rateCents: -1 }))).body.error?.code).toBe(
      'VALIDATION_FAILED',
    )
  })
})

describe('POST /timer/stop', () => {
  it('posts the whole minutes since the start, less the break', async () => {
    const db = seed()
    await startTimer(db)
    later(150, 59)
    const response = await stopTimer(db, { breakMinutes: 30 })
    expect(response.status).toBe(200)
    expect(response.body.data?.transaction).toMatchObject({
      status: 'posted',
      date: '2026-10-18',
      totalCents: 5000,
      startedAt: NOW.toISOString(),
    })
    // 2 h 30 min 59 s is 150 whole minutes; 120 are paid at $25.00 an hour.
    expect(shiftOf(db)).toEqual({
      minutes: 120,
      rateCents: 2500,
      breakMinutes: 30,
      startTime: '12:00',
      endTime: '14:30',
    })
    expect(amounts(rows.shares(db))).toEqual([
      { personId: 'acme', givenCents: 0, receivedCents: 5000 },
      { personId: 'sam', givenCents: 5000, receivedCents: 0 },
    ])
    expect(rows.activity(db)[1]).toMatchObject({
      action: 'transaction.posted',
      actorPersonId: 'sam',
      summary: 'Stopped the timer for “Shift” ($50.00)',
      changesJson: JSON.stringify({
        status: { before: 'running', after: 'posted' },
        totalCents: { before: 0, after: 5000 },
        inputJson: {
          before: JSON.stringify({ shift: { minutes: 0, rateCents: 2500, startTime: '12:00' } }),
          after: rows.transactions(db)[0]?.inputJson,
        },
      }),
    })
  })

  it('keeps the day it started on, past midnight', async () => {
    vi.setSystemTime(new Date('2026-10-18T12:30:00.000Z'))
    const db = seed()
    await startTimer(db)
    vi.setSystemTime(new Date('2026-10-18T14:15:00.000Z'))
    await stopTimer(db)
    expect(rows.transactions(db)[0]?.date).toBe('2026-10-18')
    expect(shiftOf(db)).toEqual({
      minutes: 105,
      rateCents: 2500,
      startTime: '23:30',
      endTime: '01:15',
    })
  })

  it('refuses a break longer than the timer ran', async () => {
    const db = seed()
    await startTimer(db)
    later(20)
    const response = await stopTimer(db, { breakMinutes: 21 })
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.status).toBe('running')
    expect((await stopTimer(db, { breakMinutes: 20 })).body.data?.transaction.totalCents).toBe(0)
  })

  it('refuses more than a day of paid time, unless the break brings it under', async () => {
    const db = seed()
    await startTimer(db)
    later(24 * 60 + 30)
    const response = await stopTimer(db)
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'This timer ran for more than a day. Void it and add the shift by hand.',
    })
    expect(rows.transactions(db)[0]?.status).toBe('running')
    const withBreak = await stopTimer(db, { breakMinutes: 30 })
    expect(withBreak.body.data?.transaction.totalCents).toBe(60000)
  })

  it('gives a retry with the same break the posted shift back', async () => {
    const db = seed()
    await startTimer(db)
    later(60)
    const first = await stopTimer(db, { breakMinutes: 10 })
    later(5)
    const retry = await stopTimer(db, { breakMinutes: 10 })
    expect(retry.status).toBe(200)
    expect(retry.body.data?.transaction).toEqual(first.body.data?.transaction)
    expect(rows.activity(db)).toHaveLength(2)
    expect((await stopTimer(db, { breakMinutes: 0 })).body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('treats a missing break as no break on a retry', async () => {
    const db = seed()
    await startTimer(db)
    later(60)
    await stopTimer(db)
    expect((await stopTimer(db, { breakMinutes: 0 })).status).toBe(200)
  })

  it('stops only a timer: not another shift, nor a voided timer', async () => {
    const db = seed()
    const shift = {
      id: 'sh1',
      groupId: 'job',
      kind: 'shift',
      date: '2026-10-17',
      description: 'Shift',
      shift: { minutes: 60, rateCents: 2500 },
    }
    await call(db, 'POST', '/transactions', shift, 'u-sam')
    const notTimer = await stopTimer(db, { transactionId: 'sh1' })
    expect(notTimer.body.error?.code).toBe('VALIDATION_FAILED')
    await startTimer(db)
    await call(db, 'POST', '/transactions/tm1/void', { reason: 'Mistake' }, 'u-sam')
    expect((await stopTimer(db)).body.error?.code).toBe('VALIDATION_FAILED')
    expect((await stopTimer(db, { transactionId: 'nope' })).body.error?.code).toBe('NOT_FOUND')
  })

  it('is only for the person who started it', async () => {
    // Acme has joined the group as a member.
    const db = seed({
      members: [
        ...MEMBERS.filter((row) => row.$id !== 'm-acme'),
        member('m-acme', 'job', 'acme', 'member'),
      ],
    })
    const { $id } = await db.createTransaction()
    const update = { action: 'update', databaseId: 'main', tableId: 'persons', rowId: 'acme' }
    await db.createOperations({
      transactionId: $id,
      operations: [{ ...update, data: { userId: 'u-acme' } }],
    })
    await db.updateTransaction({ transactionId: $id, commit: true })
    await startTimer(db)
    later(60)
    const acme = await call(db, 'POST', '/timer/stop', { transactionId: 'tm1' }, 'u-acme')
    expect(acme.body.error?.code).toBe('FORBIDDEN')
    const dan = await call(db, 'POST', '/timer/stop', { transactionId: 'tm1' }, 'u-dan')
    expect(dan.body.error?.code).toBe('NOT_A_MEMBER')
    expect(rows.transactions(db)[0]?.status).toBe('running')
  })

  it('is LOCKED while a statement covering its day is finalizing', async () => {
    const db = seed({
      statements: [
        {
          $id: 'st1',
          groupId: 'job',
          type: 'employer',
          periodStart: '2026-10-12',
          periodEnd: '2026-10-18',
          status: 'finalizing',
          snapshotJson: '{}',
        },
      ],
    })
    await startTimer(db)
    later(60)
    expect((await stopTimer(db)).body.error?.code).toBe('LOCKED')
    expect(rows.transactions(db)[0]?.status).toBe('running')
  })

  it('refuses a stop that lost to a void, and posts nothing', async () => {
    const db = seed()
    await startTimer(db)
    later(60)
    const stage = db.createOperations.bind(db)
    vi.spyOn(db, 'createOperations').mockImplementationOnce(async (params) => {
      await call(db, 'POST', '/transactions/tm1/void', { reason: 'Mistake' }, 'u-sam')
      return stage(params)
    })
    const response = await stopTimer(db)
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.status).toBe('void')
    expect(rows.shares(db)).toEqual([])
  })
})

describe('two starts at once', () => {
  it('a start that finds the other committed before its check gets CONFLICT', async () => {
    const db = seed()
    const stage = db.createOperations.bind(db)
    vi.spyOn(db, 'createOperations').mockImplementationOnce(async (params) => {
      await startTimer(db, start({ id: 'tm2' }))
      return stage(params)
    })
    const response = await startTimer(db)
    expect(response.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { transactionId: 'tm2' },
    })
    expect(rows.transactions(db).map((row) => row.$id)).toEqual(['tm2'])
  })

  it('a start that the other beat to the commit runs again and gets CONFLICT', async () => {
    const db = seed()
    const update = db.updateTransaction.bind(db)
    vi.spyOn(db, 'updateTransaction').mockImplementationOnce(async (params) => {
      if (params.commit) await startTimer(db, start({ id: 'tm2' }))
      return update(params)
    })
    const response = await startTimer(db)
    expect(response.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { transactionId: 'tm2' },
    })
    expect(rows.transactions(db).map((row) => row.$id)).toEqual(['tm2'])
  })
})
