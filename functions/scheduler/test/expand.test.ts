import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Transactions } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import { nextRunAt } from '../src/occurrences'
import type { RunResult } from '../src/routes/run'
import { type Fakes, fakes, group, member, ok, person } from './harness'

const ID = 'thursdaysAcmeSam0001'

// A Thursday shift schedule in Acme (Sydney), already expanded to Tuesday 20 October.
function schedule(extra: object = {}) {
  return {
    $id: ID,
    groupId: 'acme',
    kind: 'shift',
    description: 'Thursday shift',
    templateJson: JSON.stringify({ shift: { minutes: 300, rateCents: 2500 } }),
    rrule: 'FREQ=WEEKLY;BYDAY=TH',
    startsOn: '2026-10-01',
    endsOn: null,
    exdates: null,
    skipPublicHolidays: false,
    autoPost: false,
    horizonDays: 56,
    generatedThrough: '2026-10-20',
    nextRunAt: '2026-10-18T13:05:00.000Z',
    createdBy: 'pSam',
    ...extra,
  }
}

function seeded(extra: object = {}, options: { now?: Date } = {}) {
  return fakes(
    {
      persons: [person('pSam', 'u1'), person('pAcme', null)],
      groups: [group('acme', 'pSam'), group('old', 'pSam', { archivedAt: '2026-10-01T00:00:00Z' })],
      members: [
        member('acme', 'pSam'),
        member('acme', 'pAcme', { status: 'placeholder' }),
        member('old', 'pSam'),
        member('old', 'pAcme', { status: 'placeholder' }),
      ],
      schedules: [schedule(extra)],
    },
    { accounts: {}, ...options },
  )
}

function runCron(services: Fakes) {
  return ok<RunResult>(services, 'POST', '/', { userId: null, scheduled: true })
}

function dates(services: Fakes): string[] {
  return (services.db.rows('transactions') as unknown as Transactions[])
    .map((row) => row.date)
    .sort()
}

function scheduleRow(services: Fakes) {
  return services.db.rows('schedules')[0]
}

describe('step 1: expand due schedules', () => {
  it('creates the next occurrences up to the horizon, once', async () => {
    const services = seeded()
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 8, failed: 0 })
    expect(dates(services)).toEqual([
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
      '2026-11-12',
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
      '2026-12-10',
    ])
    expect(scheduleRow(services)).toMatchObject({
      generatedThrough: '2026-12-14',
      nextRunAt: '2026-10-19T13:05:00.000Z',
    })
    // Not due again until 00:05 tomorrow in Sydney.
    expect((await runCron(services)).expanded).toEqual({ schedules: 0, created: 0, failed: 0 })
    expect(dates(services)).toHaveLength(8)
  })

  it('carries on from where it got to on the next day', async () => {
    const services = seeded(
      { generatedThrough: '2026-12-14' },
      {
        now: new Date('2026-10-21T13:10:00.000Z'), // 00:10 on Thursday 22 October in Sydney
      },
    )
    expect((await runCron(services)).expanded.created).toBe(1)
    expect(dates(services)).toEqual(['2026-12-17'])
  })

  it('doesn’t make again an occurrence that was voided or deleted by hand', async () => {
    const services = seeded()
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: `${ID}_20261029`,
        data: {
          groupId: 'acme',
          kind: 'shift',
          status: 'void',
          date: '2026-10-29',
          description: 'Thursday shift',
          totalCents: 12_500,
          inputJson: '{}',
          scheduleId: ID,
          voidReason: 'Sick',
          createdBy: 'pSam',
          updatedBy: 'pSam',
        },
      }),
    )
    expect((await runCron(services)).expanded.created).toBe(7)
    expect(services.db.rows('transactions').find((row) => row.date === '2026-10-29')).toMatchObject(
      { status: 'void' },
    )
  })

  it('runs again when another run creates an occurrence at the same time, without duplicates', async () => {
    const services = seeded()
    const commit = services.db.updateTransaction.bind(services.db)
    let first = true
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && first) {
        first = false
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'create',
            tableId: 'transactions',
            rowId: `${ID}_20261022`,
            data: {
              groupId: 'acme',
              kind: 'shift',
              status: 'scheduled',
              date: '2026-10-22',
              description: 'Thursday shift',
              totalCents: 12_500,
              inputJson: '{}',
              scheduleId: ID,
              createdBy: 'pSam',
              updatedBy: 'pSam',
            },
          }),
        )
      }
      return commit(params)
    })
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 7, failed: 0 })
    expect(dates(services)).toHaveLength(8)
  })

  it('clears nextRunAt in an archived group and creates nothing', async () => {
    const services = seeded({ groupId: 'old' })
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 0, failed: 0 })
    expect(services.db.rows('transactions')).toEqual([])
    expect(scheduleRow(services)?.nextRunAt).toBeNull()
  })

  it('stops once everything up to endsOn exists', async () => {
    const services = seeded({ endsOn: '2026-11-05' })
    expect((await runCron(services)).expanded.created).toBe(3)
    expect(scheduleRow(services)).toMatchObject({ generatedThrough: '2026-11-05', nextRunAt: null })
  })

  it('counts a schedule it can’t expand, and tries it again next run', async () => {
    // The employer's member row is gone, so a shift has nobody to pay it.
    const services = seeded()
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'members', rowId: 'acme-pAcme' }),
    )
    expect((await runCron(services)).expanded).toEqual({ schedules: 0, created: 0, failed: 1 })
    expect(scheduleRow(services)?.nextRunAt).toBe('2026-10-18T13:05:00.000Z')
  })

  it('leaves alone a schedule an edit moved on meanwhile', async () => {
    const services = seeded()
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await list(params)
      if (params.tableId === 'schedules' && page.rows.length > 0) {
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'schedules',
            rowId: ID,
            data: { nextRunAt: '2026-10-19T13:05:00.000Z' },
          }),
        )
      }
      return page
    })
    expect((await runCron(services)).expanded).toEqual({ schedules: 1, created: 0, failed: 0 })
    expect(services.db.rows('transactions')).toEqual([])
  })
})

describe('nextRunAt', () => {
  it.each([
    // Sydney's clocks go forward on 4 October, Los Angeles' back on 1 November.
    ['2026-10-03', 'Australia/Sydney', '2026-10-03T14:05:00.000Z'],
    ['2026-10-04', 'Australia/Sydney', '2026-10-04T13:05:00.000Z'],
    ['2026-10-31', 'America/Los_Angeles', '2026-11-01T07:05:00.000Z'],
    ['2026-11-01', 'America/Los_Angeles', '2026-11-02T08:05:00.000Z'],
  ])('after %s in %s is 00:05 the next day there', (today, timeZone, expected) => {
    expect(nextRunAt(today as LocalDate, timeZone)).toBe(expected)
  })
})
