import type { Schedules } from '@ledgerly/core/generated/rows'
import { type ScheduleResult, scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import {
  guardGroupAndMembers,
  ledgerRoute,
  loadLedger,
  teamRead,
} from '@ledgerly/server/ledger/transactions'
import { generateOccurrences } from '../occurrences'
import { parseBody } from '../parse-body'
import {
  checkTemplate,
  findSchedule,
  getSchedule,
  requireRecentStart,
  scheduleColumns,
} from '../schedule-rows'
import type { Services } from '../services'

/**
 * `scheduler POST /schedules` (functions-api.md#scheduler): creates the schedule, then its
 * occurrences up to the horizon at once, so the calendar fills in. Admins, and in a house
 * members too, for their own. A retry with the same content finishes the expansion and
 * returns the schedule; the same `id` with other content is `CONFLICT`.
 */
export async function createSchedule(
  services: Services,
  userId: string | null,
  body: unknown,
): Promise<ScheduleResult> {
  const { db, teams, now } = services
  const { id, groupId, ...input } = parseBody(scheduleInputSchema, body)
  // Set once this request has created the row, so a rerun after a delete doesn't create it again.
  let inserted = false
  return ledgerRoute(async () => {
    const membership = await requireMember(db, teams, userId, groupId, {
      roles: ['admin', 'member'],
    })
    if (membership.member.role !== 'admin' && membership.group.type !== 'house') {
      throw new AppError('FORBIDDEN', 'Only an admin can add a schedule to this group.')
    }
    const person = membership.person.$id
    const columns = scheduleColumns(input)
    const existing = await findSchedule(db, id)
    if (existing && !isRetry(existing, groupId, person, columns)) {
      throw new AppError('CONFLICT', 'A different schedule already has this id.')
    }
    if (!existing && inserted) throw new AppError('NOT_FOUND', 'This schedule was deleted.')
    const ledger = await loadLedger(db, membership)
    if (!existing) {
      requireRecentStart(input.startsOn, membership.group, now)
      // Due at once, so a cron run finishes the expansion if this request can't.
      const row = {
        groupId,
        ...columns,
        generatedThrough: null,
        nextRunAt: now.toISOString(),
        createdBy: person,
      }
      const people = checkTemplate({ $id: id, ...row }, ledger)
      await withTransaction(db, async (tx) => {
        // The people the template names stay members while it exists (ledger.md#concurrency).
        await guardGroupAndMembers(tx, db, membership.group, ledger, people)
        await tx.write({
          action: 'create',
          tableId: TABLES.schedules,
          rowId: id,
          data: row,
          permissions: teamRead(groupId),
        })
      })
      inserted = true
    }
    const schedule = await getSchedule(db, id)
    const { created } = await generateOccurrences(db, schedule, membership.group, ledger, now)
    return { schedule: await getSchedule(db, id), created }
  })
}

// The same request again: same group, creator and content.
function isRetry(
  existing: Schedules,
  groupId: string,
  person: string,
  columns: ReturnType<typeof scheduleColumns>,
): boolean {
  return (
    existing.groupId === groupId &&
    existing.createdBy === person &&
    Object.entries(columns).every(
      ([column, value]) =>
        JSON.stringify(existing[column as keyof typeof columns]) === JSON.stringify(value),
    )
  )
}
