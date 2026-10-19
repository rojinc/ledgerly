import type { Activity, Shares, Transactions } from '@ledgerly/core/generated/rows'
import type { ScheduleResult } from '@ledgerly/core/schemas/scheduler'
import { balancesFromShares } from '@ledgerly/core/settle/balances'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../src/routes/run'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  fakes,
  group,
  member,
  NOW,
  ok,
  person,
} from './harness'

// NOW is 07:00 on Monday 19 October in Sydney, still Sunday 18 October in UTC. Step 2 looks at
// occurrences dated from 11 October (7 days before the UTC date) to 19 October.
function seeded(
  extraGroups: ReturnType<typeof group>[] = [],
  statements: object[] = [],
  accounts: NonNullable<Parameters<typeof fakes>[1]>['accounts'] = {},
) {
  return fakes(
    {
      statements: statements as { $id: string }[],
      persons: [person('pSam', 'u1'), person('pAlex', 'u2'), person('pAcme', null)],
      groups: [
        group('acme', 'pSam'),
        group('elm', 'pSam', { type: 'house', name: 'Elm St', settingsJson: '{"type":"house"}' }),
        ...extraGroups,
      ],
      members: [
        member('acme', 'pSam'),
        member('acme', 'pAcme', { status: 'placeholder' }),
        member('elm', 'pSam'),
        member('elm', 'pAlex', { role: 'member' }),
        member('la', 'pSam'),
        member('la', 'pAcme', { status: 'placeholder' }),
      ],
    },
    { accounts },
  )
}

const ID = 'thursdaysAcmeSam0001'

// 1, 8, 15, 22 October and on: only the 15th is in step 2's window and over.
const thursdays = {
  id: ID,
  groupId: 'acme',
  kind: 'shift',
  description: 'Thursday shift',
  template: { category: 'work', shift: { minutes: 300, rateCents: 2500 } },
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  startsOn: '2026-10-01',
  skipPublicHolidays: false,
  autoPost: true,
}

// Mondays from 12 October: the 12th and today, the 19th.
const groceries = {
  id: 'groceriesElm00000001',
  groupId: 'elm',
  kind: 'expense',
  description: 'Groceries',
  template: { totalCents: 6_000, split: { mode: 'equal', personIds: ['pSam', 'pAlex'] } },
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  startsOn: '2026-10-12',
  skipPublicHolidays: false,
  autoPost: true,
}

function create(services: Fakes, body: object, userId = 'u1') {
  return ok<ScheduleResult>(services, 'POST', '/schedules', { body, userId })
}

function runCron(services: Fakes) {
  return ok<RunResult>(services, 'POST', '/', { userId: null, scheduled: true })
}

function row(services: Fakes, id: string): Transactions {
  return services.db.rows('transactions').find((r) => r.$id === id) as unknown as Transactions
}

function sharesOf(services: Fakes, transactionId: string): Shares[] {
  return (services.db.rows('shares') as unknown as Shares[]).filter(
    (share) => share.transactionId === transactionId,
  )
}

function update(
  services: Fakes,
  tableId: 'transactions' | 'groups' | 'schedules' | 'members',
  rowId: string,
  data: object,
) {
  return withTransaction(services.db, (tx) =>
    tx.write({ action: 'update', tableId, rowId, data: { ...data } }),
  )
}

describe('step 2: auto-post', () => {
  // FakeDb stamps $createdAt from the real clock. 1 October: the occurrences these tests make
  // are made before their days, as a cron run on time makes them.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never posts an occurrence made after its own day, so a moved week isn’t paid twice', async () => {
    const services = seeded()
    await create(services, thursdays)
    // Thursday 22 October is posted; then an edit on Wednesday 21 moves the schedule to Fridays
    // but loses its races, so nothing is reconciled until Saturday's run.
    await update(services, 'transactions', `${ID}_20261022`, { status: 'posted' })
    services.now = new Date('2026-10-20T20:00:00.000Z')
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && [2, 4].includes(++commits)) {
        throw new AppwriteException('Conflict', 409, 'transaction_conflict')
      }
      return commit(params)
    })
    await call(services, 'PATCH', `/schedules/${ID}`, {
      body: { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=FR' },
    })
    vi.restoreAllMocks()
    services.now = new Date('2026-10-23T13:05:00.000Z')
    vi.setSystemTime(services.now)
    await runCron(services)
    // Friday 23 was made on Saturday: it waits for the user.
    expect(row(services, `${ID}_20261022`).status).toBe('posted')
    expect(row(services, `${ID}_20261023`).status).toBe('scheduled')
  })

  it('waits for step 1 to finish a schedule that is due', async () => {
    const services = seeded()
    await create(services, thursdays)
    // An edit made it due again, and the 00:05 run's step 1 fails on it (Sydney, 19 October).
    services.now = new Date('2026-10-18T13:05:00.000Z')
    await update(services, 'schedules', ID, { nextRunAt: '2026-10-18T13:00:00.000Z' })
    const commit = services.db.updateTransaction.bind(services.db)
    const timeout = vi.spyOn(services.db, 'updateTransaction')
    timeout.mockImplementationOnce(async (params) => {
      if (params.commit) throw new Error('Timed out')
      return commit(params)
    })
    const first = await runCron(services)
    expect(first.expanded.failed).toBe(1)
    expect(first.posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    timeout.mockRestore()
    // The 01:05 run, long before any reminder.
    services.now = new Date('2026-10-18T14:05:00.000Z')
    expect((await runCron(services)).posted.posted).toBe(1)
  })

  it('posts a past shift of a schedule that auto-posts, once, as its creator', async () => {
    const services = seeded()
    await create(services, thursdays)
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    // Dated on its own day, not the day it was posted.
    expect(row(services, `${ID}_20261015`)).toMatchObject({
      status: 'posted',
      date: '2026-10-15',
      totalCents: 12_500,
      updatedBy: 'pSam',
    })
    expect(
      sharesOf(services, `${ID}_20261015`).map(({ personId, date, givenCents, receivedCents }) => ({
        personId,
        date,
        givenCents,
        receivedCents,
      })),
    ).toEqual([
      { personId: 'pAcme', date: '2026-10-15', givenCents: 0, receivedCents: 12_500 },
      { personId: 'pSam', date: '2026-10-15', givenCents: 12_500, receivedCents: 0 },
    ])
    const activity = services.db.rows('activity') as unknown as Activity[]
    expect(activity).toEqual([
      expect.objectContaining({
        action: 'transaction.posted',
        actorPersonId: null,
        transactionId: `${ID}_20261015`,
      }),
    ])
    // Older than 7 days, it waits for the user; the 22nd hasn't come.
    expect(row(services, `${ID}_20261008`).status).toBe('scheduled')
    expect(row(services, `${ID}_20261022`).status).toBe('scheduled')
  })

  it('posts expenses on their own day, with the creator paying, not the owner', async () => {
    // Alex, a member of Sam's house, made the schedule.
    const services = seeded()
    await create(services, groceries, 'u2')
    expect((await runCron(services)).posted.posted).toBe(2)
    for (const date of ['20261012', '20261019']) {
      const id = `${groceries.id}_${date}`
      expect(row(services, id)).toMatchObject({ status: 'posted', updatedBy: 'pAlex' })
      expect(JSON.parse(row(services, id).inputJson).payers).toEqual([
        { personId: 'pAlex', cents: 6_000 },
      ])
    }
  })

  it('keeps the group’s balances row as it posts (ledger.md#balances)', async () => {
    const services = seeded()
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'create', tableId: 'balances', rowId: 'elm', data: { peopleJson: '[]' } }),
    )
    await create(services, groceries, 'u2')
    expect((await runCron(services)).posted.posted).toBe(2)
    const shares = (services.db.rows('shares') as unknown as Shares[]).filter(
      (share) => share.groupId === 'elm',
    )
    const stored = JSON.parse(String(services.db.rows('balances')[0]?.peopleJson))
    expect(stored).toEqual(balancesFromShares(shares))
    expect(stored).toEqual([
      { personId: 'pAlex', netCents: 6_000, shares: 2 },
      { personId: 'pSam', netCents: -6_000, shares: 2 },
    ])
  })

  it('posts an expense made on its own day, on that day', async () => {
    // Made this morning in Sydney, starting today: on its day, not after it.
    vi.setSystemTime(NOW)
    const services = seeded()
    await create(services, { ...groceries, startsOn: '2026-10-19' })
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(row(services, `${groceries.id}_20261019`).status).toBe('posted')
  })

  it('leaves an expense its creator would pay once they have moved out', async () => {
    // Alex adds groceries for Sam with no payers, so Alex would pay, then moves out.
    const services = seeded()
    const forSam = {
      ...groceries,
      template: { totalCents: 6_000, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await create(services, forSam, 'u2')
    await update(services, 'members', 'elm-pAlex', {
      status: 'left',
      role: 'viewer',
      leftOn: '2026-10-10',
    })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${groceries.id}_20261019`).status).toBe('scheduled')
  })

  it('doesn’t post an expense its creator would pay if they move out just before its guard', async () => {
    const services = seeded()
    const forSam = {
      ...groceries,
      template: { totalCents: 6_000, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await create(services, forSam, 'u2')
    // The 12th, the first one step 2 posts.
    const id = `${groceries.id}_20261012`
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"') && operations.includes(id),
      () => update(services, 'members', 'elm-pAlex', { status: 'left', role: 'viewer' }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, id).status).toBe('scheduled')
    expect(row(services, `${groceries.id}_20261019`).status).toBe('scheduled')
  })

  it('doesn’t post an expense its creator would pay if they move out while it commits', async () => {
    const services = seeded()
    const forSam = {
      ...groceries,
      template: { totalCents: 6_000, split: { mode: 'equal', personIds: ['pSam'] } },
    }
    await create(services, forSam, 'u2')
    // The member row's guard fails the commit, and the rerun finds Alex moved out.
    beforeCommit(services.db, () =>
      update(services, 'members', 'elm-pAlex', { status: 'left', role: 'viewer' }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${groceries.id}_20261012`).status).toBe('scheduled')
    expect(row(services, `${groceries.id}_20261019`).status).toBe('scheduled')
  })

  it('doesn’t post one whose payers an edit drops just before its guard, once its creator left', async () => {
    const services = seeded()
    const samPays = {
      ...groceries,
      template: {
        totalCents: 6_000,
        payers: [{ personId: 'pSam', cents: 6_000 }],
        split: { mode: 'equal', personIds: ['pSam'] },
      },
    }
    await create(services, samPays, 'u2')
    await update(services, 'members', 'elm-pAlex', { status: 'left', role: 'viewer' })
    const id = `${groceries.id}_20261012`
    // The 12th names its payers when step 2 reads it; then an edit leaves Alex paying.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"') && operations.includes(id),
      () => {
        const { payers, ...rest } = JSON.parse(row(services, id).inputJson)
        return update(services, 'transactions', id, { inputJson: JSON.stringify(rest) })
      },
    )
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(row(services, id).status).toBe('scheduled')
    expect(row(services, `${groceries.id}_20261019`).status).toBe('posted')
  })

  it('still posts a shift whose creator has left, since the owner is paid', async () => {
    const services = seeded()
    await create(services, thursdays)
    await update(services, 'members', 'acme-pSam', { status: 'left', role: 'viewer' })
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
  })

  it('still posts one that names its payers after its creator moved out', async () => {
    const services = seeded()
    const samPays = {
      ...groceries,
      template: {
        totalCents: 6_000,
        payers: [{ personId: 'pSam', cents: 6_000 }],
        split: { mode: 'equal', personIds: ['pSam', 'pAlex'] },
      },
    }
    await create(services, samPays, 'u2')
    await update(services, 'members', 'elm-pAlex', {
      status: 'left',
      role: 'viewer',
      leftOn: '2026-10-31',
    })
    expect((await runCron(services)).posted.posted).toBe(2)
  })

  it('looks back 7 days from the UTC date, and no further', async () => {
    const services = seeded()
    await create(services, {
      ...thursdays,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
      startsOn: '2026-10-10',
    })
    // 11 to 18 October.
    expect((await runCron(services)).posted.posted).toBe(8)
    expect(row(services, `${ID}_20261011`).status).toBe('posted')
    expect(row(services, `${ID}_20261010`).status).toBe('scheduled')
  })

  it('leaves a shift on today until the day is over', async () => {
    const services = seeded()
    await create(services, { ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=MO', startsOn: '2026-10-19' })
    expect((await runCron(services)).posted.posted).toBe(0)
    expect(row(services, `${ID}_20261019`).status).toBe('scheduled')
  })

  it('goes by the group’s own date', async () => {
    // 13:00 on Sunday 18 October in Los Angeles: a shift that day isn't over yet.
    const services = seeded([group('la', 'pSam', { timezone: 'America/Los_Angeles' })])
    await create(services, {
      ...thursdays,
      groupId: 'la',
      rrule: 'FREQ=WEEKLY;BYDAY=SA,SU',
      startsOn: '2026-10-17',
    })
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, `${ID}_20261017`).status).toBe('posted')
    expect(row(services, `${ID}_20261018`).status).toBe('scheduled')
  })

  it('leaves schedules that don’t auto-post, and scheduled shifts with no schedule', async () => {
    const services = seeded()
    await create(services, { ...thursdays, autoPost: false })
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: 'manualShift000000001',
        data: {
          groupId: 'acme',
          kind: 'shift',
          status: 'scheduled',
          date: '2026-10-16',
          description: 'Extra shift',
          totalCents: 2_500,
          inputJson: '{"shift":{"minutes":60,"rateCents":2500}}',
          scheduleId: null,
          createdBy: 'pSam',
          updatedBy: 'pSam',
        },
      }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
    expect(row(services, 'manualShift000000001').status).toBe('scheduled')
  })

  it('posts an edited occurrence with its edited values, and never a voided one', async () => {
    const services = seeded()
    await create(services, groceries)
    await update(services, 'transactions', `${groceries.id}_20261012`, {
      overridden: true,
      totalCents: 4_000,
    })
    await update(services, 'transactions', `${groceries.id}_20261019`, { status: 'void' })
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, `${groceries.id}_20261012`)).toMatchObject({
      status: 'posted',
      totalCents: 4_000,
    })
    expect(row(services, `${groceries.id}_20261019`).status).toBe('void')
  })

  it('leaves occurrences in an archived group as they are', async () => {
    const services = seeded()
    await create(services, thursdays)
    await update(services, 'groups', 'acme', { archivedAt: '2026-10-18T00:00:00.000Z' })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
  })

  it('waits while a statement covering the day is being finalized', async () => {
    const services = seeded(
      [],
      [
        {
          $id: 'stmt1',
          groupId: 'acme',
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          status: 'finalizing',
        },
      ],
    )
    await create(services, thursdays)
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 1, failed: 0 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
  })

  it('keeps trying a shift nobody can be asked about, and posts it once it can', async () => {
    // Sam has no account email here, so the 07:00 reminder has nobody to ask.
    const services = seeded(
      [],
      [
        {
          $id: 'stmt1',
          groupId: 'acme',
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          status: 'finalizing',
        },
      ],
    )
    await create(services, thursdays)
    expect(await runCron(services)).toMatchObject({
      posted: { posted: 0, skipped: 1, failed: 0 },
      reminders: { sent: 0, skipped: 0, failed: 0 },
    })
    expect(row(services, `${ID}_20261015`).remindedAt).toBeNull()
    // The finalize ends (its statement goes, say), and the next run posts it.
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'statements', rowId: 'stmt1' }),
    )
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, `${ID}_20261015`).status).toBe('posted')
  })

  it('counts an occurrence a member change has broken, and leaves it for the user', async () => {
    const services = seeded()
    await create(services, thursdays)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The employer's member row is gone, so the shift has nobody to pay it.
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'members', rowId: 'acme-pAcme' }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 1 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
    expect(services.db.rows('shares')).toEqual([])
    // IDs and codes only.
    expect(log).toHaveBeenCalledWith(
      `scheduler: auto-post failed for transaction ${ID}_20261015: AppError INVARIANT_VIOLATION`,
    )
  })

  it('posts an occurrence once when two runs overlap', async () => {
    const services = seeded()
    await create(services, thursdays)
    // A second run starts and posts it while the first one's post commits.
    let second: RunResult | undefined
    beforeCommit(services.db, async () => {
      second = await runCron(services)
    })
    const first = await runCron(services)
    expect([first.posted, second?.posted]).toEqual([
      { posted: 0, skipped: 0, failed: 0 },
      { posted: 1, skipped: 0, failed: 0 },
    ])
    const id = `${ID}_20261015`
    expect(row(services, id).status).toBe('posted')
    expect(sharesOf(services, id)).toHaveLength(2)
    const activity = services.db.rows('activity') as unknown as Activity[]
    expect(activity.filter((entry) => entry.transactionId === id)).toHaveLength(1)
  })

  it('posts a past shift in the night, so step 3 never reminds about it', async () => {
    const services = seeded()
    // 00:05 on Monday 19 October in Sydney, the first run of the day, then 07:00.
    services.now = new Date('2026-10-18T13:05:00.000Z')
    await create(services, thursdays)
    expect((await runCron(services)).posted.posted).toBe(1)
    services.now = NOW
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('posts before it reminds in the same run, even with no run in the night', async () => {
    const services = seeded()
    await create(services, thursdays)
    expect(await runCron(services)).toMatchObject({
      posted: { posted: 1, skipped: 0, failed: 0 },
      reminders: { sent: 0, skipped: 0, failed: 0 },
    })
  })

  it('reminds the owner at 07:00 about a shift it couldn’t post all night', async () => {
    const services = seeded([], [], { u1: { email: 'sam@example.com', emailVerification: true } })
    services.now = new Date('2026-10-18T13:05:00.000Z')
    await create(services, thursdays)
    // Acme's placeholder goes, so the template no longer makes a transaction.
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'members', rowId: 'acme-pAcme' }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runCron(services)).toMatchObject({
      posted: { posted: 0, skipped: 0, failed: 1 },
      reminders: { sent: 0, skipped: 0, failed: 0 },
    })
    services.now = NOW
    expect(await runCron(services)).toMatchObject({
      posted: { posted: 0, skipped: 0, failed: 1 },
      reminders: { sent: 1, skipped: 0, failed: 0 },
    })
    expect(services.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'sam@example.com',
        idempotencyKey: `reminder-${ID}_20261015-2026-10-15`,
      }),
    )
  })

  it('never posts a shift the owner was reminded about, also once autoPost is turned on', async () => {
    const services = seeded()
    await create(services, { ...thursdays, autoPost: false })
    // 07:00: the 15th is reminded (Sam has no email here, so it's only marked).
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 1, failed: 0 })
    const { status } = await call(services, 'PATCH', `/schedules/${ID}`, {
      body: { ...thursdays, autoPost: true },
    })
    expect(status).toBe(200)
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
  })

  it('doesn’t post an occurrence reminded about just before its guard', async () => {
    const services = seeded()
    await create(services, thursdays)
    const id = `${ID}_20261015`
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"') && operations.includes(id),
      () => update(services, 'transactions', id, { remindedAt: NOW.toISOString() }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, id).status).toBe('scheduled')
  })

  it('can’t give a share to a member removed while the post commits', async () => {
    const services = seeded()
    await create(services, thursdays)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'members', rowId: 'acme-pAcme' }),
      ),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 1 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
    expect(services.db.rows('shares')).toEqual([])
  })

  it('doesn’t post an occurrence moved to a later day just before its guard', async () => {
    const services = seeded()
    await create(services, groceries)
    const moved = `${groceries.id}_20261012`
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"') && operations.includes(moved),
      () => update(services, 'transactions', moved, { date: '2026-10-30', overridden: true }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(row(services, moved)).toMatchObject({ status: 'scheduled', date: '2026-10-30' })
    expect(row(services, `${groceries.id}_20261019`).status).toBe('posted')
  })

  it('doesn’t post an occurrence moved to before the day it was made, just before its guard', async () => {
    // Made on 15 October: the 12th waits for the user, and the 19th is on time until a person
    // moves it to the 13th.
    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'))
    const services = seeded()
    await create(services, groceries)
    const moved = `${groceries.id}_20261019`
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"') && operations.includes(moved),
      () => update(services, 'transactions', moved, { date: '2026-10-13', overridden: true }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, moved)).toMatchObject({ status: 'scheduled', date: '2026-10-13' })
    expect(row(services, `${groceries.id}_20261012`).status).toBe('scheduled')
  })

  it('leaves an occurrence a person posted after the page was read', async () => {
    const services = seeded()
    await create(services, thursdays)
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await list(params)
      const scheduled = JSON.stringify(params.queries).includes('scheduled')
      if (params.tableId === 'transactions' && scheduled && page.rows.length > 0) {
        // Posted with fewer hours than the template's.
        await update(services, 'transactions', `${ID}_20261015`, {
          status: 'posted',
          totalCents: 10_000,
        })
      }
      return page
    })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${ID}_20261015`).totalCents).toBe(10_000)
    expect(services.db.rows('activity')).toEqual([])
  })

  it('leaves an occurrence posted the same way just before its guard', async () => {
    const services = seeded()
    await create(services, thursdays)
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"'),
      () => update(services, 'transactions', `${ID}_20261015`, { status: 'posted' }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(services.db.rows('activity')).toEqual([])
  })
})
