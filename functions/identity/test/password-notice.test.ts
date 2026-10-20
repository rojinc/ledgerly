import { EmailError } from '@ledgerly/server/email/send-email'
import { AppwriteException } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountUser } from '../src/services'
import { account, call, type Fakes, fakes } from './harness'

const EVENT = { 'x-appwrite-trigger': 'event', 'x-appwrite-event': 'users.u1.update.password' }
// 5 minutes before the harness's NOW (07:00 on 19 October in Sydney).
const CHANGED = '2026-10-18T19:55:00.000Z'

// What Appwrite sends: the user, password hash included, so it must never reach a log.
const userBody = (id = 'u1') => ({ $id: id, email: 'sam@example.com', password: 'argon2-SECRET' })

function changed(overrides: Partial<AccountUser> = {}, seed: Parameters<typeof fakes>[0] = {}) {
  return fakes(seed, { account: account({ passwordUpdate: CHANGED, ...overrides }) })
}

// An event run: no JWT, `x-appwrite-trigger: event`, the event's name in `x-appwrite-event`.
function fire(services: Fakes, body: unknown = userBody(), headers: Record<string, string> = {}) {
  return call(services, 'POST', '/', body, null, { ...EVENT, ...headers })
}

// The logProblem lines a spy saw, without `fn`.
function notices(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(([line]) => {
    const { fn: _fn, ...event } = JSON.parse(String(line)) as Record<string, unknown>
    return event
  })
}

function sent(services: Fakes) {
  return vi.mocked(services.sendEmail).mock.calls.map(([email]) => email)
}

afterEach(() => vi.restoreAllMocks())

describe('POST / (the users.*.update.password event)', () => {
  it('emails the verified address once, in the profile’s time zone, linking only to sign-in', async () => {
    const services = changed(
      {},
      { profiles: [{ $id: 'u1', personId: 'p1', timezone: 'Australia/Sydney', region: 'AU-NSW' }] },
    )
    const result = await fire(services)
    expect(result.body).toEqual({ ok: true, data: {} })
    const [email] = sent(services)
    expect(sent(services)).toHaveLength(1)
    expect(email).toMatchObject({
      to: 'sam@example.com',
      subject: 'Your Ledgerly password was changed',
      idempotencyKey: expect.stringMatching(/^password-notice-[0-9a-f]{64}$/),
    })
    expect(email?.text).toContain('on Monday 19 October, 6:55 am (Australia/Sydney time).')
    expect(email?.text).toContain('Go to Ledgerly: https://app.example/login')
  })

  it('sends a replay under the same key, so Resend drops the second copy', async () => {
    const services = changed()
    await fire(services)
    await fire(services)
    const [first, second] = sent(services)
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey)
    // Another change is another key.
    services.users = { get: async () => account({ passwordUpdate: '2026-10-18T19:58:00.000Z' }) }
    await fire(services)
    expect(sent(services)[2]?.idempotencyKey).not.toBe(first?.idempotencyKey)
  })

  it('uses UTC when there is no profile', async () => {
    const services = changed()
    await fire(services)
    expect(sent(services)[0]?.text).toContain('on Sunday 18 October, 7:55 pm (UTC time).')
  })

  it.each([
    ['61 minutes after the change', { passwordUpdate: '2026-10-18T18:59:00.000Z' }, 'stale'],
    ['a password never set', { passwordUpdate: '' }, 'stale'],
    ['an unverified email', { emailVerification: false }, 'unverified'],
    ['no email', { email: '' }, 'unverified'],
  ])('sends nothing for %s', async (_, overrides, outcome) => {
    const services = changed(overrides)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect((await fire(services)).body).toEqual({ ok: true, data: {} })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(notices(log)).toEqual([{ event: 'password_notice', userId: 'u1', outcome }])
  })

  it('sends nothing for a user who is gone', async () => {
    const services = changed()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    services.users = {
      get: async () => {
        throw new AppwriteException('User not found', 404, 'user_not_found')
      },
    }
    await fire(services)
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(notices(log)).toEqual([{ event: 'password_notice', userId: 'u1', outcome: 'gone' }])
  })

  it('takes the user ID from the event name over the body, and nothing else from the body', async () => {
    const services = changed()
    const get = vi.fn(async ({ userId }: { userId: string }) =>
      account({ $id: userId, email: `${userId}@example.com`, passwordUpdate: CHANGED }),
    )
    services.users = { get }
    await fire(
      services,
      { ...userBody('u1'), email: 'attacker@example.com', emailVerification: true },
      { 'x-appwrite-event': 'users.u2.update.password' },
    )
    expect(get).toHaveBeenCalledWith({ userId: 'u2' })
    expect(sent(services)).toEqual([expect.objectContaining({ to: 'u2@example.com' })])
  })

  it('fits a recovery event, whose body is a token: the user comes from the name', async () => {
    const services = changed()
    const get = vi.spyOn(services.users, 'get')
    await fire(
      services,
      { $id: 'token1', userId: 'u1', secret: 'SECRET' },
      { 'x-appwrite-event': 'users.u1.recovery.token1.update' },
    )
    expect(get).toHaveBeenCalledWith({ userId: 'u1' })
    expect(sent(services)).toHaveLength(1)
  })

  it.each(['users.u1.x.update.password', 'users.u1.x.recovery.token1.update'])(
    'reads a user ID that contains a dot whole, never as another user’s (%s)',
    async (name) => {
      const services = changed()
      const get = vi.spyOn(services.users, 'get')
      await fire(services, { $id: 'token1', userId: 'u1.x' }, { 'x-appwrite-event': name })
      expect(get.mock.calls).toEqual([[{ userId: 'u1.x' }]])
    },
  )

  it.each([
    ['no name', undefined],
    ['an empty name', ''],
    ['a wildcard for the user', 'users.*.update.password'],
    ['no user ID', 'users..update.password'],
    ['a user ID that isn’t one', 'users.../etc.update.password'],
    ['another event', 'users.u1.update.name'],
    ['a recovery being created', 'users.u1.recovery.token1.create'],
    ['a recovery token ID with a dot', 'users.u1.recovery.token.1.update'],
    ['the name with something after it', 'users.u1.update.password.x'],
    ['the name with something before it', 'x.users.u1.update.password'],
    ['another resource', 'teams.u1.update.password'],
  ])('refuses an event run with %s, never using the body’s $id', async (_, name) => {
    const services = changed()
    const get = vi.spyOn(services.users, 'get')
    const result = await call(services, 'POST', '/', userBody('u1'), null, {
      'x-appwrite-trigger': 'event',
      ...(name === undefined ? {} : { 'x-appwrite-event': name }),
    })
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(get).not.toHaveBeenCalled()
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('never checks the body’s $id against the name: a reset’s body is a token', async () => {
    const services = changed()
    const get = vi.spyOn(services.users, 'get')
    await fire(services, { $id: 'u2' })
    await fire(services, undefined)
    expect(get.mock.calls).toEqual([[{ userId: 'u1' }], [{ userId: 'u1' }]])
    expect(sent(services)).toHaveLength(2)
  })

  it('logs a failed send as an error and fails the run, which Appwrite won’t retry', async () => {
    const services = changed()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    services.sendEmail = vi.fn(async () => {
      throw new EmailError('Resend answered 503 unknown', 'unknown', 503)
    })
    expect((await fire(services)).status).toBe(500)
    expect(notices(log)).toEqual([
      {
        event: 'password_notice',
        userId: 'u1',
        outcome: 'failed',
        cause: 'EmailError unknown 503',
      },
    ])
  })

  it('never logs the body, the address or the name', async () => {
    const services = changed()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await fire(services)
    const logged = [...result.logs, ...log.mock.calls.flat()].join('\n')
    expect(logged).not.toMatch(/SECRET|sam@example|Sam Lee/)
    expect(notices(log)).toEqual([{ event: 'password_notice', userId: 'u1', outcome: 'sent' }])
  })

  it('refuses a person, even with a forged event trigger', async () => {
    const services = changed()
    for (const headers of [{}, EVENT]) {
      const result = await call(services, 'POST', '/', userBody(), 'u1', headers)
      expect(result.status).toBe(403)
      expect(result.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('refuses a run without a JWT that isn’t an event; a scheduled run finishes merges instead', async () => {
    const services = changed()
    expect((await call(services, 'POST', '/', userBody(), null)).status).toBe(401)
    // The hourly run shares `POST /` (identity-and-invites.md#finishing-merges).
    const scheduled = await call(services, 'POST', '/', userBody(), null, {
      'x-appwrite-trigger': 'schedule',
    })
    expect(scheduled.body).toMatchObject({ ok: true, data: { unfinished: 0 } })
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('fails without APP_URL, sending nothing', async () => {
    const services = changed()
    services.appUrl = ''
    expect((await fire(services)).status).toBe(500)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })
})
