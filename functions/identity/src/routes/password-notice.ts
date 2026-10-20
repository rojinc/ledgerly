import { createHash } from 'node:crypto'
import type { Profiles } from '@ledgerly/core/generated/rows'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { EmailError } from '@ledgerly/server/email/send-email'
import { passwordChangedEmail } from '@ledgerly/server/email/templates'
import { logProblem, type NoticeOutcome } from '@ledgerly/server/http/log'
import { getRowOrNull, isAppwriteError } from '../rows'
import type { AccountUser, Services } from '../services'

// How long after `passwordUpdate` an event may still send: long enough for a backed-up event
// queue, short enough that a replay can't email about an old change.
const PASSWORD_NOTICE_WINDOW_MINUTES = 60

type Outcome = Exclude<NoticeOutcome, 'failed'>

/**
 * The password notice (identity-and-invites.md#password-notice), for an event run of
 * `users.*.update.password` or `users.*.recovery.*.update` naming `userId` (event-run.ts).
 * Everything comes from `users.get`. Throws if the send fails; the outcome goes to the log, with
 * the ID.
 */
export async function passwordNotice(services: Services, userId: string): Promise<void> {
  const log = (fields: { outcome: NoticeOutcome; error?: unknown }) =>
    logProblem('password_notice', { userId, ...fields })
  try {
    log({ outcome: await notify(services, userId) })
  } catch (error) {
    // Appwrite doesn't run an event again, so a failed send is lost; the run fails with it.
    if (error instanceof EmailError) log({ outcome: 'failed', error })
    throw error
  }
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
export function appBase(appUrl: string): string {
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error('APP_URL is not set. Add it as an Appwrite project variable.')
  }
  return appUrl.replace(/\/+$/, '')
}
