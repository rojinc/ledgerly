import { AppwriteException } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountUser } from '../src/services'
import { account, call, type Fakes, fakes } from './harness'

const EVENT = { 'x-appwrite-trigger': 'event' }
// 5 minutes before the harness's NOW (07:00 on 19 October in Sydney).
const CHANGED = '2026-10-18T19:55:00.000Z'

// What Appwrite sends: the user, password hash included, so it must never reach a log.
const userBody = (id = 'u1') => ({ $id: id, email: 'sam@example.com', password: 'argon2-SECRET' })

function changed(overrides: Partial<AccountUser> = {}, seed: Parameters<typeof fakes>[0] = {}) {
  return fakes(seed, { account: account({ passwordUpdate: CHANGED, ...overrides }) })
}

// An event run: no JWT, `x-appwrite-trigger: event`.
function fire(services: Fakes, body: unknown = userBody()) {
  return call(services, 'POST', '/', body, null, EVENT)
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
    expect(log.mock.calls).toEqual([[`identity: password notice for user u1: ${outcome}`]])
  })

  it('sends nothing for a user who is gone, or a body without a user ID', async () => {
    const services = changed()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    services.users = {
      get: async () => {
        throw new AppwriteException('User not found', 404, 'user_not_found')
      },
    }
    await fire(services)
    await fire(services, { $id: '../../etc' })
    await fire(services, 'not an object')
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([
      ['identity: password notice for user u1: gone'],
      ['identity: password notice for user (none): gone'],
      ['identity: password notice for user (none): gone'],
    ])
  })

  it('reads only the user ID from the body: a body naming another user re-sends only their own notice', async () => {
    const services = changed()
    const get = vi.fn(async ({ userId }: { userId: string }) =>
      account({ $id: userId, email: `${userId}@example.com`, passwordUpdate: CHANGED }),
    )
    services.users = { get }
    await fire(services, {
      ...userBody('u2'),
      email: 'attacker@example.com',
      emailVerification: true,
    })
    expect(get).toHaveBeenCalledWith({ userId: 'u2' })
    expect(sent(services)).toEqual([expect.objectContaining({ to: 'u2@example.com' })])
  })

  it('never logs the body, the address or the name', async () => {
    const services = changed()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await fire(services)
    const logged = [...result.logs, ...log.mock.calls.flat()].join('\n')
    expect(logged).not.toMatch(/SECRET|sam@example|Sam Lee/)
    expect(log.mock.calls).toEqual([['identity: password notice for user u1: sent']])
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

  it('refuses a run without a JWT that isn’t an event, and a scheduled run', async () => {
    const services = changed()
    expect((await call(services, 'POST', '/', userBody(), null)).status).toBe(401)
    const scheduled = await call(services, 'POST', '/', userBody(), null, {
      'x-appwrite-trigger': 'schedule',
    })
    expect(scheduled.status).toBe(403)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('fails without APP_URL, sending nothing', async () => {
    const services = changed()
    services.appUrl = ''
    expect((await fire(services)).status).toBe(500)
    expect(services.sendEmail).not.toHaveBeenCalled()
  })
})
