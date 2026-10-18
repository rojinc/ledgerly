import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import type {
  Groups,
  Members,
  Persons,
  Schedules,
  Transactions,
} from '@ledgerly/core/generated/rows'
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
import type { Services } from '../services'

export type ReminderCounts = { sent: number; skipped: number; failed: number }

const PAGE = 100
// scheduling.md#step-2-auto-post: shifts older than this wait for the user.
const FLOOR_DAYS = 7
const TIMER_HOURS = 12
// Nobody gets a reminder in the middle of the night.
const FIRST_HOUR = 7
const MS_PER_HOUR = 3_600_000

/**
 * Step 3 (scheduling.md#step-3-reminders): "shift to confirm" to the group owner and "timer
 * still running" to whoever started it. Bill reminders come with #33. Each reminder goes out
 * once: it is sent with an idempotency key, then `remindedAt` is set.
 */
export async function sendReminders(services: Services): Promise<ReminderCounts> {
  const { db, now } = services
  const counts: ReminderCounts = { sent: 0, skipped: 0, failed: 0 }
  // Read once per run. Groups are never deleted; schedules can be.
  const groups = memo((rowId) =>
    db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId }),
  )
  const schedules = memo((rowId) => getOrUndefined<Schedules>(db, TABLES.schedules, rowId))
  const utcToday = localToday('UTC', now)

  // idx_status_date. Some timezones are a day ahead of UTC.
  const shifts = pages<Transactions>(services, [
    Query.equal('status', 'scheduled'),
    Query.between('date', addDays(utcToday, -FLOOR_DAYS), addDays(utcToday, 1)),
    Query.equal('kind', 'shift'),
    Query.isNull('remindedAt'),
  ])
  for await (const shift of shifts) {
    const group = await groups(shift.groupId)
    if (!isAwake(group, now) || compareDates(shift.date as LocalDate, today(group, now)) >= 0) {
      continue
    }
    // Step 2 posts the shifts of schedules that auto-post.
    const schedule = shift.scheduleId ? await schedules(shift.scheduleId) : undefined
    if (schedule?.autoPost) continue
    const content = shiftToConfirmEmail({
      groupName: group.name,
      date: shift.date as LocalDate,
      url: link(services, shift),
    })
    await remind(services, shift, group, group.ownerPersonId, content, counts)
  }

  // idx_status_date, on its status alone: there are few running timers.
  const timers = pages<Transactions>(services, [
    Query.equal('status', 'running'),
    Query.lessThan('startedAt', new Date(now.getTime() - TIMER_HOURS * MS_PER_HOUR).toISOString()),
    Query.isNull('remindedAt'),
  ])
  for await (const timer of timers) {
    const group = await groups(timer.groupId)
    if (!isAwake(group, now)) continue
    const content = timerRunningEmail({
      groupName: group.name,
      startedAt: timer.startedAt as string,
      timeZone: group.timezone,
      url: link(services, timer),
    })
    await remind(services, timer, group, timer.createdBy, content, counts)
  }
  return counts
}

function today(group: Groups, now: Date): LocalDate {
  return localToday(group.timezone, now)
}

// Archived groups get no reminders, and nobody gets one before 07:00 in the group's timezone.
function isAwake(group: Groups, now: Date): boolean {
  if (group.archivedAt) return false
  return now.toISOString() >= localTimeToUtc(today(group, now), FIRST_HOUR, group.timezone)
}

function link({ appUrl }: Services, row: Transactions): string {
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error('APP_URL is not set. Add it as an Appwrite project variable.')
  }
  return `${appUrl.replace(/\/+$/, '')}/groups/${row.groupId}/transactions/${row.$id}`
}

async function remind(
  services: Services,
  row: Transactions,
  group: Groups,
  personId: string,
  content: EmailContent,
  counts: ReminderCounts,
): Promise<void> {
  const to = await verifiedEmail(services, group, personId)
  if (to) {
    try {
      // Resend sends one email per key within 24 hours, so if setting remindedAt below
      // fails, the next run's retry isn't delivered twice.
      await services.sendEmail({ to, ...content, idempotencyKey: `reminder-${row.$id}` })
    } catch (error) {
      if (!(error instanceof EmailError)) throw error
      // remindedAt stays empty, so the next run tries again.
      counts.failed += 1
      return
    }
  }
  // Also with nobody to send to, so the row isn't read again every hour.
  await markReminded(services.db, row.$id, services.now)
  if (to) counts.sent += 1
  else counts.skipped += 1
}

// Only to a joined member with an account and a verified email (permissions.md#roles:
// placeholders get no reminders).
async function verifiedEmail(
  { db, users }: Services,
  group: Groups,
  personId: string,
): Promise<string | undefined> {
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', group.$id), Query.equal('personId', personId), Query.limit(1)],
    total: false,
  })
  if (!rows[0] || rows[0].status === 'placeholder') return undefined
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

async function markReminded(db: Db, rowId: string, now: Date): Promise<void> {
  try {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'update',
        tableId: TABLES.transactions,
        rowId,
        data: { remindedAt: now.toISOString() },
      }),
    )
  } catch (error) {
    // Deleted or changed meanwhile: the next run looks at it again, and the idempotency key
    // keeps a resent reminder from being delivered twice.
    if (error instanceof AppwriteException && (error.code === 404 || error.code === 409)) return
    throw error
  }
}

/**
 * Every matching transaction, a page of PAGE at a time, until the run's time budget is used
 * up. Pages follow `$id`, not a cursor row: a row this step has just updated may no longer
 * match, and a cursor has to.
 */
async function* pages<R extends Transactions>(
  { db, outOfTime }: Services,
  queries: string[],
): AsyncGenerator<R> {
  let after: string | undefined
  while (!outOfTime()) {
    const { rows } = await db.listRows<R>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      queries: [
        ...queries,
        ...(after === undefined ? [] : [Query.greaterThan('$id', after)]),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
      ],
      total: false,
    })
    yield* rows
    if (rows.length < PAGE) return
    after = rows[rows.length - 1]?.$id
  }
}

async function getOrUndefined<R extends Persons | Schedules>(
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
