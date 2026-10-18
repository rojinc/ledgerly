import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Persons, Transactions } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { EmailError } from '@ledgerly/server/email/send-email'
import {
  type EmailContent,
  shiftToConfirmEmail,
  timerRunningEmail,
} from '@ledgerly/server/email/templates'
import { AppwriteException, Query } from 'node-appwrite'
import { pages } from '../pages'
import { appBase, type Services } from '../services'

export type ReminderCounts = { sent: number; skipped: number; failed: number }

// scheduling.md#step-2-auto-post: shifts older than this wait for the user.
const FLOOR_DAYS = 7
const TIMER_HOURS = 12
// Nobody gets a reminder in the middle of the night.
const FIRST_HOUR = 7
const MS_PER_HOUR = 3_600_000

/**
 * Step 3 (scheduling.md#step-3-reminders): "shift to confirm" to the group owner and "timer
 * still running" to whoever started it. Bill reminders come with #33. Each reminder goes out
 * once (see `remind`).
 */
export async function sendReminders(services: Services): Promise<ReminderCounts> {
  const { db, now } = services
  const link = linkTo(services.appUrl)
  const counts: ReminderCounts = { sent: 0, skipped: 0, failed: 0 }
  // Read once per run. Groups are never deleted.
  const groups = memo((rowId) =>
    db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId }),
  )
  // `<groupId>/<personId>`: Appwrite IDs have no slash.
  const recipients = memo((key) => {
    const [groupId, personId] = key.split('/') as [string, string]
    return verifiedEmail(services, groupId, personId)
  })
  const utcToday = localToday('UTC', now)

  // idx_status_date. A shift must be before the group's local today, which is at most a day
  // after the UTC date, so later dates are never reminded yet.
  const shifts = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'scheduled'),
    Query.between('date', addDays(utcToday, -FLOOR_DAYS), utcToday),
    Query.equal('kind', 'shift'),
    Query.isNull('remindedAt'),
  ])
  for await (const shift of shifts) {
    await counted(counts, async () => {
      const group = await groups(shift.groupId)
      if (group.archivedAt) return remind(services, shift, undefined, counts)
      if (!isAwake(group, now) || compareDates(shift.date as LocalDate, today(group, now)) >= 0) {
        return
      }
      // Any shift still `scheduled`, auto-post ones too: step 2 runs first every hour from just
      // after local midnight, so by 07:00 an auto-post shift left here is one it couldn't post.
      const to = await recipients(`${group.$id}/${group.ownerPersonId}`)
      const content = shiftToConfirmEmail({
        groupName: group.name,
        date: shift.date as LocalDate,
        url: link(shift),
      })
      await remind(services, shift, to ? { to, content } : undefined, counts)
    })
  }

  // idx_status_date, on its status alone: there are few running timers.
  const timers = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'running'),
    Query.lessThan('startedAt', new Date(now.getTime() - TIMER_HOURS * MS_PER_HOUR).toISOString()),
    Query.isNull('remindedAt'),
  ])
  for await (const timer of timers) {
    await counted(counts, async () => {
      const group = await groups(timer.groupId)
      if (group.archivedAt) return remind(services, timer, undefined, counts)
      if (!isAwake(group, now)) return
      const to = await recipients(`${group.$id}/${timer.createdBy}`)
      const content = timerRunningEmail({
        groupName: group.name,
        startedAt: timer.startedAt as string,
        timeZone: group.timezone,
        url: link(timer),
      })
      await remind(services, timer, to ? { to, content } : undefined, counts)
    })
  }
  return counts
}

// A row that keeps failing mustn't hold up the rows after it: it counts as failed, and the
// next run tries it again.
async function counted(counts: ReminderCounts, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch {
    counts.failed += 1
  }
}

function today(group: Groups, now: Date): LocalDate {
  return localToday(group.timezone, now)
}

// Nobody gets a reminder before 07:00 in the group's timezone.
function isAwake(group: Groups, now: Date): boolean {
  return now.toISOString() >= localTimeToUtc(today(group, now), FIRST_HOUR, group.timezone)
}

function linkTo(appUrl: string): (row: Transactions) => string {
  const base = appBase(appUrl)
  return (row) => `${base}/groups/${row.groupId}/transactions/${row.$id}`
}

class Changed extends Error {}

/**
 * Sends the reminder for `seen` and sets its `remindedAt`, guarded as conventions.md#functions
 * says: `remindedAt` is staged first, then the stored row is checked, and the email goes out
 * before the commit. A row that changed before staging (posted, stopped, locked, reminded by
 * another run) gets nothing; one that changes after it fails the commit, and the next run
 * looks at it again. With no email (an archived group, or nobody to send to), `remindedAt` is
 * still set, so the row isn't read every hour.
 */
async function remind(
  { db, now, sendEmail }: Services,
  seen: Transactions,
  email: { to: string; content: EmailContent } | undefined,
  counts: ReminderCounts,
): Promise<void> {
  let outcome: keyof ReminderCounts | undefined
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.transactions,
        rowId: seen.$id,
        data: { remindedAt: now.toISOString() },
      })
      // The stored row, not this transaction's view, which already has the new remindedAt.
      const stored = await getOrUndefined<Transactions>(db, TABLES.transactions, seen.$id)
      if (!stillDue(seen, stored)) throw new Changed()
      if (!email) {
        outcome = 'skipped'
        return
      }
      try {
        // Resend delivers one email per key within 24 hours, so the next run's retry after a
        // failed commit isn't delivered twice.
        await sendEmail({ to: email.to, ...email.content, idempotencyKey: `reminder-${seen.$id}` })
        outcome = 'sent'
      } catch (error) {
        // An email Resend will never take is marked too, so it isn't tried every hour.
        if (!(error instanceof EmailError && NEVER_SENT.has(error.type))) throw error
        outcome = 'failed'
      }
    })
  } catch (error) {
    if (error instanceof Changed) return
    // The row changed or went away after staging: the next run looks at it again.
    const lost = error instanceof AppwriteException && (error.code === 404 || error.code === 409)
    if (!lost || outcome === undefined) throw error
  }
  if (outcome) counts[outcome] += 1
}

// Resend's errors for an email it will never send as asked: a bad address, or the same key
// with different content (the group was renamed after a send whose mark failed).
const NEVER_SENT: ReadonlySet<string> = new Set(['validation_error', 'invalid_idempotent_request'])

// It still needs the reminder the page read it for.
function stillDue(seen: Transactions, stored: Transactions | undefined): boolean {
  return (
    stored !== undefined &&
    stored.status === seen.status &&
    stored.statementId === null &&
    stored.remindedAt === null &&
    stored.date === seen.date &&
    stored.startedAt === seen.startedAt
  )
}

// Only to an active member with an account and a verified email (permissions.md#roles:
// placeholders get no reminders, and someone who left can't open the link).
async function verifiedEmail(
  { db, users }: Services,
  groupId: string,
  personId: string,
): Promise<string | undefined> {
  // uniq_group_person
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', groupId), Query.equal('personId', personId), Query.limit(1)],
    total: false,
  })
  if (rows[0]?.status !== 'active') return undefined
  const person = await getOrUndefined<Persons>(db, TABLES.persons, personId)
  if (!person?.userId) return undefined
  try {
    const user = await users.get({ userId: person.userId })
    return user.emailVerification && user.email ? user.email : undefined
  } catch (error) {
    // The account was deleted.
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}

async function getOrUndefined<R extends Persons | Transactions>(
  db: Db,
  tableId: string,
  rowId: string,
): Promise<R | undefined> {
  try {
    return await db.getRow<R>({ databaseId: DATABASE_ID, tableId, rowId })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}

function memo<T>(load: (rowId: string) => Promise<T>): (rowId: string) => Promise<T> {
  const loaded = new Map<string, Promise<T>>()
  return (rowId) => {
    let row = loaded.get(rowId)
    if (!row) {
      row = load(rowId)
      loaded.set(rowId, row)
    }
    return row
  }
}
