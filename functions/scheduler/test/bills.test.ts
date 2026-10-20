import type { Shares, Transactions } from '@ledgerly/core/generated/rows'
import type { ScheduleResult } from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import type { Email } from '@ledgerly/server/email/send-email'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../src/routes/run'
import {
  APP_URL,
  beforeStaging,
  call,
  type Fakes,
  fakes,
  group,
  member,
  ok,
  person,
  profile,
} from './harness'

// 07:30 on Monday 19 October in Sydney (#33's test plan).
const MORNING = new Date('2026-10-18T20:30:00.000Z')
// 01:30 the same day there: too early for reminders.
const NIGHT = new Date('2026-10-18T14:30:00.000Z')

// Elm St, a house: Sam owns it, Kim is an admin whose email isn't verified, Alex is a member and
// Pat a placeholder admin. Sam also has a personal group. `profiles` hold the emails turned off.
function seeded(now: Date, statements: object[] = [], profiles: ReturnType<typeof profile>[] = []) {
  return fakes(
    {
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pKim', 'u3'),
        person('pPat', null),
      ],
      groups: [
        group('elm', 'pSam', { type: 'house', name: 'Elm St', settingsJson: '{"type":"house"}' }),
        group('mine', 'pSam', {
          type: 'personal',
          name: 'Personal',
          settingsJson: '{"type":"personal"}',
        }),
      ],
      members: [
        member('elm', 'pSam'),
        member('elm', 'pAlex', { role: 'member' }),
        member('elm', 'pKim'),
        member('elm', 'pPat', { status: 'placeholder' }),
        member('mine', 'pSam'),
      ],
      statements: statements as { $id: string }[],
      profiles,
    },
    {
      now,
      accounts: {
        u1: { email: 'sam@example.com', emailVerification: true },
        u2: { email: 'alex@example.com', emailVerification: true },
        u3: { email: 'kim@example.com', emailVerification: false },
      },
    },
  )
}

// Monthly rent due on `day` (19, 21 or 22) from October; the ID is 20 characters.
function rent(day: number, autoPost: boolean) {
  return {
    id: `rentDue${day}Elm00000001`,
    groupId: 'elm',
    kind: 'bill',
    description: 'Rent',
    template: {
      category: 'rent',
      totalCents: 90_000,
      split: { mode: 'equal', personIds: ['pSam', 'pAlex'] },
      bill: { status: 'due' },
    },
    rrule: `FREQ=MONTHLY;BYMONTHDAY=${day}`,
    startsOn: `2026-10-${day}`,
    skipPublicHolidays: false,
    autoPost,
  }
}

const occurrence = (day: number) => `rentDue${day}Elm00000001_202610${day}`

async function create(services: Fakes, body: object) {
  return ok<ScheduleResult>(services, 'POST', '/schedules', { body, userId: 'u1' })
}

function runCron(services: Fakes) {
  return ok<RunResult>(services, 'POST', '/', { userId: null, scheduled: true })
}

function row(services: Fakes, id: string): Transactions {
  return services.db.rows('transactions').find((r) => r.$id === id) as unknown as Transactions
}

function update(
  services: Fakes,
  tableId: 'transactions' | 'groups' | 'members',
  rowId: string,
  data: object,
) {
  return withTransaction(services.db, (tx) =>
    tx.write({ action: 'update', tableId, rowId, data: { ...data } }),
  )
}

// A due phone bill in Sam's personal group, with no schedule.
function personalBill(dueOn: string) {
  return {
    groupId: 'mine',
    kind: 'bill',
    status: 'due',
    date: dueOn,
    dueOn,
    description: 'Phone',
    totalCents: 4_500,
    inputJson: '{}',
    remindedAt: null,
    statementId: null,
    createdBy: 'pSam',
    updatedBy: 'pSam',
  }
}

function sent(services: Fakes): Email[] {
  return services.sendEmail.mock.calls.map(([email]) => email)
}

// FakeDb stamps $createdAt from the real clock. 1 October: the occurrences these tests make are
// made before their days, as a cron run on time makes them, so autopay may post them.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('step 2: autopay bills', () => {
  it('posts a bill on its due date with the template’s split, once', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, true))
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, occurrence(19))).toMatchObject({
      status: 'posted',
      date: '2026-10-19',
      totalCents: 90_000,
    })
    // The schedule's creator paid, and the split is the template's.
    const shares = (services.db.rows('shares') as unknown as Shares[])
      .map(({ personId, givenCents, receivedCents }) => [personId, givenCents, receivedCents])
      .sort()
    expect(shares).toEqual([
      ['pAlex', 0, 45_000],
      ['pSam', 90_000, 45_000],
    ])
  })

  it('still posts a bill on its due date after its “due soon” reminder', async () => {
    const services = seeded(MORNING)
    await create(services, rent(21, true))
    expect((await runCron(services)).reminders.sent).toBe(1)
    // 07:30 on Wednesday 21 October in Sydney.
    services.now = new Date('2026-10-20T20:30:00.000Z')
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(row(services, occurrence(21)).status).toBe('posted')
  })

  it('leaves a bill its creator would pay once they have moved out', async () => {
    const services = seeded(MORNING)
    // Alex adds the rent with no payers, so Alex would pay it, then moves out.
    await ok<ScheduleResult>(services, 'POST', '/schedules', { body: rent(19, true), userId: 'u2' })
    await update(services, 'members', 'elm-pAlex', { status: 'left', role: 'viewer' })
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 0, failed: 0 })
    expect(row(services, occurrence(19)).status).toBe('due')
  })

  it('never posts a bill whose schedule doesn’t auto-post, or a voided one', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, false))
    await create(services, { ...rent(19, true), id: 'rentVoidElm000000001' })
    await update(services, 'transactions', 'rentVoidElm000000001_20261019', { status: 'void' })
    expect((await runCron(services)).posted.posted).toBe(0)
    expect(row(services, occurrence(19)).status).toBe('due')
  })

  it('posts an edited bill with its edited amount', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, true))
    await update(services, 'transactions', occurrence(19), { overridden: true, totalCents: 95_000 })
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, occurrence(19))).toMatchObject({ status: 'posted', totalCents: 95_000 })
  })

  it('dates it on its due date, also after the due date was edited', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, true))
    await update(services, 'transactions', occurrence(19), {
      overridden: true,
      dueOn: '2026-10-17',
    })
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, occurrence(19))).toMatchObject({ status: 'posted', date: '2026-10-17' })
  })

  it('dates it on the due date as it is when posted, if it moves just before', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, true))
    beforeStaging(
      services.db,
      (operations) => operations.includes('"updatedBy"') && operations.includes(occurrence(19)),
      () =>
        update(services, 'transactions', occurrence(19), { overridden: true, dueOn: '2026-10-17' }),
    )
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, occurrence(19))).toMatchObject({ status: 'posted', date: '2026-10-17' })
  })

  it('never autopays a bill made after its due date, until the due date moves later', async () => {
    // 07:30 on Wednesday 21 October in Sydney: rent from the 19th is made two days late.
    const later = new Date('2026-10-20T20:30:00.000Z')
    vi.setSystemTime(later)
    const services = seeded(later)
    await create(services, rent(19, true))
    expect((await runCron(services)).posted.posted).toBe(0)
    expect(row(services, occurrence(19)).status).toBe('due')
    await update(services, 'transactions', occurrence(19), {
      overridden: true,
      dueOn: '2026-10-21',
    })
    expect((await runCron(services)).posted.posted).toBe(1)
    expect(row(services, occurrence(19))).toMatchObject({ status: 'posted', date: '2026-10-21' })
  })

  it('waits while a statement covering the due date is being finalized', async () => {
    const services = seeded(MORNING, [
      {
        $id: 'stmt1',
        groupId: 'elm',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        status: 'finalizing',
      },
    ])
    await create(services, rent(19, true))
    expect((await runCron(services)).posted).toEqual({ posted: 0, skipped: 1, failed: 0 })
    expect(row(services, occurrence(19)).status).toBe('due')
  })
})

describe('step 3: bill due soon', () => {
  it('reminds each joined admin with a verified email, from 2 days before, once', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, true))
    await create(services, rent(21, false))
    await create(services, rent(22, false))
    expect((await runCron(services)).reminders).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 0 })
    // Only Sam: Kim's email isn't verified, Alex isn't an admin, Pat hasn't joined. The 19th
    // was paid by autopay, and the 22nd is 3 days away.
    expect(sent(services)).toEqual([
      expect.objectContaining({
        to: 'sam@example.com',
        subject: 'Rent is due on Wednesday 21 October',
        idempotencyKey: `reminder-${occurrence(21)}-2026-10-21-pSam`,
      }),
    ])
    expect(sent(services)[0]?.text).toContain('Rent in Elm St ($900.00) is due on')
    expect(row(services, occurrence(21)).remindedAt).not.toBeNull()
    expect(row(services, occurrence(22)).remindedAt).toBeNull()
  })

  it('reminds every joined admin, each with their own key', async () => {
    const services = seeded(MORNING)
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'members',
        rowId: 'elm-pAlex',
        data: { role: 'admin' },
      }),
    )
    await create(services, rent(21, false))
    await runCron(services)
    expect(
      sent(services)
        .map((email) => [email.to, email.idempotencyKey])
        .sort(),
    ).toEqual([
      ['alex@example.com', `reminder-${occurrence(21)}-2026-10-21-pAlex`],
      ['sam@example.com', `reminder-${occurrence(21)}-2026-10-21-pSam`],
    ])
  })

  it('waits until 07:00 in the group’s time zone', async () => {
    const services = seeded(NIGHT)
    await create(services, rent(21, false))
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect(row(services, occurrence(21)).remindedAt).toBeNull()
  })

  it('reminds again about a new due date', async () => {
    const services = seeded(MORNING)
    await create(services, rent(21, false))
    await runCron(services)
    // An edit that moves the due date clears remindedAt (functions-api.md#ledger).
    await update(services, 'transactions', occurrence(21), {
      dueOn: '2026-10-20',
      remindedAt: null,
    })
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services).map((email) => email.idempotencyKey)).toEqual([
      `reminder-${occurrence(21)}-2026-10-21-pSam`,
      `reminder-${occurrence(21)}-2026-10-20-pSam`,
    ])
  })

  it('goes by the group’s own date', async () => {
    // 20:00 on Sunday 18 October in Los Angeles, already the 19th in UTC: the 18th is today
    // there, the 20th 2 days away and the 21st 3.
    const services = seeded(new Date('2026-10-19T03:00:00.000Z'))
    await update(services, 'groups', 'mine', { timezone: 'America/Los_Angeles' })
    for (const dueOn of ['2026-10-18', '2026-10-20', '2026-10-21']) {
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'create',
          tableId: 'transactions',
          rowId: `phoneBill0000000${dueOn.slice(-2)}01`,
          data: personalBill(dueOn),
        }),
      )
    }
    expect((await runCron(services)).reminders.sent).toBe(2)
    expect(sent(services).map((email) => email.subject)).toEqual([
      'Phone is due on Sunday 18 October',
      'Phone is due on Tuesday 20 October',
    ])
  })

  it('never reminds about an overdue bill', async () => {
    const services = seeded(MORNING)
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: 'phoneBill00000000001',
        data: personalBill('2026-10-18'),
      }),
    )
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(row(services, 'phoneBill00000000001').remindedAt).toBeNull()
  })

  it('leaves out an admin who has left, even with a verified email', async () => {
    const services = seeded(MORNING)
    await update(services, 'members', 'elm-pAlex', { role: 'admin', status: 'left' })
    await create(services, rent(21, false))
    await runCron(services)
    expect(sent(services).map((email) => email.to)).toEqual(['sam@example.com'])
  })

  it('leaves out a blocked admin, as one whose account is being deleted is', async () => {
    const services = seeded(MORNING)
    await update(services, 'members', 'elm-pAlex', { role: 'admin' })
    const get = services.users.get
    vi.spyOn(services.users, 'get').mockImplementation(async (params) => ({
      ...(await get(params)),
      status: params.userId !== 'u2',
    }))
    await create(services, rent(21, false))
    await runCron(services)
    expect(sent(services).map((email) => email.to)).toEqual(['sam@example.com'])
  })

  it('leaves out an admin who turned the email off; other admins still get theirs', async () => {
    const services = seeded(
      MORNING,
      [],
      [
        profile('u1', 'pSam', ['billDue']),
        // Other emails turned off don't touch this one.
        profile('u2', 'pAlex', ['shiftToConfirm', 'statementReady']),
      ],
    )
    await update(services, 'members', 'elm-pAlex', { role: 'admin' })
    await create(services, rent(21, false))
    expect((await runCron(services)).reminders).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect(sent(services).map((email) => email.to)).toEqual(['alex@example.com'])
  })

  it('marks it reminded and counts it skipped when every admin turned the email off; autopay still posts it', async () => {
    const services = seeded(
      MORNING,
      [],
      [profile('u1', 'pSam', ['billDue']), profile('u2', 'pAlex', ['billDue'])],
    )
    await update(services, 'members', 'elm-pAlex', { role: 'admin' })
    // Autopay, due in 2 days.
    await create(services, rent(21, true))
    expect((await runCron(services)).reminders).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(row(services, occurrence(21)).remindedAt).not.toBeNull()
    // 07:30 on Wednesday 21 October in Sydney.
    services.now = new Date('2026-10-20T20:30:00.000Z')
    expect((await runCron(services)).posted).toEqual({ posted: 1, skipped: 0, failed: 0 })
    expect(row(services, occurrence(21)).status).toBe('posted')
  })

  it('sends the amount as it is when the reminder is marked, not as the page read it', async () => {
    const services = seeded(MORNING)
    await create(services, rent(21, false))
    // The rent goes up to $1,200 after the page was read, just before the reminder is staged.
    beforeStaging(
      services.db,
      (operations) => operations.includes('remindedAt'),
      () => update(services, 'transactions', occurrence(21), { totalCents: 120_000 }),
    )
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services)[0]?.text).toContain('($1,200.00)')
  })

  it('tells admins of an autopay bill that it will be posted', async () => {
    const services = seeded(MORNING)
    // Autopay, due in 2 days.
    await create(services, rent(21, true))
    await runCron(services)
    expect(sent(services)[0]?.text).toContain('Autopay puts it on the ledger as paid that day.')
  })

  it('asks to mark paid an autopay bill due today that step 2 had to leave', async () => {
    const services = seeded(MORNING)
    // Alex adds the rent due today with no payers, so Alex would pay it, then moves out: step 2
    // leaves it (C1), earlier in the same run.
    await ok<ScheduleResult>(services, 'POST', '/schedules', { body: rent(19, true), userId: 'u2' })
    await update(services, 'members', 'elm-pAlex', { status: 'left', role: 'viewer' })
    const result = await runCron(services)
    expect(result.posted.posted).toBe(0)
    expect(result.reminders.sent).toBe(1)
    expect(sent(services)[0]?.text).toContain('mark it paid')
    expect(sent(services)[0]?.text).not.toContain('Autopay')
  })

  it('asks to mark paid an autopay bill due today that step 2 left while a statement is finalizing', async () => {
    const services = seeded(MORNING, [
      {
        $id: 'stmt1',
        groupId: 'elm',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        status: 'finalizing',
      },
    ])
    // Sam's rent, due today: Sam pays it as an active member, so only the finalize holds it.
    await create(services, rent(19, true))
    const result = await runCron(services)
    expect(result.posted).toEqual({ posted: 0, skipped: 1, failed: 0 })
    expect(result.reminders.sent).toBe(1)
    expect(sent(services)[0]?.text).toContain('mark it paid')
    expect(sent(services)[0]?.text).not.toContain('Autopay')
  })

  it('asks to mark paid an autopay bill its creator would pay after moving out', async () => {
    const services = seeded(MORNING)
    // Alex adds the rent due in 2 days with no payers, so Alex would pay it, then moves out:
    // step 2 will leave it (C1).
    await ok<ScheduleResult>(services, 'POST', '/schedules', { body: rent(21, true), userId: 'u2' })
    await update(services, 'members', 'elm-pAlex', { status: 'left', role: 'viewer' })
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services)[0]?.text).toContain('mark it paid')
    expect(sent(services)[0]?.text).not.toContain('Autopay')
  })

  it('sends the description as it is when the reminder is marked, not as the page read it', async () => {
    const services = seeded(MORNING)
    await create(services, rent(21, false))
    // The description changes after the page was read, just before the reminder is staged.
    beforeStaging(
      services.db,
      (operations) => operations.includes('remindedAt'),
      () => update(services, 'transactions', occurrence(21), { description: 'Rent and water' }),
    )
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services)[0]?.subject).toBe('Rent and water is due on Wednesday 21 October')
  })

  it('waits for a bill whose due date changes after the page was read', async () => {
    const services = seeded(MORNING)
    await create(services, rent(21, false))
    const list = services.db.listRows.bind(services.db)
    let moved = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await list(params)
      const bills = JSON.stringify(params.queries).includes('dueOn')
      if (!moved && params.tableId === 'transactions' && bills && page.rows.length > 0) {
        moved = true
        await update(services, 'transactions', occurrence(21), { dueOn: '2026-10-20' })
      }
      return page
    })
    expect((await runCron(services)).reminders.sent).toBe(0)
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services)[0]?.idempotencyKey).toBe(`reminder-${occurrence(21)}-2026-10-20-pSam`)
  })

  it('reminds the owner of a personal bill', async () => {
    const services = seeded(MORNING)
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: 'phoneBill00000000001',
        data: personalBill('2026-10-20'),
      }),
    )
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services)[0]).toMatchObject({
      to: 'sam@example.com',
      subject: 'Phone is due on Tuesday 20 October',
    })
  })

  it('reminds an owner who turned no email off, with a link to Profile', async () => {
    const services = seeded(MORNING, [], [profile('u1', 'pSam', null)])
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: 'phoneBill00000000001',
        data: personalBill('2026-10-20'),
      }),
    )
    expect((await runCron(services)).reminders.sent).toBe(1)
    expect(sent(services)[0]?.to).toBe('sam@example.com')
    expect(sent(services)[0]?.text).toContain(`${APP_URL}/profile`)
  })

  it('skips an archived group, and marks its bills', async () => {
    const services = seeded(MORNING)
    await create(services, rent(19, true))
    await create(services, rent(21, false))
    await update(services, 'groups', 'elm', { archivedAt: '2026-10-18T00:00:00.000Z' })
    const run = await runCron(services)
    expect(run.posted.posted).toBe(0)
    // Both bills are in the window: marked, so they aren't read every hour.
    expect(run.reminders).toEqual({ sent: 0, skipped: 2, failed: 0 })
    expect(row(services, occurrence(19)).status).toBe('due')
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('logs counts only', async () => {
    const services = seeded(MORNING)
    await create(services, rent(21, false))
    const { logs } = await call(services, 'POST', '/', { userId: null, scheduled: true })
    expect(logs.join('\n')).not.toMatch(/sam@example\.com|Elm St|Rent/)
  })
})
