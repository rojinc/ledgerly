import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Persons, Transactions } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { pages } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { logProblem } from '@ledgerly/server/http/log'
import { postInTransaction } from '@ledgerly/server/ledger/post'
import {
  findTransaction,
  isMergingRefusal,
  type Ledger,
  ledgerRoute,
  loadGroupLedger,
  Raced,
} from '@ledgerly/server/ledger/transactions'
import { Query } from 'node-appwrite'
import { madeLate } from '../occurrences'
import { findSchedule } from '../schedule-rows'
import type { Services } from '../services'

export type PostCounts = { posted: number; skipped: number; failed: number }

// Occurrences older than this wait for the user (scheduling.md#step-2-auto-post).
const FLOOR_DAYS = 7

/**
 * Step 2 (scheduling.md#step-2-auto-post): posts the occurrences of schedules that auto-post,
 * with the ledger's own post (`postInTransaction`): `scheduled` shifts once their day is over,
 * expenses and income on their day, and `due` bills (autopay) on their due date, dated then.
 * An occurrence a finalizing statement covers is skipped until a later run; one that fails (a
 * template a member change has broken, say) is counted and stays as it is.
 */
export async function autoPost(services: Services): Promise<PostCounts> {
  const counts: PostCounts = { posted: 0, skipped: 0, failed: 0 }
  const utcToday = localToday('UTC', services.now)
  // Some time zones are a day ahead of UTC.
  const window = [addDays(utcToday, -FLOOR_DAYS), addDays(utcToday, 1)] as const
  // idx_status_date
  const occurrences = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'scheduled'),
    Query.between('date', ...window),
    Query.isNotNull('scheduleId'),
    // Never posted, so not read every hour; post() checks it again.
    Query.isNull('remindedAt'),
  ])
  // idx_status_dueOn
  const bills = pages<Transactions>(services, TABLES.transactions, [
    Query.equal('status', 'due'),
    Query.between('dueOn', ...window),
    Query.isNotNull('scheduleId'),
  ])
  for (const rows of [occurrences, bills]) {
    for await (const { $id, groupId } of rows) {
      try {
        if (await post(services, $id)) counts.posted += 1
      } catch (error) {
        // A finalizing statement, or a merge still open in the group: a later run posts it.
        if ((error instanceof AppError && error.code === 'LOCKED') || isMergingRefusal(error)) {
          counts.skipped += 1
        } else {
          counts.failed += 1
          logProblem('auto_post_failed', { groupId, transactionId: $id, error })
        }
      }
    }
  }
  return counts
}

/**
 * Posts the occurrence if it is still due to be: still `scheduled` (a bill: `due`), its
 * schedule auto-posts and isn't waiting for step 1, its group isn't archived and its day has
 * come in the group's time zone. It posts as the schedule's creator, who pays when the
 * occurrence names no payers (not once they're no longer an active member), with no actor on
 * the activity row (data-model.md#activity); a bill is dated its due date. True when it posted.
 */
async function post({ db, now }: Services, rowId: string): Promise<boolean> {
  return ledgerRoute(async () => {
    // As it is now: a person, or a rerun after a race, may find it changed.
    const row = await findTransaction(db, rowId)
    if (!row?.scheduleId) return false
    const schedule = await findSchedule(db, row.scheduleId)
    if (!schedule?.autoPost) return false
    // Step 1 hasn't brought its occurrences in line with an edit yet (it ran out of time, or
    // failed): a later run posts them once it has.
    if (schedule.nextRunAt !== null && schedule.nextRunAt <= now.toISOString()) return false
    const group = await db.getRow<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      rowId: row.groupId,
    })
    if (group.archivedAt || !isDue(row, group, now) || forTheUser(row, group)) return false
    const ledger = await loadGroupLedger(db, group, schedule.createdBy)
    if (await creatorWouldPayAfterLeaving(db, row, ledger, schedule.createdBy)) return false
    await withTransaction(db, async (tx) => {
      await postInTransaction(tx, db, {
        rowId,
        group,
        ledger,
        actorPersonId: null,
        updatedBy: schedule.createdBy,
        changes: row.kind === 'bill' ? { date: row.dueOn as LocalDate } : {},
        now,
        // Moved, posted or voided since it was read: run again, which reads it again.
        ready: (staged) =>
          isDue(staged, group, now) && !forTheUser(staged, group) && staged.dueOn === row.dueOn,
      })
      // Again now that the row and the creator's member row (they pay, so they're named) are
      // staged: an edit that dropped its payers, or the creator moving out, since the check
      // above makes it run again, and the check above then leaves it.
      const stored = await findTransaction(db, rowId)
      if (stored && (await creatorWouldPayAfterLeaving(db, stored, ledger, schedule.createdBy))) {
        throw new Raced()
      }
    })
    return true
  })
}

// The creator pays an expense or bill whose input names no payers (build-shares.ts), but not
// once they're no longer an active member of the group, or have deleted their account (before the
// deletion reaches this group): it waits for someone to confirm it (scheduling.md#step-2-auto-post).
// Step 3 asks the same before an email promises autopay.
export async function creatorWouldPayAfterLeaving(
  db: Db,
  row: Transactions,
  ledger: Ledger,
  creator: string,
): Promise<boolean> {
  if (row.kind !== 'expense' && row.kind !== 'bill') return false
  if ((JSON.parse(row.inputJson) as { payers?: unknown }).payers !== undefined) return false
  const memberRow = ledger.memberRows.get(creator)
  const member = memberRow
    ? await db.getRow<Members>({
        databaseId: DATABASE_ID,
        tableId: TABLES.members,
        rowId: memberRow,
      })
    : undefined
  if (member?.status !== 'active') return true
  const person = await db.getRow<Persons>({
    databaseId: DATABASE_ID,
    tableId: TABLES.persons,
    rowId: creator,
  })
  return Boolean(person.deletedAt)
}

// Left for the user (scheduling.md#step-2-auto-post): made after its own day (a bill: its due
// date), or a `scheduled` one already reminded to confirm it (step 3), also when `autoPost` is
// turned on later. A bill's "due soon" reminder doesn't hold its autopay.
function forTheUser(row: Transactions, group: Groups): boolean {
  return madeLate(row, group.timezone) || (row.status === 'scheduled' && row.remindedAt !== null)
}

// Its day has come in the group's time zone: a `scheduled` shift's once it's over, an expense's
// or income's on the day, and a `due` bill's on its due date.
function isDue(row: Transactions, group: Groups, now: Date): boolean {
  const today = localToday(group.timezone, now)
  if (row.kind === 'bill') {
    return row.status === 'due' && !!row.dueOn && compareDates(row.dueOn as LocalDate, today) <= 0
  }
  if (row.status !== 'scheduled') return false
  const day = compareDates(row.date as LocalDate, today)
  return row.kind === 'shift' ? day < 0 : day <= 0
}
