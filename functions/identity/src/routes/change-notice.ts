import { createHash } from 'node:crypto'
import type { ChangeNotices, Identities, Persons } from '@ledgerly/core/generated/rows'
import { identityKey } from '@ledgerly/core/identity/normalize'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { emailChangedEmail, phoneChangedEmail } from '@ledgerly/server/email/templates'
import { type ChangeNoticeOutcome, logProblem } from '@ledgerly/server/http/log'
import { randomId } from '@ledgerly/server/identity/random-id'
import { Query } from 'node-appwrite'
import { findPersonOfUser, getRowOrNull, isAppwriteError } from '../rows'
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
// Step 8: Resend keeps a key 24 hours, so a notice is tried for 23 (#345).
const KEEP_MS = 23 * 60 * 60 * 1000
// Step 8: the rows one hourly run looks at, oldest first. Its time allows far fewer sends.
const PAGE = 100
// Step 8: identity's timeout. A row younger than this may still be its event run's to send.
const RUN_MS = 15_000
const EMAIL_KEY = 'email:'

type Notice = 'email' | 'phone'
type Outcome = Exclude<ChangeNoticeOutcome, 'failed'>
// What one log line says beyond the user and the notice (step 7): the outcome and, for a failure,
// the error, or `budget` with how many addresses were left, or `queue`.
type Line =
  | { outcome: Outcome }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'failed'; cause: 'budget'; count: number }
  | { outcome: 'failed'; cause: 'queue' }
// An email to send, with the key its row is found by.
type Keyed = Email & { idempotencyKey: string }
// One email of the event run, and the old address's identity row it goes to, if any.
type Pending = { email: Keyed; identityId: string | null }

/** What identity's hourly run did with the notices it tried (step 8). */
export type NoticeCounts = { retried: number; failed: number; dropped: number }

/**
 * The email and phone change notice (identity-and-invites.md#email-and-phone-change-notice), for
 * an event run of `users.*.update.email` or `users.*.update.phone` naming `userId` (event-run.ts).
 * Writes a `changeNotices` row per email before sending, and deletes each once it's sent, so the
 * hourly run tries the rest (step 8). Each email's outcome goes to the log, with the ID; throws
 * after the last if any wasn't sent.
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
  const pending = await noticesFor(services, userId, notice)
  if (typeof pending === 'string') {
    log({ outcome: pending })
    return
  }
  let rows = new Map<string, string>()
  try {
    rows = await queue(services.db, userId, notice, pending)
  } catch {
    // Sent anyway, with nothing kept to retry.
    log({ outcome: 'failed', cause: 'queue' })
  }
  const pace = pacer(services, started)
  let allSent = true
  for (const [index, { email }] of pending.entries()) {
    if (!(await pace.start())) {
      // Their rows stay, for the hourly run.
      log({ outcome: 'failed', cause: 'budget', count: pending.length - index })
      allSent = false
      break
    }
    const line = await deliver(pace, email)
    log(line)
    const settled = line.outcome === 'sent' || ('error' in line && refused(line.error))
    if (settled) await forget(services.db, rows.get(email.idempotencyKey))
    allSent &&= line.outcome === 'sent'
  }
  // Appwrite doesn't run an event again, so the run fails with a trace in the log.
  if (!allSent) throw new Error('Not every change notice was sent')
}

/**
 * Step 8: tries the `changeNotices` rows again, oldest first, in identity's hourly run, after its
 * merges, leaving rows an event run may still be sending (RUN_MS). Step 6's limits count from the run's start (`started`), so the merges' time comes off
 * them. A row is deleted once its email is sent, or can never be (refused, gone, or 23 hours
 * old). A 429 ends the retries for the run, since Resend's limit is shared; any other failure
 * adds 1 to `attempts`. Rows it doesn't reach wait for the next hour.
 */
export async function retryNotices(services: Services, started: number): Promise<NoticeCounts> {
  const counts: NoticeCounts = { retried: 0, failed: 0, dropped: 0 }
  // Merges that ran long leave no time for even the listing.
  if (Date.now() - started > LAST_START_MS) return counts
  const written = new Date(services.now.getTime() - RUN_MS).toISOString()
  let rows: ChangeNotices[]
  try {
    ;({ rows } = await services.db.listRows<ChangeNotices>({
      databaseId: DATABASE_ID,
      tableId: TABLES.changeNotices,
      queries: [
        Query.lessThan('$createdAt', written),
        Query.orderAsc('$createdAt'),
        Query.limit(PAGE),
      ],
      total: false,
    }))
  } catch (error) {
    logProblem('change_notice', { outcome: 'failed', error })
    return counts
  }
  const pace = pacer(services, started)
  for (const row of rows) {
    if (Date.now() - started > LAST_START_MS) break
    // Each line with the failed tries so far.
    const log = (line: Line, attempts = row.attempts) =>
      logProblem('change_notice', {
        userId: row.userId,
        identityType: row.kind,
        counts: { attempts },
        ...line,
      })
    let error: unknown
    try {
      const email =
        services.now.getTime() - Date.parse(row.$createdAt) >= KEEP_MS
          ? 'expired'
          : await rebuilt(services, row)
      if (typeof email === 'string') {
        counts.dropped += 1
        log({ outcome: email })
        await forget(services.db, row.$id)
        continue
      }
      if (!(await pace.start())) break
      error = await sendOnce(pace, email)
      if (error === undefined) {
        counts.retried += 1
        log({ outcome: 'retried' })
        await forget(services.db, row.$id)
        continue
      }
      if (refused(error)) {
        counts.failed += 1
        log({ outcome: 'failed', error })
        await forget(services.db, row.$id)
        continue
      }
    } catch (thrown) {
      // A read that failed: the row is tried again next hour.
      error = thrown
    }
    counts.failed += 1
    if (error instanceof EmailError && error.type === 'rate_limit_exceeded') {
      log({ outcome: 'failed', error })
      break
    }
    log({ outcome: 'failed', error }, row.attempts + 1)
    await bump(services.db, row)
  }
  return counts
}

// Steps 2–5: the emails to send, or why there are none.
async function noticesFor(
  services: Services,
  userId: string,
  notice: Notice,
): Promise<Pending[] | Outcome> {
  const found = await accountOf(services, userId)
  if (found === 'gone') return found
  const { user, person } = found
  if (notice === 'phone') {
    const key = `phone-change-notice-${sha256(`${userId}:${user.$updatedAt}`)}`
    const email = phoneEmail(services, user, key)
    return email ? [{ email, identityId: null }] : 'unverified'
  }
  const old = person ? await oldAddresses(services.db, person.$id, user.email) : []
  if (old.length === 0) return 'no_old_address'
  return old.map((identity) => ({
    // One per address and change: a replay reuses it, and a new change gets a new one.
    email: emailEmail(
      services,
      user,
      identity,
      `email-change-notice-${sha256(`${userId}:${identity.key}:${user.$updatedAt}`)}`,
    ),
    identityId: identity.$id,
  }))
}

// Step 8: a row's email built again as steps 2–5 build it, but with the row's own key, since
// the user's `$updatedAt` may have changed since; or why there's none to send now.
async function rebuilt(services: Services, row: ChangeNotices): Promise<Keyed | Outcome> {
  const found = await accountOf(services, row.userId)
  if (found === 'gone') return found
  const { user, person } = found
  if (row.kind === 'phone') return phoneEmail(services, user, row.idempotencyKey) ?? 'unverified'
  const identity = row.identityId
    ? await getRowOrNull<Identities>(services.db, TABLES.identities, row.identityId)
    : null
  // Gone, moved to another person, or no longer verified.
  const still = identity?.type === 'email' && identity.verified && identity.personId === person?.$id
  return identity && still ? emailEmail(services, user, identity, row.idempotencyKey) : 'gone'
}

// Step 2: the user as Appwrite has them now, and their person; `gone` for a user that's gone or
// a person being deleted.
async function accountOf(
  services: Services,
  userId: string,
): Promise<{ user: AccountUser; person: Persons | undefined } | 'gone'> {
  let user: AccountUser
  try {
    user = await services.users.get({ userId })
  } catch (error) {
    if (isAppwriteError(error, 404)) return 'gone'
    throw error
  }
  const person = await findPersonOfUser(services.db, userId)
  return person?.deletedAt ? 'gone' : { user, person }
}

// Steps 4 and 5: a phone notice goes to the account's verified email, or nowhere.
function phoneEmail(services: Services, user: AccountUser, key: string): Keyed | null {
  if (!user.email || !user.emailVerification) return null
  const { supportEmail } = services
  const content = phoneChangedEmail({ newPhone: user.phone, supportEmail, url: signIn(services) })
  return { to: user.email, ...content, idempotencyKey: key }
}

// Steps 3 and 5: an email notice to one old address.
function emailEmail(
  services: Services,
  user: AccountUser,
  identity: Identities,
  key: string,
): Keyed {
  const { supportEmail } = services
  const content = emailChangedEmail({ newEmail: user.email, supportEmail, url: signIn(services) })
  return { to: identity.key.slice(EMAIL_KEY.length), ...content, idempotencyKey: key }
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
 * Step 6: a `changeNotices` row for each email, in one transaction, before the first send. A row
 * already there with the key, from a replayed event, is kept as it is. Returns each key's row ID,
 * so the row can be deleted once its email is sent.
 */
async function queue(
  db: Db,
  userId: string,
  notice: Notice,
  pending: readonly Pending[],
): Promise<Map<string, string>> {
  const keys = pending.map(({ email }) => email.idempotencyKey)
  const stored = await allRows<ChangeNotices>(db, TABLES.changeNotices, [
    Query.equal('idempotencyKey', keys),
  ])
  const rows = new Map(stored.map((row) => [row.idempotencyKey, row.$id]))
  const created = new Map<string, string>()
  const writes: Write[] = []
  for (const { email, identityId } of pending) {
    if (rows.has(email.idempotencyKey)) continue
    const rowId = randomId()
    created.set(email.idempotencyKey, rowId)
    const data = {
      userId,
      kind: notice,
      identityId,
      idempotencyKey: email.idempotencyKey,
      attempts: 0,
    }
    writes.push({ action: 'create', tableId: TABLES.changeNotices, rowId, data })
  }
  if (writes.length > 0) await withTransaction(db, (tx) => tx.write(...writes))
  return new Map([...rows, ...created])
}

// Deletes the row of an email that was sent or never can be. One a failed delete leaves is
// harmless: its key has been seen, so its retry sends nothing, and it goes then.
async function forget(db: Db, rowId: string | undefined): Promise<void> {
  if (!rowId) return
  await withTransaction(db, (tx) =>
    tx.write({ action: 'delete', tableId: TABLES.changeNotices, rowId }),
  ).catch(() => undefined)
}

// Step 8: one more failed try. A count that can't be written leaves the row to try next hour.
async function bump(db: Db, row: ChangeNotices): Promise<void> {
  const data = { attempts: row.attempts + 1 }
  await withTransaction(db, (tx) =>
    tx.write({ action: 'update', tableId: TABLES.changeNotices, rowId: row.$id, data }),
  ).catch(() => undefined)
}

/**
 * Step 6's limits for one run's sends, counted from `started`: each starts at least SPACING_MS
 * after the last, none after LAST_START_MS of the run, and none runs past END_MS.
 */
function pacer(services: Services, started: number) {
  let lastStart = Number.NEGATIVE_INFINITY
  return {
    // Waits until `at`, or later for the spacing; false if the send would start too late.
    async start(at = 0): Promise<boolean> {
      const start = Math.max(at, lastStart + SPACING_MS, Date.now())
      if (start - started > LAST_START_MS) return false
      if (start > Date.now())
        await new Promise((resolve) => setTimeout(resolve, start - Date.now()))
      lastStart = Date.now()
      return true
    },
    send(email: Email) {
      return services.sendEmail(email, { timeoutMs: started + END_MS - Date.now() })
    },
  }
}

type Pacer = ReturnType<typeof pacer>

// One try: undefined once it's sent, or Resend has seen the key; otherwise the error.
async function sendOnce(pace: Pacer, email: Email): Promise<unknown> {
  try {
    await pace.send(email)
    return undefined
  } catch (error) {
    return error instanceof EmailError && ALREADY_SENT.has(error.type) ? undefined : error
  }
}

// Step 6: one email, and once more after a 429, with the same key: sent, or the error.
async function deliver(pace: Pacer, email: Email): Promise<Line> {
  for (let attempt = 1; ; attempt++) {
    const error = await sendOnce(pace, email)
    if (error === undefined) return { outcome: 'sent' }
    if (!(error instanceof EmailError)) return { outcome: 'failed', error }
    // After Resend's wait, and only if that wait ends by LAST_START_MS (the lead on #329):
    // a retry sent sooner only gets another 429 and holds up the addresses after it.
    const retryAt = Date.now() + (error.retryAfterMs ?? RETRY_AFTER_MS)
    const retry =
      error.type === 'rate_limit_exceeded' && attempt === 1 && (await pace.start(retryAt))
    if (!retry) return { outcome: 'failed', error }
  }
}

// Resend refused the email itself (`validation_error`), so no later try would send it.
function refused(error: unknown): boolean {
  return error instanceof EmailError && error.type === 'validation_error'
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function signIn(services: Services): string {
  return `${appBase(services.appUrl)}/login`
}
