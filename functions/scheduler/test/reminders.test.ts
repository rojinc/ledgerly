import type { Transactions } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { EmailError } from '@ledgerly/server/email/send-email'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import { schedulerRoutes } from '../src/main'
import type { RunResult } from '../src/routes/run'
import {
  APP_URL,
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

const SYDNEY_YESTERDAY = '2026-10-18'

function transaction(id: string, extra: Partial<Transactions> = {}) {
  return {
    $id: id,
    $createdAt: '2026-10-01T00:00:00.000Z',
    groupId: 'acme',
    kind: 'shift',
    status: 'scheduled',
    date: SYDNEY_YESTERDAY,
    description: 'Thursday shift',
    category: 'work',
    totalCents: 12_500,
    inputJson: '{}',
    dueOn: null,
    scheduleId: 'manual',
    overridden: false,
    statementId: null,
    receiptFileIds: null,
    startedAt: null,
    remindedAt: null,
    voidReason: null,
    createdBy: 'pSam',
    updatedBy: 'pSam',
    ...extra,
  }
}

function schedule(id: string, autoPost: boolean) {
  return {
    $id: id,
    groupId: 'acme',
    kind: 'shift',
    description: 'Thursday shift',
    templateJson: '{}',
    rrule: 'FREQ=WEEKLY;BYDAY=TH',
    startsOn: '2026-10-01',
    endsOn: null,
    exdates: null,
    skipPublicHolidays: false,
    autoPost,
    horizonDays: 56,
    generatedThrough: null,
    nextRunAt: null,
    createdBy: 'pSam',
  }
}

// Sam (u1) owns Acme in Sydney; Alex (u2) is a member there.
function seeded(
  transactions: ReturnType<typeof transaction>[],
  options: Parameters<typeof fakes>[1] = {},
) {
  return fakes(
    {
      persons: [person('pSam', 'u1'), person('pAlex', 'u2'), person('pKim', null)],
      groups: [
        group('acme', 'pSam'),
        group('utc', 'pSam', { name: 'Night shift', timezone: 'UTC' }),
        group('la', 'pSam', { name: 'Studio', timezone: 'America/Los_Angeles', region: 'US-CA' }),
        group('old', 'pSam', { archivedAt: '2026-10-01T00:00:00Z' }),
      ],
      members: [
        member('acme', 'pSam'),
        member('acme', 'pAlex', { role: 'member' }),
        member('acme', 'pKim', { role: 'member', status: 'placeholder' }),
        member('utc', 'pSam'),
        member('la', 'pSam'),
        member('old', 'pSam'),
      ],
      schedules: [schedule('manual', false), schedule('auto', true)],
      transactions,
    },
    options,
  )
}

function runCron(services: Fakes) {
  return ok<RunResult>(services, 'POST', '/', { userId: null, scheduled: true })
}

function remindedAt(services: Fakes, id: string) {
  return services.db.rows('transactions').find((row) => row.$id === id)?.remindedAt
}

describe('POST / (cron run)', () => {
  it('runs only as the scheduler’s own cron', async () => {
    const services = seeded([transaction('t1')])
    expect(await failure(services, 'POST', '/', { userId: 'u1' })).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(await failure(services, 'POST', '/', { userId: null })).toEqual({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
    // A person's request is never a cron run, whatever its trigger says.
    expect(await failure(services, 'POST', '/', { userId: 'u1', scheduled: true })).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('refuses before it needs the execution’s API key', async () => {
    const handler = createHandler(
      schedulerRoutes(() => {
        throw new Error('The x-appwrite-key header is missing')
      }),
      () => fakes().db,
      async (jwt) => jwt.slice('jwt-'.length),
    )
    let status: number | undefined
    await handler({
      req: {
        method: 'POST',
        path: '/',
        headers: { 'x-appwrite-user-jwt': 'jwt-u1' },
        bodyText: '',
      },
      res: { json: (_body, code) => (status = code) },
      log: () => {},
      error: () => {},
    })
    expect(status).toBe(403)
  })

  it('logs counts only', async () => {
    const teams = Object.fromEntries(['acme', 'utc', 'la', 'old'].map((id) => [id, ['u1']]))
    const services = seeded([transaction('t1')], { teams })
    const { body, logs } = await call(services, 'POST', '/', { userId: null, scheduled: true })
    expect(body).toEqual({
      ok: true,
      data: {
        expanded: { schedules: 0, created: 0, failed: 0 },
        posted: { posted: 0, skipped: 0, failed: 0 },
        reminders: { sent: 1, skipped: 0, failed: 0 },
        summaries: { sent: 0, skipped: 0, failed: 0 },
        // Step 6's first pass backfills each group's balances row.
        checked: {
          checked: 4,
          busy: 0,
          cutOff: 0,
          skipped: 0,
          findings: 0,
          merging: 0,
          repaired: 4,
          failed: 0,
        },
      },
    })
    expect(logs.join('\n')).not.toContain('sam@example.com')
  })
})

describe('step 3: shift to confirm', () => {
  it('emails the group owner once about a past shift that doesn’t auto-post', async () => {
    const services = seeded([transaction('t1')])
    expect((await runCron(services)).reminders).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect(services.sendEmail).toHaveBeenCalledTimes(1)
    const email = services.sendEmail.mock.calls[0]?.[0]
    expect(email).toMatchObject({
      to: 'sam@example.com',
      subject: expect.stringContaining('Confirm your shift'),
      idempotencyKey: 'reminder-t1',
    })
    expect(email?.text).toContain(`${APP_URL}/groups/acme/transactions/t1`)
    expect(remindedAt(services, 't1')).toBe(NOW.toISOString())

    // The next run sends nothing more.
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(services.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('reminds about shifts with no schedule too, since nothing posts them', async () => {
    const services = seeded([transaction('t1', { scheduleId: null })])
    expect((await runCron(services)).reminders.sent).toBe(1)
  })

  it('reminds about a shift of an auto-post schedule that step 2 couldn’t post', async () => {
    // Its template no longer makes a transaction, so step 2 fails on it every hour.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const services = seeded([transaction('t1', { scheduleId: 'auto' })])
    expect(await runCron(services)).toMatchObject({
      posted: { posted: 0, skipped: 0, failed: 1 },
      reminders: { sent: 1, skipped: 0, failed: 0 },
    })
    expect(remindedAt(services, 't1')).toBe(NOW.toISOString())
    quiet.mockRestore()
  })

  it('reminds about a shift of an auto-post schedule made after its day, which step 2 leaves', async () => {
    // Made on Sydney's 19 October (now), for the 18th.
    const late = transaction('t1', { scheduleId: 'auto', $createdAt: NOW.toISOString() })
    const services = seeded([late])
    expect(await runCron(services)).toMatchObject({
      posted: { posted: 0, skipped: 0, failed: 0 },
      reminders: { sent: 1, skipped: 0, failed: 0 },
    })
  })

  it('reminds about a shift whose schedule was deleted', async () => {
    const services = seeded([transaction('t1', { scheduleId: 'gone' })])
    expect((await runCron(services)).reminders.sent).toBe(1)
  })

  it('only looks at shifts that are still scheduled and not reminded', async () => {
    const services = seeded([
      transaction('posted', { status: 'posted' }),
      transaction('expense', { kind: 'expense' }),
      transaction('done', { remindedAt: '2026-10-17T20:00:00.000Z' }),
    ])
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 0 })
  })

  it('waits until the shift’s day is over in the group’s timezone', async () => {
    const services = seeded([
      // Today in Sydney.
      transaction('today', { date: '2026-10-19' }),
      // Today in UTC: already over in Sydney, but not in a group on UTC.
      transaction('sydney', { date: '2026-10-18' }),
      transaction('utc', { groupId: 'utc', date: '2026-10-18' }),
    ])
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(remindedAt(services, 'sydney')).toBe(NOW.toISOString())
    expect(remindedAt(services, 'today')).toBeNull()
    expect(remindedAt(services, 'utc')).toBeNull()
  })

  it('uses the local date in a group behind UTC too', async () => {
    // 13:00 on Sunday 18 October in Los Angeles.
    const services = seeded([
      transaction('saturday', { groupId: 'la', date: '2026-10-17' }),
      transaction('sunday', { groupId: 'la', date: '2026-10-18' }),
    ])
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(remindedAt(services, 'saturday')).toBe(NOW.toISOString())
    expect(remindedAt(services, 'sunday')).toBeNull()
  })

  it('looks back 7 days before the UTC date, no further', async () => {
    const services = seeded([
      transaction('week', { date: '2026-10-11' }),
      transaction('older', { date: '2026-10-10' }),
    ])
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(remindedAt(services, 'week')).toBe(NOW.toISOString())
    expect(remindedAt(services, 'older')).toBeNull()
  })

  it('sends nothing before 07:00 in the group’s timezone', async () => {
    const services = seeded([transaction('t1')], {
      now: new Date('2026-10-18T19:59:59.000Z'), // 06:59:59 in Sydney
    })
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect(remindedAt(services, 't1')).toBeNull()
  })

  it('sends nothing in archived groups, and marks the row so it isn’t read again', async () => {
    const services = seeded([transaction('t1', { groupId: 'old' })])
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(remindedAt(services, 't1')).toBe(NOW.toISOString())
  })

  it('looks each recipient up once per run', async () => {
    const services = seeded([transaction('t1'), transaction('t2', { date: '2026-10-17' })])
    const get = vi.spyOn(services.users, 'get')
    expect((await runCron(services)).reminders.sent).toBe(2)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['has no verified email', { email: 'sam@example.com', emailVerification: false }],
    [
      'is blocked, as one being deleted is',
      { email: 'sam@example.com', emailVerification: true, status: false },
    ],
  ])('marks it reminded without sending when the owner’s account %s', async (_case, account) => {
    const services = seeded([transaction('t1')], { accounts: { u1: account } })
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(remindedAt(services, 't1')).toBe(NOW.toISOString())
  })

  it('tries again next run when the email fails', async () => {
    const services = seeded([transaction('t1')])
    services.sendEmail.mockRejectedValueOnce(new EmailError('Resend answered 500', 'unknown', 500))
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(remindedAt(services, 't1')).toBeNull()
    services.sendEmail.mockRejectedValueOnce(
      new EmailError('Resend answered 429', 'rate_limit_exceeded', 429),
    )
    expect((await runCron(services)).reminders.failed).toBe(1)
    expect(remindedAt(services, 't1')).toBeNull()
    expect((await runCron(services)).reminders.sent).toBe(1)
  })

  it('marks an email Resend will never take, so it isn’t tried every hour', async () => {
    const services = seeded([transaction('t1'), transaction('t2', { date: '2026-10-17' })])
    services.sendEmail
      .mockRejectedValueOnce(new EmailError('Resend answered 422', 'validation_error', 422))
      .mockRejectedValueOnce(
        new EmailError('Resend answered 409', 'invalid_idempotent_request', 409),
      )
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 2 })
    expect(remindedAt(services, 't1')).toBe(NOW.toISOString())
    expect(remindedAt(services, 't2')).toBe(NOW.toISOString())
  })

  it('counts any other failure and carries on with the next row', async () => {
    const services = seeded([transaction('t1'), transaction('t2', { date: '2026-10-17' })])
    services.sendEmail.mockRejectedValueOnce(new TypeError('boom'))
    expect((await runCron(services)).reminders).toEqual({ sent: 1, skipped: 0, failed: 1 })
    expect(remindedAt(services, 't1')).toBeNull()
    expect(remindedAt(services, 't2')).toBe(NOW.toISOString())
  })

  it('sends nothing about a shift posted after the page was read', async () => {
    const services = seeded([transaction('t1')])
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await list(params)
      if (params.tableId === 'transactions' && page.rows.length > 0) {
        // Posted and locked by a final statement before the reminder is staged.
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: 't1',
            data: { status: 'posted', statementId: 'st1' },
          }),
        )
      }
      return page
    })
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    // A locked transaction is never changed (I-7).
    expect(remindedAt(services, 't1')).toBeNull()
  })

  it('sends nothing when another run reminded it first', async () => {
    const services = seeded([transaction('t1')])
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await list(params)
      if (params.tableId === 'transactions' && page.rows.length > 0) {
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: 't1',
            data: { remindedAt: '2026-10-18T19:59:00.000Z' },
          }),
        )
      }
      return page
    })
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('counts it sent when the row changed or went away after the email', async () => {
    const changed = seeded([transaction('t1')])
    const commit = changed.db.updateTransaction.bind(changed.db)
    let first = true
    vi.spyOn(changed.db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && first) {
        first = false
        // Someone edits the shift after the remindedAt write was staged: the commit gets a 409.
        await withTransaction(changed.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: 't1',
            data: { updatedBy: 'pAlex' },
          }),
        )
      }
      return commit(params)
    })
    expect((await runCron(changed)).reminders.sent).toBe(1)

    const deleted = seeded([transaction('t1')])
    deleted.sendEmail.mockImplementationOnce(async () => {
      await withTransaction(deleted.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'transactions', rowId: 't1' }),
      )
      return {}
    })
    expect((await runCron(deleted)).reminders.sent).toBe(1)
  })

  it('fails the run without APP_URL, rather than send a broken link', async () => {
    const services = seeded([transaction('t1')])
    services.appUrl = ''
    expect(await failure(services, 'POST', '/', { userId: null, scheduled: true })).toEqual({
      status: 500,
      code: 'INTERNAL',
    })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('builds links from APP_URL with or without a trailing slash', async () => {
    const services = seeded([transaction('t1')])
    services.appUrl = `${APP_URL}/`
    await runCron(services)
    expect(services.sendEmail.mock.calls[0]?.[0].text).toContain(
      `${APP_URL}/groups/acme/transactions/t1`,
    )
  })
})

describe('step 3: timer still running', () => {
  const started = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

  it('emails whoever started a timer that has run more than 12 hours, once', async () => {
    const services = seeded([
      transaction('long', { status: 'running', startedAt: started(13), createdBy: 'pAlex' }),
      transaction('short', { status: 'running', startedAt: started(11), createdBy: 'pAlex' }),
    ])
    expect((await runCron(services)).reminders).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect(services.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alex@example.com',
        subject: 'Your timer is still running',
        idempotencyKey: 'reminder-long',
      }),
    )
    // Shown in the group's timezone: 18:00 on 18 October in Sydney.
    expect(services.sendEmail.mock.calls[0]?.[0].text).toMatch(/18 October.*6:00/i)
    expect(remindedAt(services, 'short')).toBeNull()
    expect((await runCron(services)).reminders.sent).toBe(0)
  })

  it('sends nothing before 07:00 or in archived groups', async () => {
    const early = seeded([transaction('t1', { status: 'running', startedAt: started(13) })], {
      now: new Date('2026-10-18T19:00:00.000Z'),
    })
    expect((await runCron(early)).reminders.sent).toBe(0)
    const archived = seeded([
      transaction('t1', { groupId: 'old', status: 'running', startedAt: started(13) }),
    ])
    expect((await runCron(archived)).reminders.sent).toBe(0)
  })

  it('skips people who haven’t joined, have no account or whose account is gone', async () => {
    const running = (id: string, createdBy: string) =>
      transaction(id, { status: 'running', startedAt: started(13), createdBy })
    const services = seeded(
      [running('placeholder', 'pKim'), running('stranger', 'pNobody'), running('gone', 'pAlex')],
      { accounts: { u1: { email: 'sam@example.com', emailVerification: true } } },
    )
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 3, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('counts it failed when Appwrite can’t say whether the account exists', async () => {
    const services = seeded([
      transaction('t1', { status: 'running', startedAt: started(13), createdBy: 'pAlex' }),
    ])
    vi.spyOn(services.users, 'get').mockRejectedValue(
      new AppwriteException('Server error', 500, 'general_server_error'),
    )
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(remindedAt(services, 't1')).toBeNull()
  })

  it('sends nothing about a timer stopped after the page was read', async () => {
    const services = seeded([
      transaction('t1', { status: 'running', startedAt: started(13), createdBy: 'pAlex' }),
    ])
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await list(params)
      if (params.tableId === 'transactions' && page.rows.length > 0) {
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'transactions',
            rowId: 't1',
            data: { status: 'posted' },
          }),
        )
      }
      return page
    })
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing to someone who has left the group', async () => {
    const services = seeded([
      transaction('t1', { status: 'running', startedAt: started(13), createdBy: 'pAlex' }),
    ])
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'members',
        rowId: 'acme-pAlex',
        data: { status: 'left' },
      }),
    )
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('stops a person without an account before looking for one', async () => {
    const services = seeded([
      transaction('t1', { status: 'running', startedAt: started(13), createdBy: 'pKim' }),
    ])
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'members',
        rowId: 'acme-pKim',
        data: { status: 'active' },
      }),
    )
    const get = vi.spyOn(services.users, 'get')
    expect((await runCron(services)).reminders.skipped).toBe(1)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('step 3: batches', () => {
  const shifts = (count: number) =>
    Array.from({ length: count }, (_, index) => transaction(`t${`${index}`.padStart(3, '0')}`))

  it('works through every page of 100', async () => {
    const services = seeded(shifts(205))
    expect((await runCron(services)).reminders.sent).toBe(205)
  })

  it('stops, even within a page, once the time budget is used up', async () => {
    const services = seeded(shifts(150))
    services.outOfTime = () => services.sendEmail.mock.calls.length >= 30
    expect((await runCron(services)).reminders.sent).toBe(30)
    expect(remindedAt(services, 't030')).toBeNull()
  })

  it('moves past rows it can’t send yet instead of reading them again', async () => {
    // 150 shifts of today in a UTC group match the query but stay unreminded; the one after
    // them still goes out. A stuck page would hit the limit of pages below first.
    const services = seeded([
      ...Array.from({ length: 150 }, (_, index) =>
        transaction(`a${`${index}`.padStart(3, '0')}`, { groupId: 'utc', date: '2026-10-18' }),
      ),
      transaction('z'),
    ])
    let pages = 0
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'transactions') pages += 1
      return list(params)
    })
    services.outOfTime = () => pages > 10
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(remindedAt(services, 'z')).toBe(NOW.toISOString())
    expect(remindedAt(services, 'a000')).toBeNull()
  })
})
