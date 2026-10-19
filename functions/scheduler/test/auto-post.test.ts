import type { Activity, Shares, Transactions } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import type { ScheduleResult } from '../src/routes/create-schedule'
import type { RunResult } from '../src/routes/run'
import { beforeStaging, type Fakes, fakes, group, member, ok, person } from './harness'

// NOW is 07:00 on Monday 19 October in Sydney, still Sunday 18 October in UTC. Step 2 looks at
// occurrences dated from 11 October (7 days before the UTC date) to 19 October.
function seeded(extraGroups: ReturnType<typeof group>[] = [], statements: object[] = []) {
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
    { accounts: {} },
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

function create(services: Fakes, body: object) {
  return ok<ScheduleResult>(services, 'POST', '/schedules', { body, userId: 'u1' })
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

function update(services: Fakes, tableId: 'transactions' | 'groups', rowId: string, data: object) {
  return withTransaction(services.db, (tx) =>
    tx.write({ action: 'update', tableId, rowId, data: { ...data } }),
  )
}

describe('step 2: auto-post', () => {
  it('posts a past shift of a schedule that auto-posts, once, as its creator', async () => {
    const services = seeded()
    await create(services, thursdays)
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, `${ID}_20261015`)).toMatchObject({
      status: 'posted',
      totalCents: 12_500,
      updatedBy: 'pSam',
    })
    expect(
      sharesOf(services, `${ID}_20261015`).map(({ personId, givenCents, receivedCents }) => ({
        personId,
        givenCents,
        receivedCents,
      })),
    ).toEqual([
      { personId: 'pAcme', givenCents: 0, receivedCents: 12_500 },
      { personId: 'pSam', givenCents: 12_500, receivedCents: 0 },
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

  it('posts expenses on their own day, with the creator paying', async () => {
    const services = seeded()
    await create(services, groceries)
    expect((await runCron(services)).posted.posted).toBe(2)
    for (const date of ['20261012', '20261019']) {
      const id = `${groceries.id}_${date}`
      expect(row(services, id).status).toBe('posted')
      expect(JSON.parse(row(services, id).inputJson).payers).toEqual([
        { personId: 'pSam', cents: 6_000 },
      ])
    }
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

  it('counts an occurrence a member change has broken, and leaves it for the user', async () => {
    const services = seeded()
    await create(services, thursdays)
    // The employer's member row is gone, so the shift has nobody to pay it.
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'members', rowId: 'acme-pAcme' }),
    )
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 1 })
    expect(row(services, `${ID}_20261015`).status).toBe('scheduled')
    expect(services.db.rows('shares')).toEqual([])
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
