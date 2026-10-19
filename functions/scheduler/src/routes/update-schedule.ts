import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Schedules } from '@ledgerly/core/generated/rows'
import { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import {
  guardGroup,
  guardGroupAndMembers,
  ledgerRoute,
  loadLedger,
} from '@ledgerly/server/ledger/transactions'
import { generateOccurrences, guardSchedule, removeOccurrences } from '../occurrences'
import { parseBody } from '../parse-body'
import {
  checkTemplate,
  getSchedule,
  requireScheduleWriter,
  scheduleColumns,
} from '../schedule-rows'
import type { Services } from '../services'

export type UpdatedSchedule = { schedule: Schedules; created: number; removed: number }

/**
 * `scheduler PATCH /schedules/{id}` (scheduling.md#schedule-routes): deletes the schedule's
 * occurrences from today on that are still `scheduled` or `due` and not edited, then saves the
 * new rule and template and expands it again. Earlier occurrences, and edited or posted ones,
 * stay as they are. Its group and kind never change.
 */
export async function updateSchedule(
  services: Services,
  userId: string | null,
  scheduleId: string,
  body: unknown,
): Promise<UpdatedSchedule> {
  const { db, now } = services
  const { id, groupId, ...input } = parseBody(scheduleInputSchema, body)
  if (id !== scheduleId) {
    throw new AppError('VALIDATION_FAILED', 'The id in the body must match the path.')
  }
  return ledgerRoute(async () => {
    const { schedule, membership } = await requireScheduleWriter(services, userId, scheduleId)
    if (groupId !== schedule.groupId || input.kind !== schedule.kind) {
      throw new AppError(
        'VALIDATION_FAILED',
        "A schedule's group and kind can't change. End it and add a new one.",
      )
    }
    const today = localToday(membership.group.timezone, now)
    const yesterday = addDays(today, -1)
    const generated = schedule.generatedThrough as LocalDate | null
    // Expand again from today; dates before it that were never expanded still will be. Due at
    // once, so a cron run finishes the expansion if this request can't.
    const reset = {
      generatedThrough: generated && compareDates(generated, yesterday) > 0 ? yesterday : generated,
      nextRunAt: now.toISOString(),
    }
    const changes = { ...scheduleColumns(input), ...reset }
    const ledger = await loadLedger(db, membership)
    const people = checkTemplate({ ...schedule, ...changes }, ledger)
    // The old rule's future occurrences go first, and only then is the new rule saved. An edit
    // that stops before then leaves the old rule as it was, and the next cron run makes again
    // any of its occurrences that were deleted.
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, schedule, reset)
      await guardGroup(tx, db, membership.group)
    })
    // As stored: the guard compares with this, and Appwrite returns datetimes in its own form.
    const reverted = await getSchedule(db, scheduleId)
    const removed = await removeOccurrences(db, membership.group, scheduleId, today)
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, reverted, changes)
      // The people the new template names stay members while it exists (ledger.md#concurrency).
      await guardGroupAndMembers(tx, db, membership.group, ledger, people)
    })
    const updated = await getSchedule(db, scheduleId)
    const created = await generateOccurrences(
      db,
      updated,
      membership.group,
      ledger,
      now,
      changes.generatedThrough,
    )
    return { schedule: await getSchedule(db, scheduleId), created, removed }
  })
}
