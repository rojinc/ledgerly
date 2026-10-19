import { MAX_AMOUNT_CENTS } from '@ledgerly/core/constants/limits'
import type { Profiles } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../src/routes/run'
import type { AccountUser } from '../src/services'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  fakes,
  group,
  member,
  ok,
  person,
} from './harness'

// NOW (harness) is 07:00 on Monday 19 October in Sydney: Sam's weekly summary of 12–18
// October is due.
const DUE = '2026-10-18T20:00:00.000Z'
const NEXT_WEEK = '2026-10-25T20:00:00.000Z'

function profile(extra: Partial<Profiles> = {}) {
  return {
    $id: 'u1',
    personId: 'pSam',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    currency: 'AUD',
    businessJson: null,
    invoicePrefix: 'INV-',
    lastInvoiceNumber: 0,
    summaryFrequency: 'weekly',
    nextSummaryAt: DUE,
    ...extra,
  } satisfies Partial<Profiles> & { $id: string }
}

let shareCount = 0
function share(
  groupId: string,
  date: string,
  kind: string,
  category: string | null,
  givenCents: number,
  receivedCents: number,
  personId = 'pSam',
) {
  shareCount += 1
  return {
    $id: `share${shareCount}`,
    transactionId: `t${shareCount}`,
    personId,
    groupId,
    date,
    kind,
    category,
    givenCents,
    receivedCents,
  }
}

const house = (name: string, extra = {}) => ({
  type: 'house' as const,
  name,
  settingsJson: '{"type":"house"}',
  ...extra,
})

// Sam's groups: joined (Acme, Elm St, the pair with Alex in USD, an archived one, one moved out
// of, so still in its team, and one left on their own, so out of its team), and one added to but
// never joined (Ash St). The pair's own name, "Bob", is Alex's label for Sam.
function seeded(
  options: {
    profiles?: ReturnType<typeof profile>[]
    shares?: ReturnType<typeof share>[]
    accounts?: Record<string, Partial<AccountUser>>
    now?: Date
  } = {},
) {
  return fakes(
    {
      persons: [person('pSam', 'u1'), person('pAlex', 'u2'), person('pAcme', null)],
      groups: [
        group('acme', 'pSam'),
        group('elm', 'pAlex', house('Elm St')),
        group('trip', 'pAlex', { type: 'pair', name: 'Bob', currency: 'USD' }),
        group('birch', 'pAlex', house('Birch Ln', { archivedAt: '2026-10-01T00:00:00Z' })),
        group('pine', 'pAlex', house('Pine Rd')),
        group('oak', 'pAlex', house('Oak Ave')),
        group('ash', 'pAlex', house('Ash St')),
        group('mine', 'pSam', { type: 'personal', name: 'Personal' }),
      ],
      members: [
        member('acme', 'pSam'),
        member('acme', 'pAcme', { status: 'placeholder' }),
        member('elm', 'pSam', { role: 'member' }),
        member('elm', 'pAlex'),
        member('trip', 'pSam'),
        member('trip', 'pAlex', { displayName: 'Alex' }),
        member('birch', 'pSam'),
        member('pine', 'pSam', { status: 'left', role: 'viewer', leftOn: '2026-10-01' }),
        member('oak', 'pSam', { status: 'left', role: 'viewer', leftOn: '2026-10-01' }),
        member('ash', 'pSam', { status: 'placeholder' }),
        member('mine', 'pSam'),
      ],
      profiles: options.profiles ?? [profile()],
      shares: options.shares ?? weekOfShares(),
    },
    {
      ...(options.accounts ? { accounts: options.accounts } : {}),
      ...(options.now ? { now: options.now } : {}),
      teams: { pine: ['u1'], oak: ['u2'] },
    },
  )
}

function weekOfShares() {
  return [
    // In the week of 12–18 October.
    share('elm', '2026-10-14', 'expense', 'groceries', 10_000, 5_000),
    share('acme', '2026-10-15', 'shift', 'work', 12_500, 0),
    share('acme', '2026-10-16', 'payment', null, 0, 10_000),
    share('mine', '2026-10-17', 'income', null, 30_000, 30_000),
    share('trip', '2026-10-13', 'expense', 'food', 4_000, 2_000),
    share('pine', '2026-10-12', 'bill', 'electricity', 0, 3_000),
    // Before it: in the balances only.
    share('elm', '2026-10-11', 'expense', 'groceries', 0, 1_000),
    share('birch', '2026-09-01', 'expense', 'household', 0, 1_500),
    // After it: in neither.
    share('elm', '2026-10-19', 'expense', 'groceries', 0, 100_000),
    // A group Sam left on their own doesn't count (they can't open it), one they never joined
    // doesn't, and nor does someone else's share.
    share('oak', '2026-10-14', 'expense', 'food', 0, 9_900),
    share('ash', '2026-10-14', 'expense', 'food', 0, 7_700),
    share('elm', '2026-10-14', 'expense', 'groceries', 0, 5_000, 'pAlex'),
  ]
}

function runCron(services: Fakes) {
  return ok<RunResult>(services, 'POST', '/', { userId: null, scheduled: true })
}

function storedProfile(services: Fakes): Profiles {
  return services.db.rows('profiles')[0] as unknown as Profiles
}

function sent(services: Fakes): Email[] {
  return services.sendEmail.mock.calls.map(([email]) => email)
}

describe('step 4: summary emails', () => {
  it('sends the summary of the week that just ended once, and moves on', async () => {
    const services = seeded()
    expect((await runCron(services)).summaries).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
    const [email] = sent(services)
    expect(sent(services)).toHaveLength(1)
    expect(email).toMatchObject({
      to: 'sam@example.com',
      subject: 'Your 12–18 October summary',
      idempotencyKey: 'summary-u1-2026-10-18',
    })
    const text = email?.text ?? ''
    expect(text).toContain('In AUD:\n\nYou spent $80.00.')
    expect(text).toContain('- Groceries: $50.00\n- Electricity: $30.00')
    // Acme's payment plus personal income.
    expect(text).toContain('Your income was $400.00.')
    expect(text).toContain('Owed to you:\n\n- Elm St: $40.00\n- Acme: $25.00')
    // Moved out of Pine Rd; Birch Ln is archived.
    expect(text).toContain('You owe:\n\n- Pine Rd: $30.00\n- Birch Ln: $15.00')
    expect(text).toMatch(/In USD:\n\nYou spent USD\s20\.00\.\n\n- Food: USD\s20\.00/)
    // The pair is named by its other member, as the app names it (#145).
    expect(text).toMatch(/Owed to you:\n\n- Alex: USD\s20\.00/)
    expect(text).toContain('Open Ledgerly: https://app.example.com/')
    expect(text).toContain('Change your summary emails: https://app.example.com/profile')
  })

  it('leaves out groups Sam never joined or left on their own, a pair’s label, and later shares', async () => {
    const services = seeded()
    await runCron(services)
    const text = sent(services)[0]?.text ?? ''
    expect(text).not.toMatch(/Ash St|\$77\.00|Oak Ave|\$99\.00|Bob|\$1,000\.00/)
  })

  it('reads the shares of more than 100 groups, at most 100 groups a query', async () => {
    const many = Array.from({ length: 120 }, (_, index) => `g${String(index).padStart(3, '0')}`)
    const services = fakes(
      {
        persons: [person('pSam', 'u1')],
        groups: many.map((id) => group(id, 'pSam', house(`House ${id}`))),
        members: many.map((id) => member(id, 'pSam')),
        profiles: [profile()],
        shares: many.map((id) => share(id, '2026-10-14', 'expense', 'groceries', 0, 100)),
      },
      { accounts: { u1: { email: 'sam@example.com', emailVerification: true } } },
    )
    const list = vi.spyOn(services.db, 'listRows')
    expect((await runCron(services)).summaries).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect(sent(services)[0]?.text).toContain('You spent $120.00.')
    const values = list.mock.calls
      .filter(([params]) => params.tableId === 'shares')
      .map(([params]) => JSON.parse(params.queries?.find((q) => q.includes('"groupId"')) ?? '{}'))
    // A full page of 100 shares reads one more page, so 100 shows twice.
    expect(values.map((query) => query.values.length)).toEqual([100, 100, 20])
  })

  it('moves on from a summary that can’t be shown, and counts it as failed', async () => {
    // A balance too big for formatMoney would fail on every run.
    const services = seeded({
      shares: [
        share('elm', '2026-10-14', 'expense', null, MAX_AMOUNT_CENTS, 0),
        share('elm', '2026-10-15', 'expense', null, MAX_AMOUNT_CENTS, 0),
      ],
    })
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('clears nextSummaryAt for a profile that turned summaries off, and sends nothing', async () => {
    const services = seeded({ profiles: [profile({ summaryFrequency: 'none' })] })
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(storedProfile(services).nextSummaryAt).toBeNull()
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it.each([
    ['an unverified email', { u1: { email: 'sam@example.com', emailVerification: false } }],
    ['a deleted account', {}],
    [
      'a blocked account, as one being deleted is',
      { u1: { email: 'sam@example.com', emailVerification: true, status: false } },
    ],
  ])('skips %s, and still moves on', async (_case, accounts) => {
    const services = seeded({ accounts })
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('skips a week with no shares and every balance at 0', async () => {
    const services = seeded({
      shares: [
        // Settled before the week, and only someone else's in it.
        share('elm', '2026-10-01', 'expense', 'groceries', 2_000, 1_000),
        share('elm', '2026-10-02', 'payment', null, 0, 1_000),
        share('elm', '2026-10-14', 'expense', 'groceries', 0, 5_000, 'pAlex'),
      ],
    })
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
  })

  it('skips a person in no groups', async () => {
    const services = seeded({ profiles: [profile({ personId: 'pNobody' })] })
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 1, failed: 0 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
  })

  it('sends a balance alone, with no shares in the week', async () => {
    const services = seeded({ shares: [share('birch', '2026-09-01', 'expense', null, 0, 1_500)] })
    expect((await runCron(services)).summaries.sent).toBe(1)
    const text = sent(services)[0]?.text ?? ''
    expect(text).toContain('You owe:\n\n- Birch Ln: $15.00')
    expect(text).not.toContain('You spent')
  })

  it('emails a Sydney user at 07:00 on each side of the daylight saving change', async () => {
    // 07:00 on Monday 28 September (AEST, +10); the next is 07:00 on 5 October (AEDT, +11).
    const at = '2026-09-27T21:00:00.000Z'
    const early = seeded({
      profiles: [profile({ nextSummaryAt: at })],
      now: new Date('2026-09-27T20:59:00.000Z'),
    })
    expect((await runCron(early)).summaries).toEqual({ sent: 0, skipped: 0, failed: 0 })
    const services = seeded({ profiles: [profile({ nextSummaryAt: at })], now: new Date(at) })
    expect((await runCron(services)).summaries.sent).toBe(1)
    expect(sent(services)[0]?.subject).toBe('Your 21–27 September summary')
    expect(storedProfile(services).nextSummaryAt).toBe('2026-10-04T20:00:00.000Z')
  })

  it('covers 1–31 October in a monthly summary sent on 1 November', async () => {
    const at = '2026-10-31T20:00:00.000Z'
    const services = seeded({
      profiles: [profile({ summaryFrequency: 'monthly', nextSummaryAt: at })],
      now: new Date(at),
      shares: [
        share('elm', '2026-09-30', 'expense', 'rent', 0, 10_000),
        share('elm', '2026-10-01', 'expense', 'rent', 0, 1_000),
        share('elm', '2026-10-31', 'expense', 'water', 0, 200),
        share('elm', '2026-11-01', 'expense', 'rent', 0, 50_000),
      ],
    })
    expect((await runCron(services)).summaries.sent).toBe(1)
    const [email] = sent(services)
    expect(email?.subject).toBe('Your October summary')
    expect(email?.text).toContain('You spent $12.00.\n\n- Rent: $10.00\n- Water: $2.00')
    // As of 31 October: September's share counts, November's doesn't.
    expect(email?.text).toContain('You owe:\n\n- Elm St: $112.00')
    expect(storedProfile(services).nextSummaryAt).toBe('2026-11-30T20:00:00.000Z')
  })

  it.each([
    ['its next send time', { nextSummaryAt: '2026-10-19T21:00:00.000Z' }],
    // Melbourne's 07:00 is the same instant, so identity keeps the time.
    ['its time zone', { timezone: 'Australia/Melbourne' }],
    ['its frequency', { summaryFrequency: 'fortnightly' }],
  ])('sends nothing to a profile whose %s changed after the page was read', async (_what, edit) => {
    const services = seeded()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"profiles"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({ action: 'update', tableId: 'profiles', rowId: 'u1', data: edit }),
        ),
    )
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(storedProfile(services)).toMatchObject({ nextSummaryAt: DUE, ...edit })
  })

  it('sends nothing to a profile deleted after the page was read', async () => {
    const services = seeded()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"profiles"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'profiles', rowId: 'u1' }),
        ),
    )
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing when the profile changes before the move is staged', async () => {
    const services = seeded()
    const changed = '2026-10-19T21:00:00.000Z'
    beforeStaging(
      services.db,
      (operations) => operations.includes('"nextSummaryAt"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'profiles',
            rowId: 'u1',
            data: { nextSummaryAt: changed },
          }),
        ),
    )
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(storedProfile(services).nextSummaryAt).toBe(changed)
  })

  it('counts it sent when the profile changes after the email went out', async () => {
    const services = seeded()
    const changed = '2026-10-19T21:00:00.000Z'
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'profiles',
          rowId: 'u1',
          data: { nextSummaryAt: changed },
        }),
      ),
    )
    // The commit fails, so the move is the edit's; Resend won't deliver the key twice.
    expect((await runCron(services)).summaries).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect(services.sendEmail).toHaveBeenCalledTimes(1)
    expect(storedProfile(services).nextSummaryAt).toBe(changed)
  })

  it('keeps a late fortnightly summary on its cycle', async () => {
    // Due at 07:00 on Monday 5 October, two weeks ago: it covers the fortnight before then,
    // and the next comes 4 weeks after it, not next Monday.
    const services = seeded({
      profiles: [
        profile({ summaryFrequency: 'fortnightly', nextSummaryAt: '2026-10-04T20:00:00.000Z' }),
      ],
    })
    expect((await runCron(services)).summaries.sent).toBe(1)
    expect(sent(services)[0]?.subject).toBe('Your 21 September – 4 October summary')
    expect(storedProfile(services).nextSummaryAt).toBe('2026-11-01T20:00:00.000Z')
  })

  it('counts a failed send and tries it again next run, with the same key', async () => {
    const services = seeded()
    services.sendEmail.mockRejectedValueOnce(new Error('Resend is down'))
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(storedProfile(services).nextSummaryAt).toBe(DUE)
    expect((await runCron(services)).summaries).toEqual({ sent: 1, skipped: 0, failed: 0 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
    expect(sent(services).map((email) => email.idempotencyKey)).toEqual([
      'summary-u1-2026-10-18',
      'summary-u1-2026-10-18',
    ])
  })

  it('moves on from an email Resend will never take, and counts it as failed', async () => {
    const services = seeded()
    services.sendEmail.mockRejectedValueOnce(new EmailError('Bad address', 'validation_error', 422))
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(storedProfile(services).nextSummaryAt).toBe(NEXT_WEEK)
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 0 })
  })

  it.each([
    ['moves on from one Appwrite refuses to build', 400, NEXT_WEEK],
    ['tries one again that hit a rate limit', 429, DUE],
  ])('%s, counting it as failed', async (_case, code, nextSummaryAt) => {
    const services = seeded()
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares') throw new AppwriteException('No', code, 'general_query')
      return list(params)
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(storedProfile(services).nextSummaryAt).toBe(nextSummaryAt)
    // IDs and codes only.
    expect(quiet).toHaveBeenCalledWith(
      `scheduler: summary failed for profile u1: AppwriteException ${code} general_query`,
    )
    quiet.mockRestore()
  })

  it('tries a summary again next run when it can’t be built', async () => {
    const services = seeded()
    vi.spyOn(services.users, 'get').mockRejectedValueOnce(new Error('Appwrite is down'))
    expect((await runCron(services)).summaries).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(storedProfile(services).nextSummaryAt).toBe(DUE)
    expect((await runCron(services)).summaries.sent).toBe(1)
  })

  it('logs counts only', async () => {
    const services = seeded()
    const { body, logs } = await call(services, 'POST', '/', { userId: null, scheduled: true })
    expect(body).toMatchObject({ ok: true, data: { summaries: { sent: 1 } } })
    expect(logs.join('\n')).not.toMatch(/sam@example\.com|Elm St|Acme/)
  })
})
