import { createHash } from 'node:crypto'
import type { Profiles } from '@ledgerly/core/generated/rows'
import { idSchema } from '@ledgerly/core/schemas/common'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { passwordChangedEmail } from '@ledgerly/server/email/templates'
import { AppError } from '@ledgerly/server/http/app-error'
import { getRowOrNull, isAppwriteError } from '../rows'
import type { AccountUser, Services } from '../services'

// How long after `passwordUpdate` an event may still send: long enough for a backed-up event
// queue, short enough that a replay can't email about an old change.
const PASSWORD_NOTICE_WINDOW_MINUTES = 60

type Outcome = 'sent' | 'stale' | 'unverified' | 'gone'

/**
 * `identity POST /` (identity-and-invites.md#password-notice): the `users.*.update.password`
 * event, run without a JWT. Only `$id` is read from the body, which can carry the password
 * hash, so the body is never logged or stored; everything else comes from `users.get`. Always
 * `{}`: the outcome goes to the log, with the user ID.
 */
export async function passwordNotice(
  services: Services,
  event: boolean,
  body: unknown,
): Promise<Record<string, never>> {
  if (!event) throw new AppError('FORBIDDEN', 'Only Appwrite sends this.')
  const userId = idOf(body)
  const outcome = userId === null ? 'gone' : await notify(services, userId)
  console.log(`identity: password notice for user ${userId ?? '(none)'}: ${outcome}`)
  return {}
}

function idOf(body: unknown): string | null {
  const id = typeof body === 'object' && body !== null ? (body as { $id?: unknown }).$id : null
  const parsed = idSchema.safeParse(id)
  return parsed.success ? parsed.data : null
}

async function notify(services: Services, userId: string): Promise<Outcome> {
  const { db, users, now } = services
  let user: AccountUser
  try {
    user = await users.get({ userId })
  } catch (error) {
    if (isAppwriteError(error, 404)) return 'gone'
    throw error
  }
  // Never set (an account made with an email code), or too long ago: a replay, or a stale event.
  const age = now.getTime() - Date.parse(user.passwordUpdate)
  if (!(age < PASSWORD_NOTICE_WINDOW_MINUTES * 60 * 1000)) return 'stale'
  if (!user.email || !user.emailVerification) return 'unverified'
  // The profile's row ID is the user ID.
  const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
  const content = passwordChangedEmail({
    changedAt: user.passwordUpdate,
    timeZone: profile?.timezone ?? 'UTC',
    url: `${appBase(services.appUrl)}/login`,
  })
  // One email per change: a replayed or repeated event reuses the key, and Resend drops it.
  const key = createHash('sha256').update(`${userId}:${user.passwordUpdate}`).digest('hex')
  await services.sendEmail({ to: user.email, ...content, idempotencyKey: `password-notice-${key}` })
  return 'sent'
}

// The web app's address, without a trailing slash. A missing APP_URL fails the run.
function appBase(appUrl: string): string {
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error('APP_URL is not set. Add it as an Appwrite project variable.')
  }
  return appUrl.replace(/\/+$/, '')
}
