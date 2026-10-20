import { type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import type { Schedules, Transactions } from '@ledgerly/core/generated/rows'
import type {
  EndedSchedule,
  PausedSchedule,
  ResumedSchedule,
  ScheduleResult,
  UpdatedSchedule,
} from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../src/routes/run'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  group,
  member,
  NOW,
  ok,
  person,
} from './harness'

// NOW is 07:00 on Monday 19 October in Sydney. Sam (u1) owns Acme, an employer group with Acme
// as the other member, and the house Elm St, where Alex (u2) is a member and Kim (u3) a viewer.
function seeded() {
  return fakes(
    {
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pKim', 'u3'),
        person('pAcme', null),
      ],
      groups: [
        group('acme', 'pSam'),
        group('elm', 'pSam', { type: 'house', name: 'Elm St', settingsJson: '{"type":"house"}' }),
        group('old', 'pSam', { archivedAt: '2026-10-01T00:00:00Z' }),
      ],
      members: [
        member('acme', 'pSam'),
        member('acme', 'pAcme', { status: 'placeholder' }),
        member('elm', 'pSam'),
        member('elm', 'pAlex', { role: 'member' }),
        member('elm', 'pKim', { role: 'viewer' }),
        member('old', 'pSam'),
        member('old', 'pAcme', { status: 'placeholder' }),
      ],
    },
    { accounts: {} },
  )
}

const ID = 'thursdaysAcmeSam0001'

const thursdays = {
  id: ID,
  groupId: 'acme',
  kind: 'shift',
  description: 'Thursday shift',
  template: { category: 'work', shift: { minutes: 300, rateCents: 2500 } },
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  startsOn: '2026-10-01',
  skipPublicHolidays: true,
  autoPost: false,
}

const rent = {
  id: 'rentElmSam0000000001',
  groupId: 'elm',
  kind: 'bill',
  description: 'Rent',
  template: {
    category: 'rent',
    totalCents: 90_000,
    split: { mode: 'equal', personIds: ['pSam', 'pAlex'] },
    bill: { status: 'due' },
  },
  rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
  startsOn: '2026-11-01',
  skipPublicHolidays: false,
  autoPost: false,
}

// Every day for 120 days: 121 occurrences with 2 items each, so 5 transactions of writes.
const groceries = {
  id: 'groceriesElm00000001',
  groupId: 'elm',
  kind: 'expense',
  description: 'Groceries',
  template: {
    items: [
      { name: 'Milk', amountCents: 400, split: { mode: 'equal', personIds: ['pSam', 'pAlex'] } },
      { name: 'Bread', amountCents: 600, split: { mode: 'equal', personIds: ['pSam'] } },
    ],
  },
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
  startsOn: '2026-10-19',
  skipPublicHolidays: false,
  autoPost: false,
  horizonDays: 120,
}

function occurrences(services: Fakes, scheduleId = ID): Transactions[] {
  return services.db
    .rows('transactions')
    .filter((row) => row.scheduleId === scheduleId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))) as unknown as Transactions[]
}

function scheduleRow(services: Fakes, id = ID): Schedules | undefined {
  return services.db.rows('schedules').find((row) => row.$id === id) as unknown as
    | Schedules
    | undefined
}

function runCron(services: Fakes) {
  return ok<RunResult>(services, 'POST', '/', { userId: null, scheduled: true })
}

// Fails the commits counted in `which` (from 1), as a timeout would, or as `error` says.
function failCommit(
  services: Fakes,
  which: number | number[],
  error = () => new Error('Timed out'),
) {
  const commit = services.db.updateTransaction.bind(services.db)
  let commits = 0
  return vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit && [which].flat().includes(++commits)) throw error()
    return commit(params)
  })
}

// Appwrite's answer to a commit that lost a race.
const lostRace = () => new AppwriteException('Conflict', 409, 'transaction_conflict')

function create(services: Fakes, body: object, userId = 'u1') {
  return ok<ScheduleResult>(services, 'POST', '/schedules', { body, userId })
}

function archive(services: Fakes, groupId = 'acme') {
  return withTransaction(services.db, (tx) =>
    tx.write({
      action: 'update',
      tableId: 'groups',
      rowId: groupId,
      data: { archivedAt: '2026-10-18T21:00:00.000Z' },
    }),
  )
}

function setRow(
  services: Fakes,
  tableId: 'transactions' | 'members' | 'persons',
  rowId: string,
  data: object,
) {
  return withTransaction(services.db, (tx) =>
    tx.write({ action: 'update', tableId, rowId, data: { ...data } }),
  )
}

describe('POST /schedules', () => {
  it('creates the schedule and its occurrences up to the horizon at once', async () => {
    const services = seeded()
    const { schedule, created } = await create(services, thursdays)
    // Every Thursday from 1 October to 14 December (today + 56 days).
    expect(created).toBe(11)
    const rows = occurrences(services)
    expect(rows.map((row) => row.date)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
      '2026-11-12',
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
      '2026-12-10',
    ])
    expect(rows[0]).toMatchObject({
      $id: `${ID}_20261001`,
      groupId: 'acme',
      kind: 'shift',
      status: 'scheduled',
      description: 'Thursday shift',
      category: 'work',
      totalCents: 12_500,
      scheduleId: ID,
      overridden: false,
      createdBy: 'pSam',
      updatedBy: 'pSam',
      $permissions: ['read("team:acme")'],
    })
    expect(JSON.parse(rows[0]?.inputJson ?? '{}')).toEqual({
      shift: { minutes: 300, rateCents: 2500 },
    })
    expect(schedule).toMatchObject({
      groupId: 'acme',
      horizonDays: 56,
      generatedThrough: '2026-12-14',
      // 00:05 on 20 October in Sydney.
      nextRunAt: '2026-10-19T13:05:00.000Z',
      createdBy: 'pSam',
    })
    expect(JSON.parse(schedule.templateJson)).toEqual(thursdays.template)
  })

  it('skips public holidays in the group’s region', async () => {
    const services = seeded()
    const mondays = { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=MO', horizonDays: 7 }
    await create(services, mondays)
    // NSW Labour Day is Monday 5 October.
    expect(occurrences(services).map((row) => row.date)).toEqual([
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ])
  })

  it('skips the public holidays of a region set just before its expansion guards the group', async () => {
    const services = seeded()
    // Tuesdays, holidays skipped. 3 November is Melbourne Cup Day in Victoria, not in NSW.
    const tuesdays = { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=TU', skipPublicHolidays: true }
    beforeStaging(
      services.db,
      // The expansion's guard, once the schedule is saved: not the one saving it.
      (operations) =>
        operations.includes('"tableId":"groups"') && scheduleRow(services) !== undefined,
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'groups',
            rowId: 'acme',
            data: { region: 'AU-VIC' },
          }),
        ),
    )
    await create(services, tuesdays)
    const dates = occurrences(services).map((row) => row.date)
    expect(dates).toContain('2026-10-27')
    expect(dates).not.toContain('2026-11-03')
    expect(dates).toContain('2026-11-10')
  })

  it('makes bills due on their own date, and lets a house member add their own', async () => {
    const services = seeded()
    const { created } = await create(services, rent, 'u2')
    expect(created).toBe(2)
    expect(occurrences(services, rent.id)).toMatchObject([
      { date: '2026-11-01', dueOn: '2026-11-01', status: 'due', totalCents: 90_000 },
      { date: '2026-12-01', dueOn: '2026-12-01', status: 'due', totalCents: 90_000 },
    ])
    expect(scheduleRow(services, rent.id)?.createdBy).toBe('pAlex')
  })

  it('writes items, and splits a long expansion into transactions of at most 90 writes', async () => {
    const services = seeded()
    const begin = vi.spyOn(services.db, 'createTransaction')
    const { created } = await create(services, groceries)
    // 19 October to 16 February.
    expect(created).toBe(121)
    expect(occurrences(services, groceries.id)[0]).toMatchObject({ totalCents: 1000 })
    const items = services.db.rows('items')
    expect(items).toHaveLength(242)
    expect(items[0]).toMatchObject({ transactionId: 'groceriesElm00000001_20261019', name: 'Milk' })
    // 3 writes per occurrence plus 4 guards: 121 occurrences need 5 transactions, plus the create.
    expect(begin.mock.calls.length).toBeGreaterThanOrEqual(6)
    // Deleting them takes batches of at most 90 writes too, with the group's guard.
    expect(await ok(services, 'DELETE', `/schedules/${groceries.id}`)).toEqual({})
    expect(services.db.rows('transactions')).toEqual([])
    expect(services.db.rows('items')).toEqual([])
  })

  it('returns the schedule again for a retry, and refuses the same id with other content', async () => {
    const services = seeded()
    await create(services, thursdays)
    const again = await create(services, thursdays)
    expect(again.created).toBe(0)
    expect(occurrences(services)).toHaveLength(11)
    expect(
      await failure(services, 'POST', '/schedules', {
        body: { ...thursdays, description: 'Other' },
      }),
    ).toEqual({ status: 409, code: 'CONFLICT' })
    // Another admin sending the same body didn't make it, so it isn't a retry.
    await setRow(services, 'members', 'acme-pAcme', { status: 'active' })
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'update', tableId: 'persons', rowId: 'pAcme', data: { userId: 'u9' } }),
    )
    expect(
      await failure(services, 'POST', '/schedules', { body: thursdays, userId: 'u9' }),
    ).toEqual({ status: 409, code: 'CONFLICT' })
  })

  it('starts at most 31 days before today in the group’s timezone', async () => {
    // Today is 19 October in Sydney, still 18 October in UTC.
    const services = seeded()
    expect(
      await failure(services, 'POST', '/schedules', {
        body: { ...thursdays, startsOn: '2026-09-17' },
      }),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' })
    expect(services.db.rows('schedules')).toEqual([])
    // Thursday 24 September to 10 December.
    expect((await create(services, { ...thursdays, startsOn: '2026-09-18' })).created).toBe(12)
  })

  it('checks the template against the ledger before writing anything', async () => {
    const services = seeded()
    const stranger = {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam', 'pNobody'] } },
    }
    expect(await failure(services, 'POST', '/schedules', { body: stranger })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    // A template has no receipts, not even an empty list (functions-api.md#scheduler).
    for (const receiptFileIds of [['file1'], []]) {
      const receipts = { ...rent, template: { ...rent.template, receiptFileIds } }
      expect(await failure(services, 'POST', '/schedules', { body: receipts })).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
      })
    }
    expect(services.db.rows('schedules')).toEqual([])
    expect(services.db.rows('transactions')).toEqual([])
  })

  it('is for admins, and in a house for members too', async () => {
    const services = seeded()
    const send = (body: object, userId: string | null) =>
      failure(services, 'POST', '/schedules', { body, userId })
    expect(await send(rent, 'u3')).toEqual({ status: 403, code: 'FORBIDDEN' })
    expect(await send({ ...thursdays, groupId: 'old' }, 'u1')).toEqual({
      status: 409,
      code: 'ARCHIVED',
    })
    expect(await send(thursdays, 'u2')).toEqual({ status: 403, code: 'NOT_A_MEMBER' })
    expect(await send(thursdays, null)).toEqual({ status: 401, code: 'UNAUTHENTICATED' })
    expect(await send({ ...thursdays, rrule: 'FREQ=DAILY' }, 'u1')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
  })

  it('refuses a member in a group that isn’t a house', async () => {
    const services = seeded()
    await setRow(services, 'members', 'acme-pAcme', { status: 'active', role: 'member' })
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'update', tableId: 'persons', rowId: 'pAcme', data: { userId: 'u9' } }),
    )
    expect(
      await failure(services, 'POST', '/schedules', { body: thursdays, userId: 'u9' }),
    ).toEqual({ status: 403, code: 'FORBIDDEN' })
  })

  it('can’t name someone whose member row is deleted while it commits', async () => {
    const services = seeded()
    const commit = services.db.updateTransaction.bind(services.db)
    let first = true
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && first) {
        first = false
        // An admin removes Alex just after the schedule's guard was staged.
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'members', rowId: 'elm-pAlex' }),
        )
      }
      return commit(params)
    })
    expect(await failure(services, 'POST', '/schedules', { body: rent })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('schedules')).toEqual([])
    expect(services.db.rows('transactions')).toEqual([])
  })

  it('makes a member’s removal fail if the schedule naming them commits first', async () => {
    const services = seeded()
    // Starting after the horizon, so only the schedule's own write guards Alex.
    const later = { ...rent, startsOn: '2027-06-01' }
    const removal = withTransaction(services.db, async (tx) => {
      await tx.write({ action: 'delete', tableId: 'members', rowId: 'elm-pAlex' })
      expect((await create(services, later)).created).toBe(0)
    })
    await expect(removal).rejects.toMatchObject({ code: 409 })
    expect(services.db.rows('members').some((row) => row.$id === 'elm-pAlex')).toBe(true)
  })

  it('leaves its occurrences for the next cron run if it stops partway', async () => {
    const services = seeded()
    // The schedule, the first batch, then a timeout.
    const timeout = failCommit(services, 3)
    expect(await failure(services, 'POST', '/schedules', { body: groceries })).toMatchObject({
      status: 500,
    })
    timeout.mockRestore()
    expect(occurrences(services, groceries.id).length).toBeLessThan(121)
    await runCron(services)
    expect(occurrences(services, groceries.id)).toHaveLength(121)
  })

  it('doesn’t create the schedule again after a delete lands during its expansion', async () => {
    const services = seeded()
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // After the schedule and the first batch, someone deletes it.
      if (params.commit && ++commits === 3)
        await ok(services, 'DELETE', `/schedules/${groceries.id}`)
      return commit(params)
    })
    expect(await failure(services, 'POST', '/schedules', { body: groceries })).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    })
    expect(services.db.rows('schedules')).toEqual([])
    expect(services.db.rows('transactions')).toEqual([])
  })
})

describe('PATCH /schedules/{id}', () => {
  async function withThursdays() {
    const services = seeded()
    await create(services, thursdays)
    return services
  }

  function patch(services: Fakes, body: { id: string; [key: string]: unknown }, userId = 'u1') {
    return ok<UpdatedSchedule>(services, 'PATCH', `/schedules/${body.id}`, { body, userId })
  }

  it('moves the start at most 31 days before today in the group’s timezone', async () => {
    const services = await withThursdays()
    // Today is 19 October in Sydney, still 18 October in UTC.
    const body = { ...thursdays, startsOn: '2026-09-17' }
    expect(await failure(services, 'PATCH', `/schedules/${ID}`, { body })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('schedules')[0]?.startsOn).toBe('2026-10-01')
    // 31 days is fine, and so is a start further back that doesn't change ("reopens an ended
    // schedule", below).
    await patch(services, { ...thursdays, startsOn: '2026-09-18' })
  })

  it('regenerates only future occurrences that aren’t edited, posted or voided', async () => {
    const services = await withThursdays()
    // Edited, posted and voided occurrences stay as they are.
    await setRow(services, 'transactions', `${ID}_20261022`, { overridden: true })
    await setRow(services, 'transactions', `${ID}_20261029`, { status: 'void', voidReason: 'Sick' })
    await setRow(services, 'transactions', `${ID}_20261105`, { status: 'posted' })
    const result = await patch(services, { ...thursdays, description: 'Late shift' })
    // 12 Nov to 10 Dec: updated in place, so none removed or created.
    expect(result).toMatchObject({ created: 0, updated: 5, removed: 0 })
    const byDate = Object.fromEntries(occurrences(services).map((row) => [row.date, row]))
    // Before today: kept with the old description.
    expect(byDate['2026-10-15']?.description).toBe('Thursday shift')
    expect(byDate['2026-10-22']).toMatchObject({ description: 'Thursday shift', overridden: true })
    expect(byDate['2026-10-29']).toMatchObject({ status: 'void' })
    expect(byDate['2026-11-05']).toMatchObject({ status: 'posted' })
    for (const date of ['2026-11-12', '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10']) {
      expect(byDate[date]).toMatchObject({ description: 'Late shift', updatedBy: 'pSam' })
    }
    expect(occurrences(services)).toHaveLength(11)
  })

  it('moves the dates with a new rule', async () => {
    const services = await withThursdays()
    const { created, updated, removed } = await patch(services, {
      ...thursdays,
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
    })
    expect({ created, updated, removed }).toEqual({ created: 8, updated: 0, removed: 8 })
    const dates = occurrences(services).map((row) => row.date)
    expect(dates.filter((date) => date >= '2026-10-19')).toEqual([
      '2026-10-23',
      '2026-10-30',
      '2026-11-06',
      '2026-11-13',
      '2026-11-20',
      '2026-11-27',
      '2026-12-04',
      '2026-12-11',
    ])
  })

  it('deletes what an earlier end leaves after it', async () => {
    const services = await withThursdays()
    const { created, removed } = await patch(services, { ...thursdays, endsOn: '2026-11-12' })
    // 19 and 26 November, 3 and 10 December.
    expect({ created, removed }).toEqual({ created: 0, removed: 4 })
    expect(occurrences(services).at(-1)?.date).toBe('2026-11-12')
    expect(scheduleRow(services)).toMatchObject({ generatedThrough: '2026-11-12', nextRunAt: null })
  })

  it('leaves the occurrences after a shorter horizon until the window reaches them', async () => {
    const services = await withThursdays()
    const { created, removed } = await patch(services, {
      ...thursdays,
      horizonDays: 14,
      description: 'Late shift',
    })
    expect({ created, removed }).toEqual({ created: 0, removed: 0 })
    expect(scheduleRow(services)?.generatedThrough).toBe('2026-11-02')
    const future = () =>
      occurrences(services)
        .filter((row) => row.date >= '2026-10-19')
        .map((row) => row.description)
    expect(future()).toEqual([...Array(2).fill('Late shift'), ...Array(6).fill('Thursday shift')])
    // The horizon grows again, and the next run reaches the rest.
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'schedules',
        rowId: ID,
        data: { horizonDays: 56, nextRunAt: '2026-10-18T20:00:00.000Z' },
      }),
    )
    await runCron(services)
    expect(future()).toEqual(Array(8).fill('Late shift'))
  })

  it('deletes the occurrences before a later start, from today on', async () => {
    const services = await withThursdays()
    const { created, removed } = await patch(services, {
      ...thursdays,
      startsOn: '2026-11-20',
      description: 'Late shift',
    })
    // 22 October to 19 November.
    expect({ created, removed }).toEqual({ created: 0, removed: 5 })
    expect(occurrences(services).map((row) => [row.date, row.description])).toEqual([
      ['2026-10-01', 'Thursday shift'],
      ['2026-10-08', 'Thursday shift'],
      ['2026-10-15', 'Thursday shift'],
      ['2026-11-26', 'Late shift'],
      ['2026-12-03', 'Late shift'],
      ['2026-12-10', 'Late shift'],
    ])
  })

  it('never changes a past occurrence that wasn’t posted, even after an earlier end', async () => {
    const services = await withThursdays()
    await ok(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-10-05' } })
    // 8 and 15 October weren't posted, so they wait for the user.
    const renamed = await patch(services, {
      ...thursdays,
      endsOn: '2026-10-05',
      description: 'Late shift',
    })
    expect(renamed).toMatchObject({ created: 0, removed: 0 })
    const { created } = await patch(services, {
      ...thursdays,
      endsOn: '2026-12-31',
      description: 'Late shift',
    })
    expect(created).toBe(8)
    expect(occurrences(services).map((row) => row.description)).toEqual([
      ...Array(3).fill('Thursday shift'),
      ...Array(8).fill('Late shift'),
    ])
  })

  it('replaces the items of the occurrences it updates, and deletes those of ones it deletes', async () => {
    const services = seeded()
    const withItems = (name: string) => ({
      ...rent,
      template: {
        bill: { status: 'due' },
        items: [{ name, amountCents: 90_000, split: { mode: 'equal', personIds: ['pSam'] } }],
      },
    })
    await create(services, withItems('Rent'))
    await patch(services, withItems('Rent and water'))
    expect(services.db.rows('items').map((item) => item.name)).toEqual([
      'Rent and water',
      'Rent and water',
    ])
    await patch(services, { ...withItems('Rent and water'), rrule: 'FREQ=MONTHLY;BYMONTHDAY=2' })
    expect(services.db.rows('items').map((item) => item.transactionId)).toEqual([
      `${rent.id}_20261102`,
      `${rent.id}_20261202`,
    ])
  })

  it('never changes the group or the kind, and needs the same id', async () => {
    const services = await withThursdays()
    const send = (body: object, path = `/schedules/${ID}`) =>
      failure(services, 'PATCH', path, { body })
    expect(await send({ ...thursdays, groupId: 'elm' })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    // Rent as an expense would be valid in Elm St, but its kind can't change.
    await create(services, rent)
    const expense = {
      ...rent,
      kind: 'expense',
      template: { totalCents: 90_000, split: { mode: 'equal', personIds: ['pSam', 'pAlex'] } },
    }
    expect(await send(expense, `/schedules/${rent.id}`)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(await send(thursdays, '/schedules/otherScheduleId00001')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
  })

  it('is for its creator or an admin', async () => {
    const services = seeded()
    await create(services, rent, 'u2')
    // Alex, a member, made it; Sam is an admin; Kim is a viewer.
    const edited = { ...rent, description: 'Rent and water' }
    expect((await patch(services, edited, 'u2')).schedule.description).toBe('Rent and water')
    expect((await patch(services, rent, 'u1')).schedule.description).toBe('Rent')
    expect(
      await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: rent, userId: 'u3' }),
    ).toEqual({ status: 403, code: 'FORBIDDEN' })
    // Alex can't edit one Sam made.
    const water = { ...rent, id: 'waterElmSam000000001', description: 'Water' }
    await create(services, water)
    expect(
      await failure(services, 'PATCH', `/schedules/${water.id}`, { body: water, userId: 'u2' }),
    ).toEqual({ status: 403, code: 'FORBIDDEN' })
    expect(
      await failure(services, 'PATCH', '/schedules/missingSchedule00001', {
        body: { ...rent, id: 'missingSchedule00001' },
      }),
    ).toEqual({ status: 404, code: 'NOT_FOUND' })
  })

  it('answers someone outside the group as if the schedule didn’t exist', async () => {
    // Alex isn't in Acme.
    const services = await withThursdays()
    const missing = 'missingSchedule00001'
    const requests = [
      ['PATCH', (id: string) => `/schedules/${id}`, (id: string) => ({ ...thursdays, id })],
      ['POST', (id: string) => `/schedules/${id}/end`, () => ({ endsOn: '2026-11-30' })],
      ['DELETE', (id: string) => `/schedules/${id}`, () => undefined],
    ] as const
    for (const [method, path, body] of requests) {
      const outsider = await call(services, method, path(ID), { body: body(ID), userId: 'u2' })
      const none = await call(services, method, path(missing), {
        body: body(missing),
        userId: 'u2',
      })
      expect(outsider.status).toBe(404)
      expect(outsider.body).toEqual(none.body)
    }
    expect(occurrences(services)).toHaveLength(11)
    expect(scheduleRow(services)?.endsOn).toBeNull()
  })

  it('refuses a template that breaks a ledger rule, and changes nothing', async () => {
    const services = seeded()
    await create(services, rent)
    const before = services.db.rows('transactions')
    const bad = {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam', 'pNobody'] } },
    }
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: bad })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('transactions')).toEqual(before)
  })
})

describe('races on schedule edits', () => {
  function patch(services: Fakes, body: { id: string; [key: string]: unknown }) {
    return ok<UpdatedSchedule>(services, 'PATCH', `/schedules/${body.id}`, { body })
  }

  it('expands again from today even when a cron run moved on meanwhile', async () => {
    const services = seeded()
    await create(services, thursdays)
    // The edit made the schedule due; the cron runs before its old occurrences are deleted.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"action":"delete"'),
      () => runCron(services),
    )
    await patch(services, { ...thursdays, description: 'Late shift' })
    const future = occurrences(services).filter((row) => row.date >= '2026-10-19')
    expect(future.map((row) => row.description)).toEqual(Array(8).fill('Late shift'))
  })

  it('leaves the rest of an edit to the next cron run if it stops before expanding', async () => {
    const services = seeded()
    await create(services, groceries)
    // A timeout once the rule is saved, when the first occurrence is updated.
    const stage = services.db.createOperations.bind(services.db)
    const timeout = vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      const operations = JSON.stringify(params.operations)
      if (operations.includes('"tableId":"transactions"') && operations.includes('"update"')) {
        throw new Error('Timed out')
      }
      return stage(params)
    })
    expect(
      await failure(services, 'PATCH', `/schedules/${groceries.id}`, {
        body: { ...groceries, description: 'Food' },
      }),
    ).toMatchObject({ status: 500 })
    timeout.mockRestore()
    await runCron(services)
    const rows = occurrences(services, groceries.id)
    expect(rows).toHaveLength(121)
    expect(rows.every((row) => row.description === 'Food')).toBe(true)
  })

  it('keeps an occurrence moved to another day, and doesn’t make it again', async () => {
    // Rent for November was paid early, on 18 October.
    const services = seeded()
    await create(services, rent)
    await setRow(services, 'transactions', `${rent.id}_20261101`, {
      status: 'posted',
      date: '2026-10-18',
    })
    const { created, updated } = await patch(services, {
      ...rent,
      template: { ...rent.template, totalCents: 95_000 },
    })
    // November's ID is taken, whatever its date; December is updated in place.
    expect([created, updated]).toEqual([0, 1])
    expect(await runCron(services)).toMatchObject({
      expanded: { schedules: 0, created: 0, failed: 0 },
    })
    expect(occurrences(services, rent.id).map((row) => [row.date, row.totalCents])).toEqual([
      ['2026-10-18', 90_000],
      ['2026-12-01', 95_000],
    ])
  })

  it('carries on past an occurrence moved earlier, when an end is moved later', async () => {
    const services = seeded()
    await create(services, thursdays)
    await setRow(services, 'transactions', `${ID}_20261203`, {
      overridden: true,
      date: '2026-11-10',
    })
    await ok(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-11-12' } })
    await ok(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-12-31' } })
    // 19 and 26 November and 10 December; 3 December's ID is taken by the moved one.
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 3, failed: 0 })
  })

  it('puts right an edit that loses its races, at the next cron run', async () => {
    // Thursdays to Fridays; the expansion loses a race on both tries.
    const services = seeded()
    await create(services, thursdays)
    failCommit(services, [2, 4], lostRace)
    expect(
      await failure(services, 'PATCH', `/schedules/${ID}`, {
        body: { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=FR' },
      }),
    ).toEqual({ status: 409, code: 'CONFLICT' })
    vi.restoreAllMocks()
    expect(scheduleRow(services)?.rrule).toBe('FREQ=WEEKLY;BYDAY=FR')
    await runCron(services)
    // Before today the Thursdays stay; from today on, only Fridays.
    const days = occurrences(services).map((row) => [row.date, weekdayOf(row.date as LocalDate)])
    expect(days.filter(([date]) => (date as string) < '2026-10-19').map(([, day]) => day)).toEqual([
      4, 4, 4,
    ])
    expect(
      new Set(days.filter(([date]) => (date as string) >= '2026-10-19').map(([, day]) => day)),
    ).toEqual(new Set([5]))
  })

  it.each([
    // Saved on Wednesday 21 October; the next run that reaches it is Saturday's.
    ['a day later', '2026-10-20T20:00:00.000Z', '2026-10-23T13:05:00.000Z'],
    // Saved at 23:58 on Thursday 22 October; the next run is at 00:05 on Friday.
    ['after midnight', '2026-10-22T12:58:00.000Z', '2026-10-22T13:05:00.000Z'],
  ])('puts right an edit that loses its races, when the next run comes %s', async (_, at, run) => {
    const services = seeded()
    await create(services, thursdays)
    services.now = new Date(at)
    failCommit(services, [2, 4], lostRace)
    await failure(services, 'PATCH', `/schedules/${ID}`, {
      body: { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=FR' },
    })
    vi.restoreAllMocks()
    services.now = new Date(run)
    await runCron(services)
    // As the edit would have left it: Thursday 22 October goes, and Friday 23 is there.
    const dates = occurrences(services).map((row) => row.date)
    expect(dates).not.toContain('2026-10-22')
    expect(dates).toContain('2026-10-23')
    expect(
      new Set(
        dates.filter((date) => date >= '2026-10-21').map((date) => weekdayOf(date as LocalDate)),
      ),
    ).toEqual(new Set([5]))
  })

  it('puts right what a short horizon left, however late the next run', async () => {
    const services = seeded()
    await create(services, thursdays)
    await patch(services, { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=FR', horizonDays: 7 })
    // The next run that reaches it comes 12 days later, on Saturday 31 October.
    services.now = new Date('2026-10-30T13:05:00.000Z')
    await runCron(services)
    const dates = occurrences(services).map((row) => row.date)
    expect(dates).not.toContain('2026-10-29')
    expect(dates).toContain('2026-10-30')
  })

  it('reopens an ended schedule from today, never filling in the past', async () => {
    const services = seeded()
    // Made on 20 September, within 31 days of its start.
    services.now = new Date('2026-09-19T20:00:00.000Z')
    await create(services, { ...thursdays, startsOn: '2026-09-03', endsOn: '2026-09-20' })
    services.now = NOW
    await patch(services, { ...thursdays, startsOn: '2026-09-03' })
    const dates = occurrences(services).map((row) => row.date)
    // 3, 10 and 17 September from before; nothing from 24 September to 15 October.
    expect(dates.filter((date) => date < '2026-10-19')).toEqual([
      '2026-09-03',
      '2026-09-10',
      '2026-09-17',
    ])
    expect(dates.filter((date) => date >= '2026-10-19')).toHaveLength(8)
  })

  it('puts right an edit that stopped partway, at the next cron run', async () => {
    const services = seeded()
    await create(services, groceries)
    // Weekdays only: the rule, one batch of updates and deletes, then a timeout.
    const timeout = failCommit(services, 3)
    expect(
      await failure(services, 'PATCH', `/schedules/${groceries.id}`, {
        body: { ...groceries, description: 'Food', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
      }),
    ).toMatchObject({ status: 500 })
    timeout.mockRestore()
    const before = occurrences(services, groceries.id)
    expect(before.some((row) => row.description === 'Groceries')).toBe(true)
    expect(before.some((row) => row.description === 'Food')).toBe(true)
    await runCron(services)
    const rows = occurrences(services, groceries.id)
    // 19 October to 16 February: 17 weeks and a Monday and Tuesday.
    expect(rows).toHaveLength(87)
    expect(rows.every((row) => row.description === 'Food')).toBe(true)
    expect(rows.every((row) => weekdayOf(row.date as LocalDate) <= 5)).toBe(true)
  })

  it('stops between batches once the run is out of time, and the next run carries on', async () => {
    const services = seeded()
    await create(services, { ...groceries, horizonDays: 7 })
    // A longer horizon, due now: 113 more days to create, in several batches.
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'schedules',
        rowId: groceries.id,
        data: { horizonDays: 120, nextRunAt: '2026-10-18T20:00:00.000Z' },
      }),
    )
    let late = false
    services.outOfTime = () => late
    const commit = services.db.updateTransaction.bind(services.db)
    const spy = vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      const result = await commit(params)
      if (params.commit) late = true
      return result
    })
    const first = (await runCron(services)).expanded.created
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(113)
    // Its progress is saved: up to the last occurrence it created.
    expect(scheduleRow(services, groceries.id)?.generatedThrough).toBe(
      occurrences(services, groceries.id).at(-1)?.date,
    )
    expect(scheduleRow(services, groceries.id)?.nextRunAt).toBe('2026-10-18T20:00:00.000Z')
    spy.mockRestore()
    late = false
    expect((await runCron(services)).expanded.created).toBe(113 - first)
    expect(occurrences(services, groceries.id)).toHaveLength(121)
  })

  it('can’t name someone in an edit whose member row is deleted while it commits', async () => {
    const services = seeded()
    await create(services, {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    })
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'members', rowId: 'elm-pAlex' }),
      ),
    )
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: rent })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(
      JSON.parse(scheduleRow(services, rent.id)?.templateJson ?? '{}').split.personIds,
    ).toEqual(['pSam'])
  })

  it('keeps an occurrence edited just before the edit’s update of it is staged', async () => {
    const services = seeded()
    await create(services, thursdays)
    beforeStaging(
      services.db,
      (operations) =>
        operations.includes('"tableId":"transactions"') && operations.includes('"update"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: `${ID}_20261210`,
            data: { overridden: true, description: 'Long shift' },
          }),
        ),
    )
    await patch(services, { ...thursdays, description: 'Late shift' })
    const edited = occurrences(services).find((row) => row.date === '2026-12-10')
    expect(edited).toMatchObject({ overridden: true, description: 'Long shift' })
    const other = occurrences(services).find((row) => row.date === '2026-12-03')
    expect(other?.description).toBe('Late shift')
  })

  it('deletes an item added to an occurrence it deletes just before staging, too', async () => {
    const services = seeded()
    const withItems = {
      ...rent,
      template: {
        bill: { status: 'due' },
        items: [
          { name: 'Rent', amountCents: 90_000, split: { mode: 'equal', personIds: ['pSam'] } },
        ],
      },
    }
    await create(services, withItems)
    beforeStaging(
      services.db,
      (operations) =>
        operations.includes('"action":"delete"') && operations.includes('"tableId":"items"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'create',
            tableId: 'items',
            rowId: 'waterItem00000000001',
            data: {
              transactionId: `${rent.id}_20261101`,
              position: 1,
              name: 'Water',
              quantity: 1,
              amountCents: 500,
              category: null,
              splitJson: '{"mode":"equal","personIds":["pSam"]}',
            },
          }),
        ),
    )
    await patch(services, { ...withItems, rrule: 'FREQ=MONTHLY;BYMONTHDAY=2' })
    expect(services.db.rows('items').map((item) => item.transactionId)).toEqual([
      `${rent.id}_20261102`,
      `${rent.id}_20261202`,
    ])
  })

  it('can’t update occurrences to name someone whose member row is deleted meanwhile', async () => {
    const services = seeded()
    await create(services, {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    })
    // Alex goes just before the expansion's commit, once the edit's rule is saved.
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && ++commits === 2) {
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'members', rowId: 'elm-pAlex' }),
        )
      }
      return commit(params)
    })
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: rent })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    const rows = occurrences(services, rent.id)
    expect(rows).toHaveLength(2)
    expect(rows.some((row) => String(row.inputJson).includes('pAlex'))).toBe(false)
  })

  it('expands with the rule an edit just saved, not the one it read', async () => {
    const services = seeded()
    await create(services, { ...thursdays, horizonDays: 7 })
    // Due now, with a longer horizon. It changes to Fridays after this run read it, before it
    // stages anything.
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'schedules',
        rowId: ID,
        data: { horizonDays: 28, nextRunAt: '2026-10-18T19:00:00.000Z' },
      }),
    )
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"schedules"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'schedules',
            rowId: ID,
            data: { rrule: 'FREQ=WEEKLY;BYDAY=FR', nextRunAt: '2026-10-18T19:00:00.000Z' },
          }),
        ),
    )
    const run = await ok<{ expanded: object }>(services, 'POST', '/', {
      userId: null,
      scheduled: true,
    })
    expect(run.expanded).toMatchObject({ failed: 0 })
    expect(
      occurrences(services)
        .map((row) => row.date)
        .filter((date) => date > '2026-10-26'),
    ).toEqual(['2026-10-30', '2026-11-06', '2026-11-13'])
  })

  it('creates no occurrence naming someone deleted while the run commits', async () => {
    const services = seeded()
    await create(services, { ...rent, horizonDays: 7 })
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'schedules',
        rowId: rent.id,
        data: { horizonDays: 56, nextRunAt: '2026-10-18T19:00:00.000Z' },
      }),
    )
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'members', rowId: 'elm-pAlex' }),
      ),
    )
    const run = await ok<{ expanded: object }>(services, 'POST', '/', {
      userId: null,
      scheduled: true,
    })
    expect(run.expanded).toMatchObject({ created: 0, failed: 1 })
    expect(occurrences(services, rent.id)).toEqual([])
  })
})

describe('rules with their own end', () => {
  it.each([
    ['COUNT=3', 'FREQ=WEEKLY;BYDAY=TH;COUNT=3', '2026-10-15'],
    ['UNTIL', 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029', '2026-10-29'],
  ])('finish with %s, once everything up to the end exists', async (_rule, rrule, last) => {
    const services = seeded()
    await create(services, { ...thursdays, rrule })
    expect(occurrences(services).at(-1)?.date).toBe(last)
    expect(scheduleRow(services)).toMatchObject({ generatedThrough: last, nextRunAt: null })
  })
})

describe('POST /schedules/{id}/end', () => {
  function end(services: Fakes, endsOn: string) {
    return ok<EndedSchedule>(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn } })
  }

  it('deletes the later occurrences that aren’t edited, and stops the schedule', async () => {
    const services = seeded()
    await create(services, thursdays)
    await setRow(services, 'transactions', `${ID}_20261203`, { overridden: true })
    const { schedule, removed } = await end(services, '2026-11-12')
    // 19 Nov, 26 Nov and 10 Dec go; the edited 3 Dec stays.
    expect(removed).toBe(3)
    expect(occurrences(services).map((row) => row.date)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
      '2026-11-12',
      '2026-12-03',
    ])
    // Due at once; the next cron run finds nothing left to do and stops it.
    expect(schedule).toMatchObject({
      endsOn: '2026-11-12',
      generatedThrough: '2026-11-12',
      nextRunAt: services.now.toISOString(),
    })
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 0, failed: 0 })
    expect(occurrences(services)).toHaveLength(8)
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
  })

  it('leaves the rest of an end that stops partway to the next cron run', async () => {
    const services = seeded()
    await create(services, thursdays)
    // The end is saved, then its deletes time out.
    const timeout = failCommit(services, 2)
    expect(
      await failure(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-11-12' } }),
    ).toMatchObject({ status: 500 })
    timeout.mockRestore()
    expect(occurrences(services).at(-1)?.date).toBe('2026-12-10')
    await runCron(services)
    expect(occurrences(services).at(-1)?.date).toBe('2026-11-12')
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
  })

  it('changes nothing when the group is archived while it commits', async () => {
    const services = seeded()
    await create(services, thursdays)
    beforeCommit(services.db, () => archive(services))
    expect(
      await failure(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-11-12' } }),
    ).toEqual({ status: 409, code: 'ARCHIVED' })
    expect(scheduleRow(services)?.endsOn).toBeNull()
    expect(occurrences(services)).toHaveLength(11)
  })

  it('leaves past occurrences that weren’t posted', async () => {
    const services = seeded()
    await create(services, thursdays)
    // Today is 19 October: 8 and 15 October wait for the user.
    expect((await end(services, '2026-10-05')).removed).toBe(8)
    // The run that follows doesn't reach back before today either.
    await runCron(services)
    expect(occurrences(services).map((row) => row.date)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
    ])
    expect(scheduleRow(services)).toMatchObject({ generatedThrough: '2026-10-18', nextRunAt: null })
  })

  it('keeps past occurrences when the run after an end before today loses a race partway', async () => {
    const services = seeded()
    // Every day from 1 October, so the run after the end has two batches of deletes.
    const daily = {
      ...thursdays,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
      horizonDays: 120,
    }
    await create(services, daily)
    const past = occurrences(services)
      .filter((row) => row.date < '2026-10-19')
      .map((row) => row.date)
    // The end's own deletes time out, so the cron run does them; its second batch loses a race,
    // and it runs again.
    const timeout = failCommit(services, 2)
    await failure(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-10-05' } })
    timeout.mockRestore()
    failCommit(services, 2, lostRace)
    await runCron(services)
    vi.restoreAllMocks()
    // From 6 to 18 October they wait for the user; only the ones from today on are gone.
    expect(occurrences(services).map((row) => row.date)).toEqual(past)
  })

  it('carries on from today when an end long past is moved later', async () => {
    const services = seeded()
    // Made on 20 September, within 31 days of its start.
    services.now = new Date('2026-09-19T20:00:00.000Z')
    await create(services, { ...thursdays, startsOn: '2026-09-03', endsOn: '2026-09-20' })
    services.now = NOW
    await end(services, '2026-12-31')
    await runCron(services)
    const dates = occurrences(services).map((row) => row.date)
    // Nothing from 24 September to 15 October; the 8 Thursdays from today on.
    expect(dates.filter((date) => date < '2026-10-19')).toEqual([
      '2026-09-03',
      '2026-09-10',
      '2026-09-17',
    ])
    expect(dates.filter((date) => date >= '2026-10-19')).toHaveLength(8)
  })

  it('works even when the template no longer fits the ledger', async () => {
    const services = seeded()
    await create(services, rent)
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'members', rowId: 'elm-pAlex' }),
    )
    const result = await ok<EndedSchedule>(services, 'POST', `/schedules/${rent.id}/end`, {
      body: { endsOn: '2026-11-15' },
    })
    expect(result.removed).toBe(1)
    // Nor does the cron run that follows it: there is nothing left to plan.
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 0, failed: 0 })
    expect(scheduleRow(services, rent.id)?.nextRunAt).toBeNull()
  })

  it('lets a later end carry on at the next run', async () => {
    const services = seeded()
    await create(services, { ...thursdays, endsOn: '2026-10-22' })
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
    const { schedule } = await end(services, '2026-12-31')
    expect(schedule).toMatchObject({ endsOn: '2026-12-31', nextRunAt: services.now.toISOString() })
  })

  it('refuses an end before the start', async () => {
    const services = seeded()
    await create(services, thursdays)
    expect(
      await failure(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn: '2026-09-30' } }),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' })
  })
})

describe('POST /schedules/{id}/pause and /resume', () => {
  function pause(services: Fakes, pausedFrom: string, id = ID) {
    return ok<PausedSchedule>(services, 'POST', `/schedules/${id}/pause`, { body: { pausedFrom } })
  }

  function resume(services: Fakes, id = ID) {
    return ok<ResumedSchedule>(services, 'POST', `/schedules/${id}/resume`)
  }

  function end(services: Fakes, endsOn: string) {
    return ok<EndedSchedule>(services, 'POST', `/schedules/${ID}/end`, { body: { endsOn } })
  }

  const dates = (services: Fakes, id = ID) => occurrences(services, id).map((row) => row.date)

  it('deletes the occurrences from its date that aren’t edited, and makes no more', async () => {
    const services = seeded()
    await create(services, thursdays)
    await setRow(services, 'transactions', `${ID}_20261203`, { overridden: true })
    const { schedule, removed } = await pause(services, '2026-11-10')
    // 12, 19 and 26 November and 10 December go; the edited 3 December stays.
    expect(removed).toBe(4)
    expect(schedule).toMatchObject({
      pausedFrom: '2026-11-10',
      endsOn: null,
      generatedThrough: '2026-11-09',
      nextRunAt: services.now.toISOString(),
    })
    // The next cron run finds nothing to do and stops it, and later ones never pick it up.
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 0, failed: 0 })
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
    services.now = new Date('2026-12-20T20:00:00.000Z')
    expect((await runCron(services)).expanded).toEqual({ schedules: 0, created: 0, failed: 0 })
    expect(dates(services)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
      '2026-12-03',
    ])
  })

  it('resumes from today, and fills in none of the dates it skipped', async () => {
    const services = seeded()
    await create(services, thursdays)
    expect((await pause(services, '2026-10-19')).removed).toBe(8)
    await runCron(services)
    // Monday 9 November in Sydney.
    services.now = new Date('2026-11-08T20:00:00.000Z')
    const { schedule, created } = await resume(services)
    // Nothing on 22 and 29 October or 5 November; the Thursdays from 12 November to the
    // horizon, 4 January.
    expect(created).toBe(8)
    expect(dates(services)).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
      '2026-11-12',
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
      '2026-12-10',
      '2026-12-17',
      '2026-12-24',
      '2026-12-31',
    ])
    expect(schedule).toMatchObject({
      pausedFrom: null,
      generatedThrough: '2027-01-04',
      nextRunAt: '2026-11-09T13:05:00.000Z',
    })
  })

  it('brings today’s occurrence back when it resumes on the day the pause starts', async () => {
    const services = seeded()
    await create(services, thursdays)
    // Thursday 22 October in Sydney.
    services.now = new Date('2026-10-21T20:00:00.000Z')
    expect((await pause(services, '2026-10-22')).removed).toBe(8)
    // 22 October to the horizon, 17 December.
    expect((await resume(services)).created).toBe(9)
    expect(dates(services).filter((date) => date >= '2026-10-22')).toEqual([
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
      '2026-11-12',
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
      '2026-12-10',
      '2026-12-17',
    ])
  })

  it('puts back what it deleted when it resumes before the pause starts', async () => {
    const services = seeded()
    await create(services, thursdays)
    expect((await pause(services, '2026-11-10')).removed).toBe(5)
    const { schedule, created } = await resume(services)
    expect(created).toBe(5)
    expect(occurrences(services)).toHaveLength(11)
    expect(schedule).toMatchObject({ pausedFrom: null, generatedThrough: '2026-12-14' })
  })

  it('moves the date when it pauses again', async () => {
    const services = seeded()
    await create(services, thursdays)
    await pause(services, '2026-11-10')
    await runCron(services)
    // Later: the next run makes the Thursdays up to it.
    await pause(services, '2026-11-24')
    await runCron(services)
    expect(dates(services).at(-1)).toBe('2026-11-19')
    // Earlier: it deletes what's after it.
    expect((await pause(services, '2026-10-26')).removed).toBe(4)
    expect(dates(services).at(-1)).toBe('2026-10-22')
  })

  it('leaves a schedule that isn’t paused as it is', async () => {
    const services = seeded()
    await create(services, thursdays)
    const before = scheduleRow(services)
    expect(await resume(services)).toEqual({ schedule: before, created: 0 })
    expect(scheduleRow(services)).toEqual(before)
  })

  it('pauses and resumes a schedule that hasn’t started yet', async () => {
    const services = seeded()
    // Rent from 1 November: 1 November and 1 December so far.
    await create(services, rent)
    expect((await pause(services, '2026-10-25', rent.id)).removed).toBe(2)
    await runCron(services)
    expect(dates(services, rent.id)).toEqual([])
    expect((await resume(services, rent.id)).created).toBe(2)
  })

  it('pauses a schedule that never expanded, which then expands up to the pause', async () => {
    const services = seeded()
    // The expansion after the schedule is saved times out.
    const timeout = failCommit(services, 2)
    await failure(services, 'POST', '/schedules', { body: thursdays })
    timeout.mockRestore()
    expect(scheduleRow(services)?.generatedThrough).toBeNull()
    const { schedule, removed } = await pause(services, '2026-10-26')
    expect(removed).toBe(0)
    expect(schedule.generatedThrough).toBeNull()
    await runCron(services)
    expect(dates(services)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22'])
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
  })

  it.each([
    // 07:00 on Monday 19 October in Sydney.
    [NOW.toISOString(), '2026-10-18', '2026-10-19'],
    // 00:30 on Monday 19 October in Sydney: still the 18th in UTC.
    ['2026-10-18T13:30:00.000Z', '2026-10-18', '2026-10-19'],
    // 23:30 on Sunday 18 October in Sydney.
    ['2026-10-18T12:30:00.000Z', '2026-10-17', '2026-10-18'],
    // 01:30 on Sunday 4 October, the day Sydney's clocks go forward.
    ['2026-10-03T15:30:00.000Z', '2026-10-03', '2026-10-04'],
  ])(
    'at %s, refuses %s and pauses from %s, today in the group’s time zone',
    async (at, before, today) => {
      const services = seeded()
      services.now = new Date(at)
      await create(services, thursdays)
      expect(
        await failure(services, 'POST', `/schedules/${ID}/pause`, { body: { pausedFrom: before } }),
      ).toEqual({ status: 400, code: 'VALIDATION_FAILED' })
      expect((await pause(services, today)).schedule.pausedFrom).toBe(today)
    },
  )

  it('stays paused through an edit, which expands only up to the pause', async () => {
    const services = seeded()
    await create(services, thursdays)
    await pause(services, '2026-11-10')
    const { schedule, created } = await ok<UpdatedSchedule>(services, 'PATCH', `/schedules/${ID}`, {
      body: { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=FR' },
    })
    expect(created).toBe(3)
    expect(schedule).toMatchObject({ pausedFrom: '2026-11-10', nextRunAt: null })
    expect(dates(services).filter((date) => date >= '2026-10-19')).toEqual([
      '2026-10-23',
      '2026-10-30',
      '2026-11-06',
    ])
  })

  it('stays paused through a later end, and resumes up to it', async () => {
    const services = seeded()
    await create(services, thursdays)
    await pause(services, '2026-11-10')
    expect((await end(services, '2026-11-26')).schedule).toMatchObject({
      pausedFrom: '2026-11-10',
      endsOn: '2026-11-26',
    })
    await runCron(services)
    expect(dates(services).at(-1)).toBe('2026-11-05')
    expect((await resume(services)).created).toBe(3)
    expect(dates(services).at(-1)).toBe('2026-11-26')
  })

  it('stays ended when an earlier end comes before the pause, and after a resume', async () => {
    const services = seeded()
    await create(services, thursdays)
    await pause(services, '2026-11-10')
    expect((await end(services, '2026-10-29')).removed).toBe(1)
    expect((await resume(services)).created).toBe(0)
    expect(dates(services).at(-1)).toBe('2026-10-29')
  })

  it.each([
    // The last day of each month, paused on 31 October and resumed on Monday 2 November.
    ['FREQ=MONTHLY;BYMONTHDAY=-1', '2026-10-31', ['2026-11-30']],
    // Every other Tuesday from the week of 1 October keeps its weeks: 10 November, not 3.
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '2026-10-20', ['2026-11-10', '2026-11-24', '2026-12-08']],
    // The dates it skipped count towards COUNT: only the 6th Thursday is left.
    ['FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-10-19', ['2026-11-05']],
  ])('resumes %s in step with its rule', async (rrule, pausedFrom, after) => {
    const services = seeded()
    await create(services, { ...thursdays, rrule, horizonDays: 45 })
    await pause(services, pausedFrom)
    await runCron(services)
    services.now = new Date('2026-11-01T20:00:00.000Z')
    await resume(services)
    expect(dates(services).filter((date) => date >= pausedFrom)).toEqual(after)
  })

  it('auto-posts nothing dated inside the pause but what was edited', async () => {
    // FakeDb stamps $createdAt from the real clock: these are made on 19 October.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const services = seeded()
    const cleaner = {
      id: 'cleanerElmSam0000001',
      groupId: 'elm',
      kind: 'expense',
      description: 'Cleaner',
      template: { totalCents: 10_000, split: { mode: 'equal', personIds: ['pSam', 'pAlex'] } },
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      startsOn: '2026-10-22',
      skipPublicHolidays: false,
      autoPost: true,
    }
    await create(services, cleaner)
    await setRow(services, 'transactions', `${cleaner.id}_20261029`, { overridden: true })
    await pause(services, '2026-10-19', cleaner.id)
    // 07:00 on Friday 6 November in Sydney.
    services.now = new Date('2026-11-05T20:00:00.000Z')
    vi.setSystemTime(services.now)
    await runCron(services)
    vi.useRealTimers()
    expect(occurrences(services, cleaner.id).map((row) => [row.date, row.status])).toEqual([
      ['2026-10-29', 'posted'],
    ])
  })

  it('is for its creator or an admin, and not in an archived group', async () => {
    const services = seeded()
    await create(services, rent, 'u2')
    const water = { ...rent, id: 'waterElmSam000000001', description: 'Water' }
    await create(services, water)
    const send = (action: string, userId: string, id = rent.id) =>
      call(services, 'POST', `/schedules/${id}/${action}`, {
        body: action === 'pause' ? { pausedFrom: '2026-11-15' } : undefined,
        userId,
      }).then(({ status, body }) => (body.ok ? status : { status, code: body.error.code }))
    for (const action of ['pause', 'resume']) {
      // Alex, a member, made rent; Sam is an admin; Kim is a viewer.
      expect(await send(action, 'u2')).toBe(200)
      expect(await send(action, 'u1')).toBe(200)
      expect(await send(action, 'u3')).toEqual({ status: 403, code: 'FORBIDDEN' })
      // Alex can't change one Sam made.
      expect(await send(action, 'u2', water.id)).toEqual({ status: 403, code: 'FORBIDDEN' })
      expect(await send(action, 'u1', 'missingSchedule00001')).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      })
    }
    await archive(services, 'elm')
    for (const action of ['pause', 'resume']) {
      expect(await send(action, 'u1')).toEqual({ status: 409, code: 'ARCHIVED' })
    }
  })

  it('changes nothing when the group is archived while it commits', async () => {
    const services = seeded()
    await create(services, thursdays)
    beforeCommit(services.db, () => archive(services))
    expect(
      await failure(services, 'POST', `/schedules/${ID}/pause`, {
        body: { pausedFrom: '2026-11-10' },
      }),
    ).toEqual({ status: 409, code: 'ARCHIVED' })
    expect(scheduleRow(services)?.pausedFrom).toBeUndefined()
    expect(occurrences(services)).toHaveLength(11)
  })

  it('leaves the rest of a pause that stops partway to the next cron run', async () => {
    const services = seeded()
    await create(services, thursdays)
    // The pause is saved, then its deletes time out.
    const timeout = failCommit(services, 2)
    expect(
      await failure(services, 'POST', `/schedules/${ID}/pause`, {
        body: { pausedFrom: '2026-11-10' },
      }),
    ).toMatchObject({ status: 500 })
    timeout.mockRestore()
    expect(dates(services).at(-1)).toBe('2026-12-10')
    await runCron(services)
    expect(dates(services).at(-1)).toBe('2026-11-05')
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
  })

  it('leaves the rest of a resume that stops partway to the next cron run', async () => {
    const services = seeded()
    await create(services, thursdays)
    await pause(services, '2026-10-19')
    await runCron(services)
    // The resume is saved, then its expansion times out.
    const timeout = failCommit(services, 2)
    expect(await failure(services, 'POST', `/schedules/${ID}/resume`)).toMatchObject({
      status: 500,
    })
    timeout.mockRestore()
    expect(scheduleRow(services)?.pausedFrom).toBeNull()
    expect(occurrences(services)).toHaveLength(3)
    await runCron(services)
    expect(occurrences(services)).toHaveLength(11)
  })

  it('runs again when it loses a race, with nothing made twice', async () => {
    const services = seeded()
    await create(services, thursdays)
    // The pause's save loses, and its rerun wins.
    failCommit(services, 1, lostRace)
    expect((await pause(services, '2026-11-10')).removed).toBe(5)
    vi.restoreAllMocks()
    failCommit(services, 2, lostRace)
    // The expansion loses: the rerun finds it resumed, and the cron run makes the rest.
    expect((await resume(services)).created).toBe(0)
    vi.restoreAllMocks()
    await runCron(services)
    expect(occurrences(services)).toHaveLength(11)
    expect(new Set(dates(services)).size).toBe(11)
  })

  it('makes a cron run that read the schedule just before a pause run again', async () => {
    const services = seeded()
    // Saved, but its expansion times out: due now, and never expanded, so the pause changes
    // only pausedFrom.
    const timeout = failCommit(services, 2)
    await failure(services, 'POST', '/schedules', { body: thursdays })
    timeout.mockRestore()
    // The pause lands after the run reads the schedule, before it stages its first batch.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"schedules"'),
      () => pause(services, '2026-10-19'),
    )
    await runCron(services)
    vi.restoreAllMocks()
    expect(dates(services)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15'])
  })

  it('makes a cron run that read the schedule before a pause run again', async () => {
    const services = seeded()
    await create(services, thursdays)
    // A week later, the run would make 17 December; a pause commits first.
    services.now = new Date('2026-10-25T20:00:00.000Z')
    beforeCommit(services.db, () => pause(services, '2026-10-26'))
    await runCron(services)
    vi.restoreAllMocks()
    expect(dates(services).at(-1)).toBe('2026-10-22')
    expect(scheduleRow(services)).toMatchObject({ pausedFrom: '2026-10-26', nextRunAt: null })
  })
})

describe('DELETE /schedules/{id}', () => {
  it('deletes the schedule and all its occurrences and items', async () => {
    const services = seeded()
    await create(services, {
      ...rent,
      template: {
        bill: { status: 'due' },
        items: [
          { name: 'Rent', amountCents: 90_000, split: { mode: 'equal', personIds: ['pSam'] } },
        ],
      },
    })
    await setRow(services, 'transactions', `${rent.id}_20261101`, { status: 'void' })
    expect(await ok(services, 'DELETE', `/schedules/${rent.id}`)).toEqual({})
    expect(services.db.rows('schedules')).toEqual([])
    expect(services.db.rows('transactions')).toEqual([])
    expect(services.db.rows('items')).toEqual([])
  })

  it('refuses a schedule with a posted occurrence', async () => {
    const services = seeded()
    await create(services, thursdays)
    await setRow(services, 'transactions', `${ID}_20261001`, { status: 'posted' })
    expect(await failure(services, 'DELETE', `/schedules/${ID}`)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(occurrences(services)).toHaveLength(11)
  })

  it('keeps the schedule when the group is archived while it runs', async () => {
    // Archived before the occurrences' deletes commit, then before the schedule's is staged.
    const before = [
      (services: Fakes) => beforeCommit(services.db, () => archive(services)),
      (services: Fakes) =>
        beforeStaging(
          services.db,
          (operations) =>
            operations.includes('"action":"delete"') &&
            operations.includes('"tableId":"schedules"'),
          () => archive(services),
        ),
    ]
    for (const [index, hook] of before.entries()) {
      const services = seeded()
      await create(services, thursdays)
      hook(services)
      expect(await failure(services, 'DELETE', `/schedules/${ID}`)).toEqual({
        status: 409,
        code: 'ARCHIVED',
      })
      expect(scheduleRow(services)).toBeDefined()
      expect(occurrences(services)).toHaveLength(index === 0 ? 11 : 0)
    }
  })

  it('deletes voided occurrences last, so a delete that stops keeps them', async () => {
    const services = seeded()
    await create(services, groceries)
    // The first by ID, so it would go in the first batch.
    await setRow(services, 'transactions', `${groceries.id}_20261019`, { status: 'void' })
    // The first batch of deletes, then a timeout.
    failCommit(services, 2)
    expect(await failure(services, 'DELETE', `/schedules/${groceries.id}`)).toMatchObject({
      status: 500,
    })
    expect(
      services.db.rows('transactions').find((row) => row.$id === `${groceries.id}_20261019`),
    ).toMatchObject({ status: 'void' })
  })

  it('deletes an item added before its deletes are staged too', async () => {
    const services = seeded()
    await create(services, {
      ...rent,
      template: {
        bill: { status: 'due' },
        items: [
          { name: 'Rent', amountCents: 90_000, split: { mode: 'equal', personIds: ['pSam'] } },
        ],
      },
    })
    // Someone edits November's rent and adds water, just before the delete's batch.
    beforeStaging(
      services.db,
      (operations) =>
        operations.includes('"action":"delete"') && operations.includes('"tableId":"items"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write(
            {
              action: 'update',
              tableId: 'transactions',
              rowId: `${rent.id}_20261101`,
              data: { overridden: true, totalCents: 90_500 },
            },
            {
              action: 'create',
              tableId: 'items',
              rowId: 'waterItem00000000001',
              data: {
                transactionId: `${rent.id}_20261101`,
                position: 1,
                name: 'Water',
                quantity: 1,
                amountCents: 500,
                category: null,
                splitJson: '{"mode":"equal","personIds":["pSam"]}',
              },
            },
          ),
        ),
    )
    expect(await ok(services, 'DELETE', `/schedules/${rent.id}`)).toEqual({})
    expect(services.db.rows('transactions')).toEqual([])
    expect(services.db.rows('items')).toEqual([])
  })

  it('deletes an occurrence a cron run creates meanwhile too', async () => {
    const services = seeded()
    await create(services, thursdays)
    beforeStaging(
      services.db,
      (operations) =>
        operations.includes('"action":"delete"') && operations.includes('"tableId":"schedules"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'create',
            tableId: 'transactions',
            rowId: `${ID}_20261217`,
            data: {
              groupId: 'acme',
              kind: 'shift',
              status: 'scheduled',
              date: '2026-12-17',
              description: 'Thursday shift',
              totalCents: 12_500,
              inputJson: '{}',
              scheduleId: ID,
              overridden: false,
              statementId: null,
              createdBy: 'pSam',
              updatedBy: 'pSam',
            },
          }),
        ),
    )
    expect(await ok(services, 'DELETE', `/schedules/${ID}`)).toEqual({})
    expect(services.db.rows('schedules')).toEqual([])
    expect(services.db.rows('transactions')).toEqual([])
  })

  describe('receipts', () => {
    // A receiptFiles row as the ledger keeps it (data-model.md#receiptfiles).
    const receiptRow = (services: Fakes, fileId: string, transactionIds: string[]) =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'create',
          tableId: 'receiptFiles',
          rowId: fileId,
          data: { transactionIds, detachedAt: null, deletingAt: null },
          permissions: [],
        }),
      )
    const receiptFile = (services: Fakes, fileId: string) =>
      services.db.rows('receiptFiles').find((row) => row.$id === fileId)
    const edited = `${ID}_20261022`
    const voided = `${ID}_20261029`

    it('takes the receipts of its edited and voided occurrences off, one write per file', async () => {
      const services = seeded()
      await create(services, thursdays)
      await setRow(services, 'transactions', edited, {
        overridden: true,
        receiptFileIds: ['r1', 'r2'],
      })
      await setRow(services, 'transactions', voided, {
        status: 'void',
        voidReason: 'Sick',
        receiptFileIds: ['r2'],
      })
      await receiptRow(services, 'r1', [edited])
      await receiptRow(services, 'r2', [edited, voided, 'elsewhere0000000001'])
      const staged = vi.spyOn(services.db, 'createOperations')
      expect(await ok(services, 'DELETE', `/schedules/${ID}`)).toEqual({})
      const receiptWrites = staged.mock.calls
        .flatMap(([params]) => (params.operations ?? []) as { tableId: string; rowId: string }[])
        .filter((operation) => operation.tableId === 'receiptFiles')
      expect(receiptWrites.map((operation) => operation.rowId).sort()).toEqual(['r1', 'r2'])
      expect(receiptFile(services, 'r1')).toMatchObject({
        transactionIds: null,
        detachedAt: NOW.toISOString(),
        deletingAt: null,
      })
      // Another transaction still lists it.
      expect(receiptFile(services, 'r2')).toMatchObject({
        transactionIds: ['elsewhere0000000001'],
        detachedAt: null,
      })
      expect(occurrences(services)).toEqual([])
    })

    it('takes off a receipt added to an occurrence just before its deletes are staged', async () => {
      const services = seeded()
      await create(services, thursdays)
      await setRow(services, 'transactions', edited, { overridden: true, receiptFileIds: ['r1'] })
      await receiptRow(services, 'r1', [edited])
      // Someone attaches r3 to the edited shift, as the ledger does: the list and its row.
      beforeStaging(
        services.db,
        (operations) =>
          operations.includes('"action":"delete"') &&
          operations.includes('"tableId":"transactions"'),
        async () => {
          await setRow(services, 'transactions', edited, { receiptFileIds: ['r1', 'r3'] })
          await receiptRow(services, 'r3', [edited])
        },
      )
      expect(await ok(services, 'DELETE', `/schedules/${ID}`)).toEqual({})
      for (const fileId of ['r1', 'r3']) {
        expect(receiptFile(services, fileId)).toMatchObject({
          transactionIds: null,
          detachedAt: NOW.toISOString(),
        })
      }
    })

    it('counts the receipt rows in its batches of at most 90 writes', async () => {
      const services = seeded()
      await create(services, groceries)
      // 20 edited occurrences with 10 receipts each: 13 writes apiece with their 2 items.
      const edits = occurrences(services, groceries.id).slice(0, 20)
      for (const [at, row] of edits.entries()) {
        await setRow(services, 'transactions', row.$id, {
          overridden: true,
          receiptFileIds: Array.from({ length: 10 }, (_, index) => `g${at}r${index}`),
        })
      }
      const staged = vi.spyOn(services.db, 'createOperations')
      expect(await ok(services, 'DELETE', `/schedules/${groceries.id}`)).toEqual({})
      const writes = new Map<string, number>()
      for (const [params] of staged.mock.calls) {
        const count = writes.get(params.transactionId) ?? 0
        writes.set(params.transactionId, count + (params.operations?.length ?? 0))
      }
      expect(Math.max(...writes.values())).toBeLessThanOrEqual(90)
      expect(services.db.rows('receiptFiles')).toHaveLength(200)
      expect(occurrences(services, groceries.id)).toEqual([])
    })
  })
})

// functions-api.md#ledger ("Deleted people"): the same rule as the ledger's, for templates.
describe('a person who deleted their account, in a group they had joined', () => {
  const deleteAccount = (services: Fakes) =>
    setRow(services, 'persons', 'pAlex', { deletedAt: '2026-10-17T00:00:00.000Z' })

  const refused = { status: 400, code: 'VALIDATION_FAILED' }

  it('can’t be named in a new schedule', async () => {
    const services = seeded()
    await deleteAccount(services)
    expect(await failure(services, 'POST', '/schedules', { body: rent })).toEqual(refused)
    expect(services.db.rows('schedules')).toEqual([])
  })

  it('can’t get a share from a template’s default split', async () => {
    const services = seeded()
    await deleteAccount(services)
    // No split: everyone in the house on each occurrence's date, Alex included.
    const { split, ...everyone } = rent.template
    const body = { ...rent, template: everyone }
    expect(await failure(services, 'POST', '/schedules', { body })).toEqual(refused)
    expect(services.db.rows('schedules')).toEqual([])
  })

  it('can’t reopen a schedule they created by an edit, which can still be ended or deleted', async () => {
    const services = seeded()
    const forSam = {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await ok(services, 'POST', '/schedules', { body: forSam, userId: 'u2' })
    await deleteAccount(services)
    const renamed = { ...forSam, description: 'Rent (Sam)' }
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: renamed })).toEqual(
      refused,
    )
    expect(scheduleRow(services, rent.id)?.description).toBe('Rent')
    await ok(services, 'POST', `/schedules/${rent.id}/end`, { body: { endsOn: '2026-12-01' } })
    await ok(services, 'DELETE', `/schedules/${rent.id}`, {})
  })

  it('can’t reopen a schedule they created when the deletion commits while the edit does', async () => {
    const services = seeded()
    const forSam = {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await ok(services, 'POST', '/schedules', { body: forSam, userId: 'u2' })
    beforeCommit(services.db, () => deleteAccount(services))
    const renamed = { ...forSam, description: 'Rent (Sam)' }
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: renamed })).toEqual(
      refused,
    )
    expect(scheduleRow(services, rent.id)?.description).toBe('Rent')
  })

  it('is checked from a later start, not today, on the deletion day', async () => {
    // Rent from 1 November with no split. Alex moves out today (19 October), as a deletion does,
    // so a trial today would still split to Alex, but one on the start date doesn't.
    const services = seeded()
    const { split, ...everyone } = rent.template
    const fromNovember = { ...rent, template: everyone }
    await ok(services, 'POST', '/schedules', { body: fromNovember })
    await setRow(services, 'members', 'elm-pAlex', {
      status: 'left',
      role: 'viewer',
      leftOn: '2026-10-19',
    })
    await deleteAccount(services)
    const renamed = { ...fromNovember, description: 'Rent and water' }
    await ok(services, 'PATCH', `/schedules/${rent.id}`, { body: renamed })
  })

  it('can’t reopen a paused schedule they created, or one that names them, by a resume', async () => {
    const services = seeded()
    const forSam = {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await ok(services, 'POST', '/schedules', { body: forSam, userId: 'u2' })
    const water = { ...rent, id: 'waterElmSam000000001', description: 'Water' }
    await ok(services, 'POST', '/schedules', { body: water })
    for (const id of [rent.id, water.id]) {
      await ok(services, 'POST', `/schedules/${id}/pause`, { body: { pausedFrom: '2026-10-19' } })
    }
    await deleteAccount(services)
    for (const id of [rent.id, water.id]) {
      expect(await failure(services, 'POST', `/schedules/${id}/resume`)).toEqual(refused)
      expect(scheduleRow(services, id)?.pausedFrom).toBe('2026-10-19')
      expect(occurrences(services, id)).toEqual([])
    }
  })

  it('can’t be kept in a template’s default split by an edit', async () => {
    const services = seeded()
    const { split, ...everyone } = rent.template
    const body = { ...rent, template: everyone }
    await ok(services, 'POST', '/schedules', { body })
    await deleteAccount(services)
    const renamed = { ...body, description: 'Rent and water' }
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: renamed })).toEqual(
      refused,
    )
  })

  it('is checked from the first day an edit can make, not a past start date', async () => {
    // Rent since 1 October with no split: Alex shares it until moving out on 10 October.
    const services = seeded()
    const { split, ...everyone } = rent.template
    const sinceOctober = { ...rent, template: everyone, startsOn: '2026-10-01' }
    await ok(services, 'POST', '/schedules', { body: sinceOctober })
    await setRow(services, 'members', 'elm-pAlex', {
      status: 'left',
      role: 'viewer',
      leftOn: '2026-10-10',
    })
    await deleteAccount(services)
    // From today on, no occurrence the edit makes splits to Alex.
    const renamed = { ...sinceOctober, description: 'Rent and water' }
    await ok(services, 'PATCH', `/schedules/${rent.id}`, { body: renamed })
    // A new schedule from 1 October makes its past occurrences at once, and those would.
    const again = { ...sinceOctober, id: 'rentElmSam0000000002' }
    expect(await failure(services, 'POST', '/schedules', { body: again })).toEqual(refused)
  })

  it('can’t be added to a template, or kept in one, so an ended schedule doesn’t start again', async () => {
    const services = seeded()
    const samOnly = {
      ...rent,
      id: 'rentElmSam0000000002',
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await create(services, rent)
    await create(services, samOnly)
    // Deleting the account ends the schedules that name them (identity-and-invites.md).
    await ok(services, 'POST', `/schedules/${rent.id}/end`, { body: { endsOn: '2026-11-01' } })
    await deleteAccount(services)
    const before = services.db.rows('transactions').length
    // An edit form opened before the deletion sends no end date.
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: rent })).toEqual(
      refused,
    )
    expect(
      await failure(services, 'PATCH', `/schedules/${samOnly.id}`, {
        body: { ...samOnly, template: rent.template },
      }),
    ).toEqual(refused)
    expect(services.db.rows('transactions')).toHaveLength(before)
    expect(services.db.rows('schedules').find((row) => row.$id === rent.id)?.endsOn).toBe(
      '2026-11-01',
    )
  })

  it('is refused when the deletion commits just before the schedule guards them', async () => {
    const services = seeded()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"persons"'),
      () => deleteAccount(services),
    )
    expect(await failure(services, 'POST', '/schedules', { body: rent })).toEqual(refused)
    expect(services.db.rows('schedules')).toEqual([])
  })

  it.each([
    ['a new schedule', 'POST'],
    ['an edit', 'PATCH'],
  ])(
    'fails %s whose commit comes after the deletion, and refuses it when run again',
    async (_, method) => {
      const services = seeded()
      if (method === 'PATCH') {
        await create(services, {
          ...rent,
          template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
        })
      }
      // After the guard on pAlex's row is staged: the deletion's write fails the commit (409).
      beforeCommit(services.db, () => deleteAccount(services))
      const path = method === 'POST' ? '/schedules' : `/schedules/${rent.id}`
      expect(await failure(services, method, path, { body: rent })).toEqual(refused)
      const stored = scheduleRow(services, rent.id)
      if (method === 'POST') expect(stored).toBeUndefined()
      else expect(JSON.parse(stored?.templateJson ?? '{}').split.personIds).toEqual(['pSam'])
    },
  )

  it('is refused when the deletion commits just before an edit guards them', async () => {
    const services = seeded()
    const samOnly = {
      ...rent,
      template: { ...rent.template, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await create(services, samOnly)
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"persons"'),
      () => deleteAccount(services),
    )
    expect(await failure(services, 'PATCH', `/schedules/${rent.id}`, { body: rent })).toEqual(
      refused,
    )
  })
})
