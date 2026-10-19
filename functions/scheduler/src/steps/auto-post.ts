import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { postInTransaction } from '@ledgerly/server/ledger/post'
import { findTransaction, ledgerRoute, loadGroupLedger } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'
import { pages } from '../pages'
import { findSchedule } from '../schedule-rows'
import type { Services } from '../services'

export type PostCounts = { posted: number; skipped: number; failed: number }

// Occurrences older than this wait for the user (scheduling.md#step-2-auto-post).
const FLOOR_DAYS = 7

/**
 * Step 2 (scheduling.md#step-2-auto-post): posts the `scheduled` occurrences of schedules that
 * auto-post, with the ledger's own post (`postInTransaction`): shifts once their day is over,
 * expenses and income on their day. Bills come with #33. An occurrence a finalizing statement
 * covers is skipped until a later run; one that fails (a template a member change has broken,
 * say) is counted and stays `scheduled`.
 */
export async function autoPost(services: Services): Promise<PostCounts> {
  const counts: PostCounts = { posted: 0, skipped: 0, failed: 0 }
  const utcToday = localToday('UTC', services.now)
  // idx_status_date. Some time zones are a day ahead of UTC.
  const occurrences = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'scheduled'),
    Query.between('date', addDays(utcToday, -FLOOR_DAYS), addDays(utcToday, 1)),
    Query.isNotNull('scheduleId'),
  ])
  for await (const { $id } of occurrences) {
    try {
      if (await post(services, $id)) counts.posted += 1
    } catch (error) {
      if (error instanceof AppError && error.code === 'LOCKED') {
        counts.skipped += 1
      } else {
        counts.failed += 1
        console.error(`scheduler: auto-post failed for transaction ${$id}: ${describe(error)}`)
      }
    }
  }
  return counts
}

/**
 * Posts the occurrence if it is still due to be: still `scheduled`, its schedule auto-posts,
 * its group isn't archived and its day has come in the group's time zone. It posts as the
 * schedule's creator, who pays when the template names no payers, with no actor on the
 * activity row (data-model.md#activity). True when it posted.
 */
async function post({ db, now }: Services, rowId: string): Promise<boolean> {
  return ledgerRoute(async () => {
    // As it is now: a person, or a rerun after a race, may find it changed.
    const row = await findTransaction(db, rowId)
    if (!row?.scheduleId) return false
    const schedule = await findSchedule(db, row.scheduleId)
    if (!schedule?.autoPost) return false
    const group = await db.getRow<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      rowId: row.groupId,
    })
    if (group.archivedAt || !isDue(row, group, now)) return false
    const ledger = await loadGroupLedger(db, group, schedule.createdBy)
    await withTransaction(db, (tx) =>
      postInTransaction(tx, db, {
        rowId,
        group,
        ledger,
        actorPersonId: null,
        updatedBy: schedule.createdBy,
        changes: {},
        now,
        // Moved, posted or voided since it was read: run again, which reads it again.
        ready: (staged) => isDue(staged, group, now),
      }),
    )
    return true
  })
}

// Still `scheduled`, and its day has come in the group's time zone: a shift's once it's over,
// an expense's or income's on the day.
function isDue(row: Transactions, group: Groups, now: Date): boolean {
  if (row.status !== 'scheduled') return false
  const day = compareDates(row.date as LocalDate, localToday(group.timezone, now))
  return row.kind === 'shift' ? day < 0 : day <= 0
}

// An error's name and code, never its message, which can quote stored text
// (security-and-privacy.md).
function describe(error: unknown): string {
  if (error instanceof AppError) return `AppError ${error.code}`
  if (error instanceof AppwriteException) return `AppwriteException ${error.code} ${error.type}`
  return error instanceof Error ? error.name : typeof error
}
