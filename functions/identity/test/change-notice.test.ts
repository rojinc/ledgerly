import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUser } from '../src/services'
import {
  AFTER,
  account,
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  fakes,
  NOW,
  updateRow,
} from './harness'

const SAM = {
  $id: 'p1',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: '2026-10-01T00:00:00.000Z',
  mergedInto: null,
  deletedAt: null,
}
// After an email change, Appwrite holds the new address, unverified, as it was typed.
const CHANGED_EMAIL: Partial<AccountUser> = {
  email: 'Jo.New@Example.com',
  emailVerification: false,
}

type Row = Record<string, unknown> & { $id: string }

function identity(id: string, key: string, extra: object = {}): Row {
  const type = key.split(':')[0]
  return { $id: id, key, type, personId: 'p1', verified: true, verifiedAt: null, ...extra }
}

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000+00:00`

function seeded(
  identities: Row[],
  overrides: Partial<AccountUser> = CHANGED_EMAIL,
  persons: Row[] = [SAM],
): Fakes {
  return fakes({ persons, identities }, { account: account(overrides) })
}

// What Appwrite sends: the user, password hash included, so it must never reach a log. Its
// email and phone are not the ones users.get returns, so a test sees which were used. Every
// key below is for the harness account's `$updatedAt`, 2026-10-18T19:58:00.000+00:00.
const userBody = (id = 'u1') => ({
  $id: id,
  name: 'Sam Lee',
  email: 'attacker@evil.example',
  phone: '+15550001234',
  password: 'argon2-SECRET',
})

// Every log line of every run, and every console line with the method that wrote it, checked in
// afterEach.
let logged: string[] = []
let written: Array<{ level: string; line: string }> = []

function fire(
  services: Fakes,
  notice: 'email' | 'phone',
  body: unknown = userBody(),
  name = `users.u1.update.${notice}`,
) {
  return call(services, 'POST', '/', body, null, {
    'x-appwrite-trigger': 'event',
    'x-appwrite-event': name,
  }).then((result) => {
    logged.push(...result.logs)
    return result
  })
}

function sent(services: Fakes): Email[] {
  return vi.mocked(services.sendEmail).mock.calls.map(([email]) => email)
}

// The logProblem lines written, parsed, without `fn`.
function lines(): Array<Record<string, unknown>> {
  return written.map(({ line }) => {
    const { fn: _fn, ...fields } = JSON.parse(line) as Record<string, unknown>
    return fields
  })
}

const levels = () => written.map(({ level }) => level)

// A change notice's line for u1, as lines() gives it.
const logLine = (identityType: 'email' | 'phone', outcome: string, more: object = {}) => ({
  event: 'change_notice',
  userId: 'u1',
  identityType,
  outcome,
  ...more,
})
// The emails a run kept no row for: past the cap of 3, or with no identity to name (#462).
const dropped = (count: number, identityType: 'email' | 'phone' = 'email') =>
  logLine(identityType, 'dropped', { count })
// The harness account's verified email, as its identity on SAM.
const SAM_EMAIL = identity('iSam', 'email:sam@example.com', {
  verifiedAt: '2026-10-01T00:00:00.000Z',
})

beforeEach(() => {
  logged = []
  written = []
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      written.push({ level, line: args.map(String).join(' ') })
    })
  }
})

afterEach(() => {
  // No address, number, key, name or body in any log line (identity-and-invites.md step 7).
  const all = [...logged, ...written.map(({ line }) => line)]
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const line of all) {
    expect(line).not.toMatch(/@|example|Sam|Jo\.|SECRET|\+61|\+1555|412345|[0-9a-f]{64}/i)
  }
})

describe('POST / (the users.*.update.email and users.*.update.phone events)', () => {
  const passwordNotice = { event: 'password_notice' }
  const emailNotice = { event: 'change_notice', identityType: 'email' }
  const phoneNotice = { event: 'change_notice', identityType: 'phone' }
  it.each([
    ['users.u1.update.password', 'u1', 'u1', passwordNotice],
    // A recovery event's body is the spent token: the user still comes from the name.
    ['users.u1.recovery.token1.update', 'u1', 'token1', passwordNotice],
    ['users.u1.update.email', 'u1', 'u1', emailNotice],
    ['users.u1.update.phone', 'u1', 'u1', phoneNotice],
    ['users.u1.x.update.email', 'u1.x', 'u1.x', emailNotice],
    ['users.u1.x.update.phone', 'u1.x', 'u1.x', phoneNotice],
    ['users.u1.x.recovery.token1.update', 'u1.x', 'token1', passwordNotice],
    ['users.u1.update.phone.update.email', 'u1.update.phone', 'u1.update.phone', emailNotice],
  ])('reads %s as its event, for user %s', async (name, userId, bodyId, event) => {
    const services = seeded([], { email: 'sam@example.com', emailVerification: false })
    const get = vi.spyOn(services.users, 'get')
    expect((await fire(services, 'email', { $id: bodyId }, name)).body).toEqual({
      ok: true,
      data: {},
    })
    expect(get.mock.calls).toEqual([[{ userId }]])
    expect(lines()).toEqual([{ ...event, userId, outcome: expect.any(String) }])
  })

  it.each([
    'users.*.update.email',
    'users.u1.update.Email',
    'users.u1.update.emails',
    'users.u1.update.email.x',
    'users..update.phone',
    'users.update.phone',
    'users.u1.update',
    'users.u1.update.prefs',
    'users.u1.sessions.s1.create',
  ])('refuses an event run named %j', async (name) => {
    const services = seeded([identity('iOld', 'email:sam@example.com')])
    const get = vi.spyOn(services.users, 'get')
    const result = await fire(services, 'email', userBody(), name)
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(get).not.toHaveBeenCalled()
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it.each([
    ['another user’s ID', userBody('u2')],
    ['no $id', { email: 'sam@example.com' }],
    ['a number for $id', { $id: 1 }],
    ['no body', undefined],
    ['a body that isn’t an object', 'u1'],
  ])('sends nothing for a body with %s, warning of a mismatch', async (_, body) => {
    for (const notice of ['email', 'phone'] as const) {
      const services = seeded([identity('iOld', 'email:sam@example.com')], {})
      const get = vi.spyOn(services.users, 'get')
      // Not fire(), whose default body would stand in for a missing one.
      const result = await call(services, 'POST', '/', body, null, {
        'x-appwrite-trigger': 'event',
        'x-appwrite-event': `users.u1.update.${notice}`,
      })
      logged.push(...result.logs)
      expect(result.body).toEqual({ ok: true, data: {} })
      expect(get).not.toHaveBeenCalled()
      expect(services.sendEmail).not.toHaveBeenCalled()
    }
    expect(lines()).toEqual([logLine('email', 'mismatch'), logLine('phone', 'mismatch')])
    expect(levels()).toEqual(['warn', 'warn'])
  })

  it('refuses a person, even with a forged event trigger and name', async () => {
    const services = seeded([identity('iOld', 'email:sam@example.com')])
    for (const notice of ['email', 'phone']) {
      const result = await call(services, 'POST', '/', userBody(), 'u1', {
        'x-appwrite-trigger': 'event',
        'x-appwrite-event': `users.u1.update.${notice}`,
      })
      expect(result.status).toBe(403)
      expect(result.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing for a user who is gone, or whose person is being deleted', async () => {
    const old = [identity('iOld', 'email:sam@example.com')]
    const missing = seeded(old, {})
    missing.users = {
      get: async () => {
        throw new AppwriteException('User not found', 404, 'user_not_found')
      },
    }
    const deleting = seeded(old, {}, [{ ...SAM, deletedAt: '2026-10-18T19:00:00.000Z' }])
    for (const services of [missing, deleting]) {
      expect((await fire(services, 'email')).body).toEqual({ ok: true, data: {} })
      expect((await fire(services, 'phone')).body).toEqual({ ok: true, data: {} })
      expect(services.sendEmail).not.toHaveBeenCalled()
    }
    const gone = [logLine('email', 'gone'), logLine('phone', 'gone')]
    expect(lines()).toEqual([...gone, ...gone])
    expect(levels()).toEqual(Array(4).fill('log'))
  })

  it.each([
    ['email', CHANGED_EMAIL],
    ['phone', {}],
  ] as const)('fails the %s notice without APP_URL, sending nothing', async (notice, overrides) => {
    const services = seeded([identity('iOld', 'email:sam.old@example.com')], overrides)
    services.appUrl = ''
    expect((await fire(services, notice)).status).toBe(500)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })
})

describe('an email change', () => {
  it('notifies every old verified address, newest first, each under its own key', async () => {
    const services = seeded([
      identity('iA', 'email:a@example.com', { verifiedAt: at(5) }),
      identity('iB', 'email:b@example.com', { verifiedAt: at(10) }),
      identity('iC', 'email:c@example.com'),
      // The same verifiedAt as iA, and none as iC: by $id.
      identity('iD', 'email:d@example.com', { verifiedAt: at(5) }),
      identity('iE', 'email:e@example.com'),
      // The current email's own key, if it was verified before (A → B → A): left out.
      identity('iNew', 'email:jo.new@example.com', { verifiedAt: at(15) }),
      // Not verified, a phone, and another person's: never notified.
      identity('iU', 'email:u@example.com', { verified: false, verifiedAt: at(12) }),
      identity('iP', 'phone:+61412345678', { verifiedAt: at(12) }),
      identity('iX', 'email:x@example.com', { personId: 'p2', verifiedAt: at(12) }),
    ])
    const identitiesBefore = structuredClone(services.db.rows('identities'))
    const personsBefore = structuredClone(services.db.rows('persons'))
    expect((await fire(services, 'email')).body).toEqual({ ok: true, data: {} })
    const emails = sent(services)
    expect(emails.map((email) => email.to)).toEqual([
      'b@example.com',
      'a@example.com',
      'd@example.com',
      'c@example.com',
      'e@example.com',
    ])
    expect(new Set(emails.map((email) => email.idempotencyKey)).size).toBe(5)
    for (const email of emails) {
      expect(email).toMatchObject({
        subject: 'Your Ledgerly email address was changed',
        idempotencyKey: expect.stringMatching(/^email-change-notice-[0-9a-f]{64}$/),
      })
      // From users.get, as Appwrite holds it, never from the event's body.
      expect(email.text).toContain('was changed to J***@Example.com.')
      expect(email.text).toContain("If this wasn't you, reply to this email right away.")
      expect(email.text).toContain('Go to Ledgerly: https://app.example/login')
      expect(email.text).not.toContain('evil')
    }
    // Only the first 3 got a row (#462).
    expect(lines()).toEqual([dropped(2), ...Array(5).fill(logLine('email', 'sent'))])
    expect(levels()).toEqual(['warn', ...Array(5).fill('log')])
    // Nothing about the change itself is stored, only the cap's guard on the person (a fresh
    // `rev`), and each pending send's row went once it was sent.
    const unguarded = services.db
      .rows('persons')
      .map(({ rev: _rev, $updatedAt: _at, ...row }) => row)
    expect(services.db.rows('identities')).toEqual(identitiesBefore)
    expect(unguarded).toEqual(personsBefore.map(({ $updatedAt: _at, ...row }) => row))
    expect(services.db.rows('changeNotices')).toEqual([])
  })

  it('tells the reader to write to SUPPORT_EMAIL when it is set', async () => {
    const services = seeded([identity('iOld', 'email:sam@example.com')])
    services.supportEmail = 'help@ledgerly.example'
    await fire(services, 'email')
    expect(sent(services)[0]?.text).toContain(
      "If this wasn't you, write to help@ledgerly.example from this address right away.",
    )
  })

  it.each([
    ['no person', []],
    ['no old verified email', [SAM]],
  ])('sends nothing with %s (no_old_address)', async (_, persons) => {
    const services = seeded(
      [
        identity('iNew', 'email:jo.new@example.com', { verifiedAt: at(1) }),
        identity('iU', 'email:u@example.com', { verified: false }),
        identity('iP', 'phone:+61412345678'),
      ],
      CHANGED_EMAIL,
      persons,
    )
    expect((await fire(services, 'email')).body).toEqual({ ok: true, data: {} })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(lines()).toEqual([logLine('email', 'no_old_address')])
    expect(levels()).toEqual(['log'])
  })

  it.each([
    ['empty', '', '***'],
    ['unusable', 'not an address', '***'],
  ])('leaves no key out when the current email is %s', async (_, email, masked) => {
    const services = seeded(
      [
        identity('iA', 'email:a@example.com', { verifiedAt: at(2) }),
        identity('iB', 'email:b@example.com', { verifiedAt: at(1) }),
      ],
      { email, emailVerification: false },
    )
    await fire(services, 'email')
    expect(sent(services).map((sentEmail) => sentEmail.to)).toEqual([
      'a@example.com',
      'b@example.com',
    ])
    expect(sent(services)[0]?.text).toContain(`was changed to ${masked}.`)
  })

  it('keys each address by the user, its key and $updatedAt, so a new change is a new key', async () => {
    const services = seeded([identity('iOld', 'email:sam.old@example.com')])
    await fire(services, 'email')
    await fire(services, 'email')
    services.users = {
      get: async () => account({ ...CHANGED_EMAIL, $updatedAt: '2026-10-18T19:59:00.000+00:00' }),
    }
    await fire(services, 'email')
    const keys = sent(services).map((email) => email.idempotencyKey)
    // SHA-256 of "u1:email:sam.old@example.com:2026-10-18T19:58:00.000+00:00".
    expect(keys[0]).toBe(
      'email-change-notice-9bff8921d1bedb6b63f7454913dde5cb3bd109a6419eaa6a977377da6a71fc6c',
    )
    // A replay reuses it, and Resend drops the copy; a new change doesn't.
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).toMatch(/^email-change-notice-[0-9a-f]{64}$/)
    expect(keys[2]).not.toBe(keys[0])
  })
})

describe('a phone change', () => {
  const phoned = (overrides: Partial<AccountUser> = {}, persons: Row[] = [SAM]) =>
    seeded([SAM_EMAIL], { phone: '+61412345678', ...overrides }, persons)

  it('notifies the verified email, naming only the last 3 digits, even with no person', async () => {
    for (const services of [phoned(), phoned({}, [])]) {
      expect((await fire(services, 'phone')).body).toEqual({ ok: true, data: {} })
      expect(sent(services)).toEqual([
        expect.objectContaining({
          to: 'sam@example.com',
          subject: 'Your Ledgerly phone number was changed',
          // SHA-256 of "u1:2026-10-18T19:58:00.000+00:00": no number in it.
          idempotencyKey:
            'phone-change-notice-731e5170781116525c5bbfd7f254de36a780b4b405ef8f5fc162b4895ff4e89f',
        }),
      ])
      const [email] = sent(services)
      expect(email?.text).toContain('was changed to one ending in 678.')
      expect(`${email?.subject} ${email?.html} ${email?.text}`).not.toMatch(/412345|1555|1234/)
    }
    // With no person, its row has no identity to name: sent now, never retried (#462).
    expect(lines()).toEqual([
      logLine('phone', 'sent'),
      dropped(1, 'phone'),
      logLine('phone', 'sent'),
    ])
  })

  it('says the phone was removed when the account has none now', async () => {
    const services = phoned({ phone: '' })
    await fire(services, 'phone')
    expect(sent(services)[0]?.text).toContain(
      'The phone number was removed from your Ledgerly account.',
    )
  })

  it('gets a new key for a new change', async () => {
    const services = phoned()
    await fire(services, 'phone')
    services.users = {
      get: async () => account({ phone: '+61412345679', $updatedAt: '2026-10-18T19:59:30.000Z' }),
    }
    await fire(services, 'phone')
    const [first, second] = sent(services).map((email) => email.idempotencyKey)
    expect(second).toMatch(/^phone-change-notice-[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
  })

  it.each([
    ['an unverified email', { emailVerification: false }],
    ['no email', { email: '', emailVerification: true }],
  ])('sends nothing with %s (unverified)', async (_, overrides) => {
    const services = phoned(overrides)
    expect((await fire(services, 'phone')).body).toEqual({ ok: true, data: {} })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(lines()).toEqual([logLine('phone', 'unverified')])
    expect(levels()).toEqual(['log'])
  })
})

describe('sending (step 6)', () => {
  const T0 = NOW.getTime()
  const old = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      identity(`i${String(index).padStart(2, '0')}`, `email:old${index}@example.com`),
    )

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    vi.setSystemTime(NOW)
  })

  // A run under fake timers: the sends' waits pass at once.
  async function run(services: Fakes) {
    const pending = fire(services, 'email')
    await vi.runAllTimersAsync()
    return pending
  }

  // Each send's start (ms into the run), address and timeout; `answer` runs it.
  function clocked(
    services: Fakes,
    answer: (attempt: number, timeoutMs: number) => Promise<unknown> = async () => undefined,
  ) {
    const attempts: Array<{ at: number; to: string; key: string; timeoutMs: number }> = []
    services.sendEmail = vi.fn(async (email: Email, options?: { timeoutMs?: number }) => {
      const timeoutMs = options?.timeoutMs ?? Number.NaN
      attempts.push({
        at: Date.now() - T0,
        to: String(email.to),
        key: email.idempotencyKey ?? '',
        timeoutMs,
      })
      await answer(attempts.length - 1, timeoutMs)
      return { id: 'email-1' }
    })
    return attempts
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const failure = (type: string, status: number, retryAfterMs?: number) =>
    new EmailError(`Resend answered ${status} ${type}`, type, status, retryAfterMs)
  const sentLine = logLine('email', 'sent')
  // A send that failed, naming the error (describe()), or the addresses left at 12 s.
  const failed = (cause: string) => logLine('email', 'failed', { cause })
  const budget = (count: number) => logLine('email', 'failed', { cause: 'budget', count })

  it('sends one after another, 500 ms apart', async () => {
    const services = seeded(old(3))
    const attempts = clocked(services)
    expect((await run(services)).body).toEqual({ ok: true, data: {} })
    expect(attempts.map(({ at }) => at)).toEqual([0, 500, 1000])
    // Each send's own timeout is what's left of 14 s (sendEmail cuts it to 10 s).
    expect(attempts.map(({ timeoutMs }) => timeoutMs)).toEqual([14_000, 13_500, 13_000])
  })

  it('waits only what a slow send leaves of the 500 ms', async () => {
    const services = seeded(old(3))
    const attempts = clocked(services, (attempt) => sleep(attempt === 0 ? 300 : 800))
    await run(services)
    expect(attempts.map(({ at }) => at)).toEqual([0, 500, 1300])
  })

  it('counts a key Resend has seen as sent', async () => {
    const services = seeded(old(3))
    clocked(services, async (attempt) => {
      if (attempt === 0) throw failure('invalid_idempotent_request', 409)
      if (attempt === 1) throw failure('concurrent_idempotent_requests', 409)
    })
    expect((await run(services)).body).toEqual({ ok: true, data: {} })
    expect(lines()).toEqual(Array(3).fill(logLine('email', 'sent')))
  })

  it('tries a rate-limited send once more, with the same key, after Resend’s retry-after', async () => {
    const services = seeded(old(3))
    const attempts = clocked(services, async (attempt) => {
      if (attempt === 0) throw failure('rate_limit_exceeded', 429, 2_000)
      // The second address is limited twice: it isn't tried a third time.
      if (attempt === 2 || attempt === 3) throw failure('rate_limit_exceeded', 429)
    })
    expect((await run(services)).status).toBe(500)
    expect(attempts.map(({ at, to }) => [at, to])).toEqual([
      [0, 'old0@example.com'],
      [2_000, 'old0@example.com'],
      [2_500, 'old1@example.com'],
      // No retry-after: a second, Resend's window.
      [3_500, 'old1@example.com'],
      [4_000, 'old2@example.com'],
    ])
    expect(attempts[1]?.key).toBe(attempts[0]?.key)
    expect(attempts[3]?.key).toBe(attempts[2]?.key)
    expect(lines()).toEqual([sentLine, failed('EmailError rate_limit_exceeded 429'), sentLine])
    expect(levels()).toEqual(['log', 'error', 'log'])
  })

  it('doesn’t retry when Resend’s wait ends after 12 s, and goes on to the next address', async () => {
    const services = seeded(old(2))
    const attempts = clocked(services, async (attempt) => {
      if (attempt === 0) throw failure('rate_limit_exceeded', 429, 60_000)
    })
    expect((await run(services)).status).toBe(500)
    expect(attempts.map(({ at, to }) => [at, to])).toEqual([
      [0, 'old0@example.com'],
      [500, 'old1@example.com'],
    ])
    expect(lines()).toEqual([failed('EmailError rate_limit_exceeded 429'), sentLine])
  })

  it('retries when Resend’s wait ends at 12 s exactly', async () => {
    const services = seeded(old(1))
    const attempts = clocked(services, async (attempt) => {
      if (attempt === 0) throw failure('rate_limit_exceeded', 429, 12_000)
    })
    expect((await run(services)).body).toEqual({ ok: true, data: {} })
    expect(attempts.map(({ at, timeoutMs }) => [at, timeoutMs])).toEqual([
      [0, 14_000],
      [12_000, 2_000],
    ])
  })

  it('doesn’t retry a 429 that comes back after 12 s', async () => {
    const services = seeded(old(1))
    const attempts = clocked(services, async () => {
      await sleep(12_500)
      throw failure('rate_limit_exceeded', 429, 1_000)
    })
    expect((await run(services)).status).toBe(500)
    expect(attempts).toHaveLength(1)
    expect(lines()).toEqual([failed('EmailError rate_limit_exceeded 429')])
  })

  it('tries every address after a failed one, then fails the run', async () => {
    const services = seeded(old(4))
    const attempts = clocked(services, async (attempt) => {
      if (attempt === 1) throw failure('validation_error', 422)
      if (attempt === 2) throw new TypeError('boom')
    })
    const result = await run(services)
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(attempts.map(({ to }) => to)).toEqual([
      'old0@example.com',
      'old1@example.com',
      'old2@example.com',
      'old3@example.com',
    ])
    expect(lines()).toEqual([
      dropped(1),
      sentLine,
      failed('EmailError validation_error 422'),
      // Not an EmailError: only its class is named, never the message.
      failed('TypeError'),
      sentLine,
    ])
    expect(levels()).toEqual(['warn', 'log', 'error', 'error', 'log'])
  })

  it('starts no send after 12 s, and logs how many were left', async () => {
    const services = seeded(old(30))
    const attempts = clocked(services)
    expect((await run(services)).status).toBe(500)
    // Every 500 ms from 0 to 12 s.
    expect(attempts).toHaveLength(25)
    expect(attempts.at(-1)?.at).toBe(12_000)
    expect(lines()).toEqual([dropped(27), ...Array(25).fill(sentLine), budget(5)])
    expect(levels().at(-1)).toBe('error')
  })

  it('counts the reads before the first send against the 12 s and 14 s', async () => {
    const services = seeded(old(2))
    const get = services.users.get.bind(services.users)
    services.users.get = async (params) => {
      await sleep(11_800)
      return get(params)
    }
    const attempts = clocked(services)
    expect((await run(services)).status).toBe(500)
    expect(attempts.map(({ at, timeoutMs }) => [at, timeoutMs])).toEqual([[11_800, 2_200]])
    expect(lines()).toEqual([sentLine, budget(1)])
    expect(levels()).toEqual(['log', 'error'])
  })

  it('cuts each send’s timeout to what’s left of 14 s, so a slow Resend ends the run in time', async () => {
    const services = seeded(old(4))
    // Each send takes 5 s, or times out first, as sendEmail does.
    const attempts = clocked(services, async (_, timeoutMs) => {
      if (timeoutMs >= 5_000) return sleep(5_000)
      await sleep(timeoutMs)
      throw new EmailError('Resend could not be reached: timeout', 'timeout')
    })
    expect((await run(services)).status).toBe(500)
    expect(attempts.map(({ at, timeoutMs }) => [at, timeoutMs])).toEqual([
      [0, 14_000],
      [5_000, 9_000],
      [10_000, 4_000],
    ])
    expect(Date.now() - T0).toBe(14_000)
    expect(lines()).toEqual([
      dropped(1),
      sentLine,
      sentLine,
      failed('EmailError timeout'),
      budget(1),
    ])
  })
})

describe('keeping a notice that didn’t go out, and trying it again hourly (#345)', () => {
  const T0 = NOW.getTime()
  const HOUR = 60 * 60 * 1000
  const A = identity('iA', 'email:a@example.com', { verifiedAt: at(5) })
  const B = identity('iB', 'email:b@example.com', { verifiedAt: at(4) })
  const C = identity('iC', 'email:c@example.com', { verifiedAt: at(3) })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    vi.setSystemTime(NOW)
  })

  async function settled<T>(pending: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync()
    return pending
  }
  const event = (services: Fakes, notice: 'email' | 'phone' = 'email') =>
    settled(fire(services, notice))

  // identity's hourly run, `after` ms after NOW, on its clock and the services'.
  async function hourly(services: Fakes, after = HOUR) {
    vi.setSystemTime(T0 + after)
    services.now = new Date(T0 + after)
    const result = await settled(
      call(services, 'POST', '/', undefined, null, { 'x-appwrite-trigger': 'schedule' }),
    )
    logged.push(...result.logs)
    return result
  }
  const counted = (result: { body: unknown }) =>
    (result.body as { data: { notices: unknown } }).data.notices

  // Each send's address, key, start (ms after NOW) and timeout, answered by `answer` (by call).
  function answered(services: Fakes, answer: (call: number) => unknown = () => undefined) {
    const calls: Array<{ to: string; key: string; at: number; timeoutMs: number }> = []
    services.sendEmail = vi.fn(async (email: Email, options?: { timeoutMs?: number }) => {
      calls.push({
        to: String(email.to),
        key: email.idempotencyKey ?? '',
        at: Date.now() - T0,
        timeoutMs: options?.timeoutMs ?? Number.NaN,
      })
      const error = answer(calls.length - 1)
      if (error) throw error
      return { id: `email-${calls.length}` }
    })
    return calls
  }
  const failure = (type: string, status?: number) =>
    new EmailError(`Resend answered ${status} ${type}`, type, status)
  const rows = (services: Fakes) => services.db.rows('changeNotices')
  const noticeLines = () => lines().filter((line) => line.event === 'change_notice')
  const retryLine = (identityType: 'email' | 'phone', outcome: string, attempts: number) =>
    logLine(identityType, outcome, { counts: { attempts } })

  // A row the event run left, as Appwrite stores it.
  const pending = (id: string, extra: object = {}) => ({
    $id: id,
    $createdAt: NOW.toISOString(),
    userId: 'u1',
    kind: 'email',
    identityId: 'iA',
    idempotencyKey: `email-change-notice-key-${id}`,
    attempts: 0,
    ...extra,
  })
  const withRows = (notices: Row[], identities: Row[] = [A, B, C], overrides = CHANGED_EMAIL) =>
    fakes({ persons: [SAM], identities, changeNotices: notices }, { account: account(overrides) })

  describe('the event run (step 6)', () => {
    it('keeps a notice whose two tries got a 429, and the hourly run sends it with the same key', async () => {
      const services = seeded([A])
      const calls = answered(services, (call) =>
        call < 2 ? failure('rate_limit_exceeded', 429) : undefined,
      )
      expect((await event(services)).status).toBe(500)
      const key = calls[0]?.key
      // The user, the notice, the old address's row and the key: no address, number or text.
      expect(rows(services)).toEqual([
        expect.objectContaining({
          userId: 'u1',
          kind: 'email',
          identityId: 'iA',
          idempotencyKey: key,
          attempts: 0,
        }),
      ])
      const columns = Object.keys(rows(services)[0] ?? {}).filter((name) => !name.startsWith('$'))
      expect(columns.sort()).toEqual(['attempts', 'idempotencyKey', 'identityId', 'kind', 'userId'])
      const result = await hourly(services)
      expect(counted(result)).toEqual({ retried: 1, failed: 0, expired: 0, gone: 0 })
      expect(calls.map(({ to, key }) => [to, key])).toEqual([
        ['a@example.com', key],
        ['a@example.com', key],
        ['a@example.com', key],
      ])
      expect(rows(services)).toEqual([])
      expect(noticeLines().at(-1)).toEqual(retryLine('email', 'retried', 0))
    })

    it('keeps a timed-out send, and counts the retry’s seen key as sent, so nothing goes twice', async () => {
      const services = seeded([A])
      const calls = answered(services, (call) =>
        call === 0 ? failure('timeout') : failure('invalid_idempotent_request', 409),
      )
      await event(services)
      expect(rows(services)).toHaveLength(1)
      expect(counted(await hourly(services))).toEqual({
        retried: 1,
        failed: 0,
        expired: 0,
        gone: 0,
      })
      expect(calls.map(({ key }) => key)).toEqual([calls[0]?.key, calls[0]?.key])
      expect(rows(services)).toEqual([])
    })

    it('keeps a row for each address the 12 s left unsent', async () => {
      const services = seeded([A, B, C])
      const get = services.users.get.bind(services.users)
      services.users.get = async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 11_800))
        return get(params)
      }
      answered(services)
      expect((await event(services)).status).toBe(500)
      // A went at 11.8 s; B and C were left.
      expect(rows(services).map((row) => row.identityId)).toEqual(['iB', 'iC'])
    })

    // #462: at most 3 rows per user, so one account holds back anyone else's retries by 3 sends
    // at most.
    it('keeps rows for the first 3 addresses it sends to, and logs the rest as dropped', async () => {
      const D = identity('iD', 'email:d@example.com', { verifiedAt: at(2) })
      const E = identity('iE', 'email:e@example.com', { verifiedAt: at(1) })
      const services = seeded([A, B, C, D, E])
      const calls = answered(services, () => failure('timeout'))
      expect((await event(services)).status).toBe(500)
      // Every address is still tried.
      expect(calls.map(({ to }) => to)).toEqual([
        'a@example.com',
        'b@example.com',
        'c@example.com',
        'd@example.com',
        'e@example.com',
      ])
      expect(rows(services).map((row) => row.identityId)).toEqual(['iA', 'iB', 'iC'])
      expect(noticeLines()[0]).toEqual(dropped(2))
      expect(levels()[0]).toBe('warn')
    })

    it('counts the rows already there towards the cap', async () => {
      const services = fakes(
        {
          persons: [SAM],
          identities: [A, B],
          changeNotices: [pending('n1'), pending('n2', { identityId: 'iB' })],
        },
        { account: account(CHANGED_EMAIL) },
      )
      answered(services, () => failure('timeout'))
      await event(services)
      expect(rows(services)).toHaveLength(3)
      expect(rows(services)[2]).toMatchObject({ identityId: 'iA', userId: 'u1' })
      expect(noticeLines()[0]).toEqual(dropped(1))
    })

    it('counts only the user’s own rows towards the cap', async () => {
      const others = ['o1', 'o2', 'o3'].map((id) => pending(id, { userId: 'u2' }))
      const services = fakes(
        { persons: [SAM], identities: [A, B], changeNotices: others },
        { account: account(CHANGED_EMAIL) },
      )
      answered(services, () => failure('timeout'))
      await event(services)
      expect(rows(services).filter((row) => row.userId === 'u1')).toHaveLength(2)
      expect(noticeLines().filter((line) => line.outcome === 'dropped')).toEqual([])
    })

    it('counts a replayed event’s row once, at the cap', async () => {
      const services = fakes(
        { persons: [SAM], identities: [A], changeNotices: [pending('n1'), pending('n2')] },
        { account: account(CHANGED_EMAIL) },
      )
      answered(services, () => failure('timeout'))
      await event(services)
      expect(rows(services)).toHaveLength(3)
      await event(services)
      expect(rows(services)).toHaveLength(3)
      expect(noticeLines().filter((line) => line.outcome === 'dropped')).toEqual([])
    })

    it('leaves room for a replayed event’s other address, counting its kept row once', async () => {
      const services = fakes(
        { persons: [SAM], identities: [A, B], changeNotices: [pending('n1')] },
        { account: account(CHANGED_EMAIL) },
      )
      // A fails and keeps its row; B is sent and its row goes. The replay fails both.
      answered(services, (call) => (call === 1 ? undefined : failure('timeout')))
      await event(services)
      expect(rows(services)).toHaveLength(2)
      await event(services)
      expect(rows(services).map((row) => row.identityId)).toEqual(['iA', 'iA', 'iB'])
      expect(noticeLines().filter((line) => line.outcome === 'dropped')).toEqual([])
    })

    it('holds the cap when another run for the user writes its rows at the same time', async () => {
      const services = seeded([A, B])
      answered(services, () => failure('timeout'))
      // Another event run's guard and rows commit after this run staged its guard, so this
      // commit fails, and the run lists the rows again.
      beforeCommit(services.db, () =>
        withTransaction(services.db, (tx) =>
          tx.write(
            { action: 'update', tableId: 'persons', rowId: 'p1', data: { rev: 'other' } },
            ...['n1', 'n2'].map((id) => ({
              action: 'create' as const,
              tableId: 'changeNotices' as const,
              rowId: id,
              data: {
                userId: 'u1',
                kind: 'email',
                identityId: 'iA',
                idempotencyKey: `email-change-notice-key-${id}`,
                attempts: 0,
              },
            })),
          ),
        ),
      )
      await event(services)
      expect(
        rows(services)
          .map((row) => row.$id)
          .filter((id) => id === 'n1' || id === 'n2'),
      ).toEqual(['n1', 'n2'])
      expect(rows(services)).toHaveLength(3)
      expect(noticeLines()[0]).toEqual(dropped(1))
    })

    it('sends anyway, keeping nothing, when the rows clash twice', async () => {
      const services = seeded([A])
      answered(services)
      const commit = services.db.updateTransaction.bind(services.db)
      let clashes = 0
      let busy = false
      vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
        // Another write to the person lands before each of the rows' two tries commits.
        if (params.commit && !busy && clashes < 2) {
          clashes += 1
          busy = true
          await updateRow(services.db, 'persons', 'p1', { displayName: `Renamed ${clashes}` })
          busy = false
        }
        return commit(params)
      })
      expect((await event(services)).body).toEqual({ ok: true, data: {} })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([
        logLine('email', 'failed', { cause: 'queue' }),
        logLine('email', 'sent'),
      ])
    })

    it('deletes the row of an email Resend refused, and keeps one that failed otherwise', async () => {
      const services = seeded([A, B])
      answered(services, (call) =>
        call === 0 ? failure('validation_error', 422) : new TypeError(),
      )
      expect((await event(services)).status).toBe(500)
      expect(rows(services)).toEqual([expect.objectContaining({ identityId: 'iB' })])
    })

    it('lists the rows after its guard, so a run that commits in between makes it list again', async () => {
      const services = seeded([A, B])
      answered(services, () => failure('timeout'))
      const list = services.db.listRows.bind(services.db)
      let done = false
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        const listed = await list(params)
        // Another event run's guard and rows commit just after this run's first listing.
        if (!done && params.tableId === 'changeNotices' && !params.transactionId) {
          done = true
          await withTransaction(services.db, (tx) =>
            tx.write(
              { action: 'update', tableId: 'persons', rowId: 'p1', data: { rev: 'other' } },
              ...['n1', 'n2'].map((id) => ({
                action: 'create' as const,
                tableId: 'changeNotices' as const,
                rowId: id,
                data: {
                  userId: 'u1',
                  kind: 'email',
                  identityId: 'iA',
                  idempotencyKey: `email-change-notice-key-${id}`,
                  attempts: 0,
                },
              })),
            ),
          )
        }
        return listed as never
      })
      await event(services)
      expect(rows(services)).toHaveLength(3)
      expect(noticeLines()[0]).toEqual(dropped(1))
    })

    it('writes nothing, not even its guard, when every key already has its row', async () => {
      const services = seeded([A])
      answered(services, () => failure('timeout'))
      await event(services)
      const [person] = structuredClone(services.db.rows('persons'))
      await event(services)
      expect(services.db.rows('persons')).toEqual([person])
      expect(rows(services)).toHaveLength(1)
    })

    it('sends anyway when the person’s deletion passes its point of no return meanwhile', async () => {
      const services = seeded([A])
      answered(services)
      beforeStaging(
        services.db,
        (operations) => operations.includes('"persons"'),
        () => updateRow(services.db, 'persons', 'p1', { deletedAt: AFTER }),
      )
      expect((await event(services)).body).toEqual({ ok: true, data: {} })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([
        logLine('email', 'failed', { cause: 'queue' }),
        logLine('email', 'sent'),
      ])
    })

    it('keeps a phone notice’s row, naming the verified email’s identity (#462)', async () => {
      const services = seeded([SAM_EMAIL], { phone: '+61412345678' })
      answered(services, () => failure('timeout'))
      expect((await event(services, 'phone')).status).toBe(500)
      expect(rows(services)).toEqual([
        expect.objectContaining({ kind: 'phone', identityId: 'iSam', attempts: 0 }),
      ])
    })

    it('finds the identity of an account email typed in capitals', async () => {
      const services = seeded([SAM_EMAIL], { email: 'Sam@Example.com', phone: '+61412345678' })
      answered(services, () => failure('timeout'))
      await event(services, 'phone')
      expect(rows(services)).toEqual([expect.objectContaining({ identityId: 'iSam' })])
    })

    it('sends a phone notice whose account email identityKey() refuses, keeping no row', async () => {
      const services = seeded([SAM_EMAIL], { email: 'not an address', phone: '+61412345678' })
      answered(services)
      expect((await event(services, 'phone')).body).toEqual({ ok: true, data: {} })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(noticeLines()).toEqual([dropped(1, 'phone'), logLine('phone', 'sent')])
    })

    it.each([
      ['no identity for the email', []],
      ['the email’s identity unverified', [{ ...SAM_EMAIL, verified: false }]],
      ['the email’s identity on another person', [{ ...SAM_EMAIL, personId: 'p2' }]],
    ])('sends a phone notice with %s, keeping no row', async (_case, identities) => {
      const services = seeded(identities, { phone: '+61412345678' })
      answered(services)
      const transactions = vi.spyOn(services.db, 'createTransaction')
      expect((await event(services, 'phone')).body).toEqual({ ok: true, data: {} })
      // Nothing to keep, so no transaction, and no guard on the person.
      expect(transactions).not.toHaveBeenCalled()
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([dropped(1, 'phone'), logLine('phone', 'sent')])
    })

    it('makes one row for a replayed event, and keeps it as it is', async () => {
      const services = seeded([A])
      answered(services, () => failure('timeout'))
      await event(services)
      await hourly(services)
      const [kept] = rows(services)
      expect(kept).toMatchObject({ attempts: 1 })
      await event(services)
      expect(rows(services)).toEqual([kept])
      expect(noticeLines().filter((line) => line.cause === 'queue')).toEqual([])
    })

    it('deletes the row a replayed event sends, keeping no other', async () => {
      const services = seeded([A])
      answered(services, (call) => (call === 0 ? failure('timeout') : undefined))
      await event(services)
      expect(rows(services)).toHaveLength(1)
      expect((await event(services)).body).toEqual({ ok: true, data: {} })
      expect(rows(services)).toEqual([])
    })

    it('tries every address when a sent one’s row can’t be deleted', async () => {
      const services = seeded([A, B])
      const calls = answered(services)
      const commit = services.db.updateTransaction.bind(services.db)
      let commits = 0
      vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
        // The first commit writes the rows, and the second deletes A's.
        if (params.commit && ++commits === 2) {
          throw new AppwriteException('Server Error', 500, 'general_unknown')
        }
        return commit(params)
      })
      expect((await event(services)).body).toEqual({ ok: true, data: {} })
      expect(calls.map(({ to }) => to)).toEqual(['a@example.com', 'b@example.com'])
      // A's row stays, for a retry Resend answers as seen.
      expect(rows(services)).toEqual([expect.objectContaining({ identityId: 'iA' })])
    })

    it('sends anyway when the rows can’t be written, and says so', async () => {
      const services = seeded([A])
      answered(services)
      vi.spyOn(services.db, 'createTransaction').mockRejectedValueOnce(
        new AppwriteException('Server Error', 500, 'general_unknown'),
      )
      expect((await event(services)).body).toEqual({ ok: true, data: {} })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(rows(services)).toEqual([])
      expect(lines()).toEqual([
        logLine('email', 'failed', { cause: 'queue' }),
        logLine('email', 'sent'),
      ])
      expect(levels()).toEqual(['error', 'log'])
    })
  })

  describe('the hourly run (step 8)', () => {
    it('sends each row oldest first, 500 ms apart, with the email built again', async () => {
      const services = withRows(
        [
          pending('n2', { $createdAt: '2026-10-18T19:00:00.000Z', identityId: 'iB' }),
          pending('n1', { $createdAt: '2026-10-18T18:00:00.000Z' }),
          pending('n3', {
            $createdAt: '2026-10-18T19:30:00.000Z',
            kind: 'phone',
            identityId: 'iC',
          }),
        ],
        [A, B, C],
        // The new email, verified since.
        { ...CHANGED_EMAIL, emailVerification: true },
      )
      services.account.$updatedAt = '2026-10-18T20:30:00.000+00:00'
      const calls = answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 3,
        failed: 0,
        expired: 0,
        gone: 0,
      })
      expect(calls.map(({ to, key, at }) => [to, key, at - HOUR])).toEqual([
        ['a@example.com', 'email-change-notice-key-n1', 0],
        ['b@example.com', 'email-change-notice-key-n2', 500],
        // The phone notice goes to the address it was first meant for, not the account's
        // email now, which whoever changed the phone may have changed (#462).
        ['c@example.com', 'email-change-notice-key-n3', 1000],
      ])
      const [email] = sent(services)
      expect(email?.subject).toBe('Your Ledgerly email address was changed')
      // The account's email as it is now, masked, though `$updatedAt` moved on.
      expect(email?.text).toContain('was changed to J***@Example.com.')
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([
        retryLine('email', 'retried', 0),
        retryLine('email', 'retried', 0),
        retryLine('phone', 'retried', 0),
      ])
    })

    it.each([
      [23 * HOUR - 1, { retried: 1, failed: 0, expired: 0, gone: 0 }, 'retried', 1],
      [23 * HOUR, { retried: 0, failed: 0, expired: 1, gone: 0 }, 'expired', 0],
    ])('tries a row %i ms old, and drops it at 23 hours', async (age, counts, outcome, sends) => {
      const services = withRows([pending('n1')])
      answered(services)
      expect(counted(await hourly(services, age))).toEqual(counts)
      expect(services.sendEmail).toHaveBeenCalledTimes(sends)
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([retryLine('email', outcome, 0)])
      expect(levels().at(-1)).toBe(outcome === 'expired' ? 'warn' : 'log')
    })

    const gone = new AppwriteException('User not found', 404, 'user_not_found')
    it.each([
      [
        'the user is gone',
        'email',
        'gone',
        (services: Fakes) => {
          services.users = { get: async () => Promise.reject(gone) }
        },
      ],
      [
        'the person is being deleted',
        'email',
        'gone',
        (services: Fakes) =>
          withTransaction(services.db, (tx) =>
            tx.write({
              action: 'update',
              tableId: 'persons',
              rowId: 'p1',
              data: { deletedAt: AFTER },
            }),
          ),
      ],
      [
        'the address is gone',
        'email',
        'gone',
        (services: Fakes) =>
          withTransaction(services.db, (tx) =>
            tx.write({ action: 'delete', tableId: 'identities', rowId: 'iA' }),
          ),
      ],
      [
        'the address is on another person',
        'email',
        'gone',
        (services: Fakes) =>
          withTransaction(services.db, (tx) =>
            tx.write({
              action: 'update',
              tableId: 'identities',
              rowId: 'iA',
              data: { personId: 'p2' },
            }),
          ),
      ],
      [
        'the address is no longer verified',
        'email',
        'gone',
        (services: Fakes) =>
          withTransaction(services.db, (tx) =>
            tx.write({
              action: 'update',
              tableId: 'identities',
              rowId: 'iA',
              data: { verified: false },
            }),
          ),
      ],
      [
        'a phone notice’s address is no longer verified',
        'phone',
        'gone',
        (services: Fakes) =>
          withTransaction(services.db, (tx) =>
            tx.write({
              action: 'update',
              tableId: 'identities',
              rowId: 'iA',
              data: { verified: false },
            }),
          ),
      ],
    ] as const)('drops a row when %s, sending nothing', async (_case, kind, outcome, change) => {
      const services = withRows([pending('n1', { kind })], [A])
      await change(services)
      answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 0,
        failed: 0,
        expired: 0,
        gone: 1,
      })
      expect(services.sendEmail).not.toHaveBeenCalled()
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([retryLine(kind, outcome, 0)])
    })

    it('sends a phone notice to its identity though the account’s email is unverified now', async () => {
      const services = withRows([pending('n1', { kind: 'phone' })], [A], {
        ...CHANGED_EMAIL,
        phone: '+61412345678',
      })
      const calls = answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 1,
        failed: 0,
        expired: 0,
        gone: 0,
      })
      expect(calls.map(({ to }) => to)).toEqual(['a@example.com'])
      expect(sent(services)[0]?.subject).toBe('Your Ledgerly phone number was changed')
    })

    it('adds 1 to a failed row’s attempts, and a 429 ends the retries for the run', async () => {
      const services = withRows([
        pending('n1', { $createdAt: '2026-10-18T18:00:00.000Z', attempts: 2 }),
        pending('n2', { $createdAt: '2026-10-18T19:00:00.000Z' }),
        pending('n3', { $createdAt: '2026-10-18T19:30:00.000Z' }),
      ])
      const calls = answered(services, (call) =>
        call === 0 ? failure('timeout') : failure('rate_limit_exceeded', 429),
      )
      expect(counted(await hourly(services))).toEqual({
        retried: 0,
        failed: 2,
        expired: 0,
        gone: 0,
      })
      expect(calls).toHaveLength(2)
      expect(rows(services).map(({ $id, attempts }) => [$id, attempts])).toEqual([
        ['n1', 3],
        ['n2', 0],
        ['n3', 0],
      ])
      expect(noticeLines()).toEqual(
        [retryLine('email', 'failed', 3), retryLine('email', 'failed', 0)].map((line, index) => ({
          ...line,
          cause: index === 0 ? 'EmailError timeout' : 'EmailError rate_limit_exceeded 429',
        })),
      )
    })

    it('deletes a row Resend refuses, and counts it failed', async () => {
      const services = withRows([pending('n1')])
      answered(services, () => failure('validation_error', 422))
      expect(counted(await hourly(services))).toEqual({
        retried: 0,
        failed: 1,
        expired: 0,
        gone: 0,
      })
      expect(rows(services)).toEqual([])
    })

    it('counts a failed read against its row, and goes on to the next', async () => {
      const services = withRows([
        pending('n1', { $createdAt: '2026-10-18T18:00:00.000Z' }),
        pending('n2', { $createdAt: '2026-10-18T19:00:00.000Z', identityId: 'iB' }),
      ])
      const get = services.users.get
      let reads = 0
      services.users = {
        get: (params) =>
          ++reads === 1 ? Promise.reject(new AppwriteException('Server Error', 500)) : get(params),
      }
      answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 1,
        failed: 1,
        expired: 0,
        gone: 0,
      })
      expect(rows(services)).toEqual([expect.objectContaining({ $id: 'n1', attempts: 1 })])
    })

    it('starts no retry after 12 s of the run, counting the merges’ time', async () => {
      const services = withRows([
        pending('n1', { $createdAt: '2026-10-18T18:00:00.000Z' }),
        pending('n2', { $createdAt: '2026-10-18T19:00:00.000Z', identityId: 'iB' }),
      ])
      // The merges' walk, the run's first read of persons, takes 11.8 s.
      const list = services.db.listRows.bind(services.db)
      let walked = false
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        if (params.tableId === 'persons' && !walked) {
          walked = true
          await new Promise((resolve) => setTimeout(resolve, 11_800))
        }
        return list(params)
      })
      const calls = answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 1,
        failed: 0,
        expired: 0,
        gone: 0,
      })
      expect(calls.map(({ at, timeoutMs }) => [at - HOUR, timeoutMs])).toEqual([[11_800, 2_200]])
      expect(rows(services).map(({ $id }) => $id)).toEqual(['n2'])
    })

    // The merges' walk, the run's first read of persons, takes `ms`.
    function slowMerges(services: Fakes, ms: number) {
      const list = services.db.listRows.bind(services.db)
      let walked = false
      return vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        if (params.tableId === 'persons' && !walked) {
          walked = true
          await new Promise((resolve) => setTimeout(resolve, ms))
        }
        return list(params)
      })
    }

    it('lists no rows when the merges ran past 12 s', async () => {
      const services = withRows([pending('n1')])
      const list = slowMerges(services, 12_100)
      answered(services)
      expect(counted(await hourly(services, 23 * HOUR))).toEqual({
        retried: 0,
        failed: 0,
        expired: 0,
        gone: 0,
      })
      const tables = list.mock.calls.map(([params]) => params.tableId)
      expect(tables).not.toContain('changeNotices')
      expect(rows(services)).toHaveLength(1)
    })

    it('starts no row after 12 s, not even one to drop', async () => {
      const services = withRows([
        pending('n1', { $createdAt: '2026-10-18T18:00:00.000Z' }),
        pending('n2', { $createdAt: '2026-10-18T19:00:00.000Z' }),
      ])
      slowMerges(services, 11_900)
      // Each user read takes 300 ms and finds the user gone.
      services.users = {
        get: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          throw new AppwriteException('User not found', 404, 'user_not_found')
        },
      }
      answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 0,
        failed: 0,
        expired: 0,
        gone: 1,
      })
      expect(rows(services).map(({ $id }) => $id)).toEqual(['n2'])
    })

    it('leaves a row written in the last 15 s to the event run that may still be sending it', async () => {
      const at = (msAgo: number) => new Date(T0 + HOUR - msAgo).toISOString()
      const services = withRows([
        pending('n1', { $createdAt: at(15_001) }),
        pending('n2', { $createdAt: at(15_000) }),
      ])
      const calls = answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 1,
        failed: 0,
        expired: 0,
        gone: 0,
      })
      expect(calls.map(({ key }) => key)).toEqual(['email-change-notice-key-n1'])
      expect(rows(services).map(({ $id }) => $id)).toEqual(['n2'])
    })

    it('still answers when a failed try’s count can’t be written', async () => {
      const services = withRows([
        pending('n1', { $createdAt: '2026-10-18T18:00:00.000Z' }),
        pending('n2', { $createdAt: '2026-10-18T19:00:00.000Z', identityId: 'iB' }),
      ])
      answered(services, (call) => (call === 0 ? failure('timeout') : undefined))
      const commit = services.db.updateTransaction.bind(services.db)
      let commits = 0
      vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
        // The first commit is n1's count.
        if (params.commit && ++commits === 1) {
          throw new AppwriteException('Server Error', 500, 'general_unknown')
        }
        return commit(params)
      })
      const result = await hourly(services)
      expect(result.status).toBe(200)
      expect(counted(result)).toEqual({ retried: 1, failed: 1, expired: 0, gone: 0 })
      expect(rows(services)).toEqual([expect.objectContaining({ $id: 'n1', attempts: 0 })])
    })

    it('checks 23 hours again just before each send, after the spacing', async () => {
      const start = T0 + HOUR
      const services = withRows([
        pending('n1', { $createdAt: new Date(start - 23 * HOUR + 100).toISOString() }),
        // 400 ms short of 23 hours at the start, but past them by its send, 500 ms after n1's.
        pending('n2', { $createdAt: new Date(start - 23 * HOUR + 400).toISOString() }),
      ])
      const calls = answered(services)
      expect(counted(await hourly(services))).toEqual({
        retried: 1,
        failed: 0,
        expired: 1,
        gone: 0,
      })
      expect(calls.map(({ key }) => key)).toEqual(['email-change-notice-key-n1'])
      expect(rows(services)).toEqual([])
      expect(noticeLines()).toEqual([
        retryLine('email', 'retried', 0),
        retryLine('email', 'expired', 0),
      ])
    })

    it('still retries the notices when the merges’ walk fails', async () => {
      const services = withRows([pending('n1')])
      const list = services.db.listRows.bind(services.db)
      let walked = false
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        // The walk's first page of merged persons, not the retry's own reads.
        if (params.tableId === 'persons' && !walked) {
          walked = true
          throw new AppwriteException('Server Error', 500)
        }
        return list(params)
      })
      const calls = answered(services)
      const result = await hourly(services)
      expect(result.body).toMatchObject({ ok: true, data: { unfinished: 0 } })
      expect(counted(result)).toEqual({ retried: 1, failed: 0, expired: 0, gone: 0 })
      expect(calls).toHaveLength(1)
      expect(lines()).toContainEqual({
        event: 'merge_run_failed',
        cause: 'AppwriteException 500',
      })
    })

    it('answers with the merges’ counts when the rows can’t be listed', async () => {
      const services = withRows([pending('n1')])
      const list = services.db.listRows.bind(services.db)
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        if (params.tableId === 'changeNotices') throw new AppwriteException('Server Error', 500)
        return list(params)
      })
      const result = await hourly(services)
      expect(result.body).toMatchObject({ ok: true, data: { unfinished: 0 } })
      expect(counted(result)).toEqual({ retried: 0, failed: 0, expired: 0, gone: 0 })
      expect(noticeLines()).toEqual([
        { event: 'change_notice', outcome: 'failed', cause: 'AppwriteException 500' },
      ])
    })
  })
})
