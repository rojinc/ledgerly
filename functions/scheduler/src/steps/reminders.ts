import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type {
  Groups,
  Members,
  Persons,
  Profiles,
  Transactions,
} from '@ledgerly/core/generated/rows'
import type { EmailType } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { pages } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { EmailError } from '@ledgerly/server/email/send-email'
import {
  billDueSoonEmail,
  type EmailContent,
  shiftToConfirmEmail,
  timerRunningEmail,
} from '@ledgerly/server/email/templates'
import { logProblem } from '@ledgerly/server/http/log'
import { loadGroupLedger } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'
import { findSchedule } from '../schedule-rows'
import { type AccountUser, appBase, type Services } from '../services'
import { creatorWouldPayAfterLeaving } from './auto-post'

export type ReminderCounts = { sent: number; skipped: number; failed: number }

// scheduling.md#step-2-auto-post: shifts older than this wait for the user.
const FLOOR_DAYS = 7
const TIMER_HOURS = 12
// Nobody gets a reminder in the middle of the night.
const FIRST_HOUR = 7
const MS_PER_HOUR = 3_600_000
// A bill is reminded from this many days before its due date.
const BILL_DAYS = 2

/** One email of a reminder; Resend delivers one per `key` within 24 hours. */
type Outgoing = { to: string; content: EmailContent; key: string }
/** A verified address, and the emails its person turned off on Profile (null or `[]`: none). */
type Recipient = { to: string; optOuts: string[] | null }

/**
 * Step 3 (scheduling.md#step-3-reminders): "shift to confirm" to the group owner, "timer still
 * running" to whoever started it, and "bill due soon" to each joined admin. Each reminder goes
 * out once (see `remind`).
 */
export async function sendReminders(services: Services): Promise<ReminderCounts> {
  const { db, now } = services
  const link = linkTo(services.appUrl)
  // Where the bill-due and shift-to-confirm emails can be turned off (#431).
  const profileUrl = `${appBase(services.appUrl)}/profile`
  const counts: ReminderCounts = { sent: 0, skipped: 0, failed: 0 }
  // Read once per run. Groups are never deleted.
  const groups = memo((rowId) =>
    db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId }),
  )
  const schedules = memo((rowId) => findSchedule(db, rowId))
  // `<groupId>/<personId>`: Appwrite IDs have no slash.
  const recipients = memo((key) => {
    const [groupId, personId] = key.split('/') as [string, string]
    return verifiedEmail(services, groupId, personId)
  })
  const admins = memo((groupId) => adminEmails(services, groupId))
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
    await counted(counts, shift, async () => {
      const group = await groups(shift.groupId)
      if (group.archivedAt) return remind(services, shift, [], counts)
      if (!isAwake(group, now) || compareDates(shift.date as LocalDate, today(group, now)) >= 0) {
        return
      }
      // Any shift still `scheduled`, auto-post ones too: step 2 runs first every hour from just
      // after local midnight, so by 07:00 an auto-post shift left here is one it couldn't post.
      const owner = await recipients(`${group.$id}/${group.ownerPersonId}`)
      // An owner who turned this email off counts as nobody to ask.
      const to = owner && wants(owner, 'shiftToConfirm') ? owner.to : undefined
      // Nobody to ask: a shift of a schedule that auto-posts isn't marked, so step 2 keeps trying
      // it. Step 2 never posts a marked row, so marking it would leave it `scheduled` for good.
      if (!to && shift.scheduleId && (await schedules(shift.scheduleId))?.autoPost) return
      const content = shiftToConfirmEmail({
        groupName: group.name,
        date: shift.date as LocalDate,
        url: link(shift),
        profileUrl,
      })
      await remind(
        services,
        shift,
        to ? [{ to, content, key: `reminder-${shift.$id}-${shift.date}` }] : [],
        counts,
      )
    })
  }

  // idx_status_date, on its status alone: there are few running timers.
  const timers = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'running'),
    Query.lessThan('startedAt', new Date(now.getTime() - TIMER_HOURS * MS_PER_HOUR).toISOString()),
    Query.isNull('remindedAt'),
  ])
  for await (const timer of timers) {
    await counted(counts, timer, async () => {
      const group = await groups(timer.groupId)
      if (group.archivedAt) return remind(services, timer, [], counts)
      if (!isAwake(group, now)) return
      // No opt-out: the timer email is always sent (#431).
      const to = (await recipients(`${group.$id}/${timer.createdBy}`))?.to
      const content = timerRunningEmail({
        groupName: group.name,
        startedAt: timer.startedAt as string,
        timeZone: group.timezone,
        url: link(timer),
      })
      await remind(
        services,
        timer,
        to ? [{ to, content, key: `reminder-${timer.$id}-${timer.date}` }] : [],
        counts,
      )
    })
  }

  // idx_status_dueOn. The group's local today is at most a day either side of the UTC date.
  const bills = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'due'),
    Query.between('dueOn', addDays(utcToday, -1), addDays(utcToday, BILL_DAYS + 1)),
    Query.isNull('remindedAt'),
  ])
  for await (const bill of bills) {
    await counted(counts, bill, async () => {
      const group = await groups(bill.groupId)
      if (group.archivedAt) return remind(services, bill, [], counts)
      const local = today(group, now)
      const dueOn = bill.dueOn as LocalDate
      const soon =
        compareDates(dueOn, local) >= 0 && compareDates(dueOn, addDays(local, BILL_DAYS)) <= 0
      if (!isAwake(group, now) || !soon) return
      // Step 2 posts the bills of schedules that auto-post, on their due date. One due today is
      // still due here only if step 2, earlier in this run, left it (its creator has moved out, a
      // statement is being finalized, or the post failed), and step 2 will leave one its creator
      // would pay after leaving, so those ask to mark it paid.
      const schedule = bill.scheduleId ? await schedules(bill.scheduleId) : undefined
      const autoPay =
        schedule?.autoPost === true &&
        compareDates(dueOn, local) > 0 &&
        !(await creatorWouldPayAfterLeaving(
          services.db,
          bill,
          await loadGroupLedger(services.db, group, schedule.createdBy),
          schedule.createdBy,
        ))
      const content = billDueSoonEmail({
        groupName: group.name,
        description: bill.description,
        amountCents: bill.totalCents,
        currency: group.currency,
        dueOn,
        autoPay,
        url: link(bill),
        profileUrl,
      })
      // A new due date needs its own reminder, so it's in the key.
      const emails = (await admins(group.$id))
        .filter((admin) => wants(admin, 'billDue'))
        .map(({ personId, to }) => ({
          to,
          content,
          key: `reminder-${bill.$id}-${dueOn}-${personId}`,
        }))
      await remind(services, bill, emails, counts)
    })
  }
  return counts
}

// A row that keeps failing mustn't hold up the rows after it: it counts as failed, is logged
// (IDs and the error's name only), and the next run tries it again.
async function counted(
  counts: ReminderCounts,
  row: Transactions,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work()
  } catch (error) {
    counts.failed += 1
    logProblem('reminder_failed', { groupId: row.groupId, transactionId: row.$id, error })
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
 * Sends the reminder's `emails` for `seen` and sets its `remindedAt`, guarded as
 * conventions.md#functions says: `remindedAt` is staged first, then the stored row is checked,
 * and the emails go out before the commit. A row that changed before staging (posted, stopped,
 * locked, reminded by another run, given a new due date) gets nothing; one that changes after
 * it fails the commit, and the next run looks at it again. With no email (an archived group,
 * or nobody to send to), `remindedAt` is still set, so the row isn't read every hour.
 */
async function remind(
  { db, now, sendEmail }: Services,
  seen: Transactions,
  emails: Outgoing[],
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
      if (emails.length === 0) {
        outcome = 'skipped'
        return
      }
      let sent = 0
      for (const email of emails) {
        try {
          // Resend delivers one email per key within 24 hours, so the next run's retry after a
          // failed commit, or after another recipient's failed send, isn't delivered twice.
          await sendEmail({ to: email.to, ...email.content, idempotencyKey: email.key })
          sent += 1
        } catch (error) {
          // An email Resend will never take is marked too, so it isn't tried every hour.
          if (!(error instanceof EmailError && NEVER_SENT.has(error.type))) throw error
        }
      }
      outcome = sent > 0 ? 'sent' : 'failed'
    })
  } catch (error) {
    if (error instanceof Changed) return
    const lost = error instanceof AppwriteException && (error.code === 404 || error.code === 409)
    // With no outcome yet, only a 409 is a row that went away (withTransaction reports a gone
    // row's 404 as one): any other 404, such as an expired transaction, counts as failed.
    if (!lost || (outcome === undefined && error.code !== 409)) throw error
    // Deleted before `remindedAt` was staged (a 409 there): like a row that changed, it gets
    // nothing. One that changed or went away after staging: the next run looks at it again.
    if (outcome === undefined) return
  }
  if (outcome) counts[outcome] += 1
}

// Resend's errors for an email it will never send as asked: a bad address, or the same key
// with different content (the group was renamed after a send whose mark failed).
export const NEVER_SENT: ReadonlySet<string> = new Set([
  'validation_error',
  'invalid_idempotent_request',
])

// It still needs the reminder the page read it for.
function stillDue(seen: Transactions, stored: Transactions | undefined): boolean {
  return (
    stored !== undefined &&
    stored.status === seen.status &&
    stored.statementId === null &&
    stored.remindedAt === null &&
    stored.date === seen.date &&
    stored.dueOn === seen.dueOn &&
    stored.startedAt === seen.startedAt &&
    // The email shows these: an edit meanwhile waits for the next run's email.
    stored.description === seen.description &&
    stored.totalCents === seen.totalCents
  )
}

// Only to an active member with an account and a verified email (permissions.md#roles:
// placeholders get no reminders, and someone who left can't open the link).
async function verifiedEmail(
  services: Services,
  groupId: string,
  personId: string,
): Promise<Recipient | undefined> {
  // uniq_group_person
  const { rows } = await services.db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', groupId), Query.equal('personId', personId), Query.limit(1)],
    total: false,
  })
  return rows[0]?.status === 'active' ? accountEmail(services, personId) : undefined
}

// The joined admins of the group with a verified email (in a personal group, the owner).
async function adminEmails(
  services: Services,
  groupId: string,
): Promise<({ personId: string } & Recipient)[]> {
  // idx_groupId. A group has at most 15 people.
  const { rows } = await services.db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('role', 'admin'),
      Query.equal('status', 'active'),
      Query.limit(100),
    ],
    total: false,
  })
  const found: ({ personId: string } & Recipient)[] = []
  for (const { personId } of rows) {
    const recipient = await accountEmail(services, personId)
    if (recipient) found.push({ personId, ...recipient })
  }
  return found
}

// The person's account email, once it's verified, and the emails they turned off.
async function accountEmail(
  { db, users }: Services,
  personId: string,
): Promise<Recipient | undefined> {
  const person = await getOrUndefined<Persons>(db, TABLES.persons, personId)
  if (!person?.userId) return undefined
  let user: AccountUser
  try {
    user = await users.get({ userId: person.userId })
  } catch (error) {
    // The account was deleted.
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
  // Not once the account is blocked: deleting it blocks it first (identity-and-invites.md#order).
  if (!(user.status && user.emailVerification && user.email)) return undefined
  // Its row ID is the user ID. Read before staging, so a change during the run may let one
  // email through (#431).
  const profile = await getOrUndefined<Profiles>(db, TABLES.profiles, person.userId)
  return { to: user.email, optOuts: profile?.emailOptOuts ?? null }
}

// Unless they turned this email off on Profile.
function wants({ optOuts }: Recipient, type: EmailType): boolean {
  return !optOuts?.includes(type)
}

async function getOrUndefined<R extends Persons | Profiles | Transactions>(
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
