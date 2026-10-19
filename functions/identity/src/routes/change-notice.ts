import { createHash } from 'node:crypto'
import type { Identities } from '@ledgerly/core/generated/rows'
import { identityKey } from '@ledgerly/core/identity/normalize'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { emailChangedEmail, phoneChangedEmail } from '@ledgerly/server/email/templates'
import { type ChangeNoticeOutcome, logProblem } from '@ledgerly/server/http/log'
import { Query } from 'node-appwrite'
import { findPersonOfUser, isAppwriteError } from '../rows'
import type { AccountUser, Services } from '../services'
import { appBase } from './password-notice'

// Step 6: Resend takes 2 sends a second, and identity's timeout is 15 s.
const SPACING_MS = 500
const LAST_START_MS = 12_000
const END_MS = 14_000
// When a 429 names no wait: Resend's limit is per second.
const RETRY_AFTER_MS = 1_000
// Resend's answers for a key it has seen: this notice went out already, or is going out now.
const ALREADY_SENT: ReadonlySet<string> = new Set([
  'invalid_idempotent_request',
  'concurrent_idempotent_requests',
])
const EMAIL_KEY = 'email:'

type Notice = 'email' | 'phone'
type Outcome = Exclude<ChangeNoticeOutcome, 'failed'>
// What one log line says beyond the user and the notice (step 7): the outcome and, for a failure,
// the error, or `budget` with how many addresses were left.
type Line =
  | { outcome: Outcome }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'failed'; cause: 'budget'; count: number }

/**
 * The email and phone change notice (identity-and-invites.md#email-and-phone-change-notice), for
 * an event run of `users.*.update.email` or `users.*.update.phone` naming `userId` (event-run.ts).
 * Writes nothing. Each email's outcome goes to the log, with the ID; throws after the last if any
 * wasn't sent.
 */
export async function changeNotice(
  services: Services,
  userId: string,
  notice: Notice,
  body: unknown,
): Promise<void> {
  const started = Date.now()
  const log = (line: Line) => logProblem('change_notice', { userId, identityType: notice, ...line })
  // Step 1: the body's `$id` is used for this check only.
  const bodyId = typeof body === 'object' && body !== null ? (body as { $id?: unknown }).$id : null
  if (bodyId !== userId) {
    log({ outcome: 'mismatch' })
    return
  }
  const emails = await noticesFor(services, userId, notice)
  if (typeof emails === 'string') {
    log({ outcome: emails })
    return
  }
  if (!(await sendEach(services, emails, started, log))) {
    // Appwrite doesn't run an event again, so the run fails with a trace in the log.
    throw new Error('Not every change notice was sent')
  }
}

// Steps 2–5: the emails to send, or why there are none.
async function noticesFor(
  services: Services,
  userId: string,
  notice: Notice,
): Promise<Email[] | Outcome> {
  const { db, users, supportEmail } = services
  let user: AccountUser
  try {
    user = await users.get({ userId })
  } catch (error) {
    if (isAppwriteError(error, 404)) return 'gone'
    throw error
  }
  const person = await findPersonOfUser(db, userId)
  if (person?.deletedAt) return 'gone'
  if (notice === 'phone') {
    if (!user.email || !user.emailVerification) return 'unverified'
    const content = phoneChangedEmail({ newPhone: user.phone, supportEmail, url: signIn(services) })
    const key = sha256(`${userId}:${user.$updatedAt}`)
    return [{ to: user.email, ...content, idempotencyKey: `phone-change-notice-${key}` }]
  }
  const old = person ? await oldAddresses(db, person.$id, user.email) : []
  if (old.length === 0) return 'no_old_address'
  const content = emailChangedEmail({ newEmail: user.email, supportEmail, url: signIn(services) })
  return old.map(({ key }) => ({
    to: key.slice(EMAIL_KEY.length),
    ...content,
    // One per address and change: a replay reuses it, and a new change gets a new one.
    idempotencyKey: `email-change-notice-${sha256(`${userId}:${key}:${user.$updatedAt}`)}`,
  }))
}

// Step 3: every verified email identity on the person but the current email's, newest
// `verifiedAt` first (none counts as oldest), then by `$id`. No cap.
async function oldAddresses(db: Db, personId: string, currentEmail: string): Promise<Identities[]> {
  const current = keyOrNull(currentEmail)
  const rows = await allRows<Identities>(db, TABLES.identities, [
    Query.equal('personId', personId),
    Query.equal('type', 'email'),
    Query.equal('verified', true),
  ])
  const verifiedAt = (row: Identities) =>
    row.verifiedAt ? Date.parse(row.verifiedAt) : Number.NEGATIVE_INFINITY
  return rows
    .filter((row) => row.key !== current)
    .sort((a, b) => verifiedAt(b) - verifiedAt(a) || (a.$id < b.$id ? -1 : 1))
}

// An empty or unusable current email leaves no key out.
function keyOrNull(email: string): string | null {
  try {
    return identityKey('email', email)
  } catch {
    return null
  }
}

/**
 * Step 6: one email after another, each started at least SPACING_MS after the last, none after
 * LAST_START_MS of the run, and none running past END_MS. A 429 is tried once more after Resend's
 * wait. Logs each email's outcome, and the ones left when time runs out; false if any wasn't sent.
 */
async function sendEach(
  services: Services,
  emails: readonly Email[],
  started: number,
  log: (line: Line) => void,
): Promise<boolean> {
  let lastStart = Number.NEGATIVE_INFINITY
  // Waits until `at`, or later for the spacing; false if the send would start too late.
  const startAt = async (at: number): Promise<boolean> => {
    const start = Math.max(at, lastStart + SPACING_MS, Date.now())
    if (start - started > LAST_START_MS) return false
    if (start > Date.now()) await new Promise((resolve) => setTimeout(resolve, start - Date.now()))
    lastStart = Date.now()
    return true
  }
  const send = (email: Email) =>
    services.sendEmail(email, { timeoutMs: started + END_MS - Date.now() })
  // One email, and once more after a 429, with the same key: sent, or the error.
  const deliver = async (email: Email): Promise<Line> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await send(email)
        return { outcome: 'sent' }
      } catch (error) {
        if (!(error instanceof EmailError)) return { outcome: 'failed', error }
        if (ALREADY_SENT.has(error.type)) return { outcome: 'sent' }
        // After Resend's wait, and only if that wait ends by LAST_START_MS (the lead on #329):
        // a retry sent sooner only gets another 429 and holds up the addresses after it.
        const retryAt = Date.now() + (error.retryAfterMs ?? RETRY_AFTER_MS)
        const retry =
          error.type === 'rate_limit_exceeded' && attempt === 1 && (await startAt(retryAt))
        if (!retry) return { outcome: 'failed', error }
      }
    }
  }
  let allSent = true
  for (const [index, email] of emails.entries()) {
    if (!(await startAt(0))) {
      log({ outcome: 'failed', cause: 'budget', count: emails.length - index })
      return false
    }
    const line = await deliver(email)
    log(line)
    allSent &&= line.outcome === 'sent'
  }
  return allSent
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function signIn(services: Services): string {
  return `${appBase(services.appUrl)}/login`
}
