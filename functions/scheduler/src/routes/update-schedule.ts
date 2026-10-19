import { addDays } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Schedules } from '@ledgerly/core/generated/rows'
import { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { guardGroupAndMembers, ledgerRoute, loadLedger } from '@ledgerly/server/ledger/transactions'
import { generateOccurrences, guardSchedule } from '../occurrences'
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
 * `scheduler PATCH /schedules/{id}` (scheduling.md#schedule-routes): saves the new rule and
 * template, then expands from today, which updates, deletes or creates the occurrences that are
 * still `scheduled` or `due` and not edited. Earlier occurrences, and edited, voided or posted
 * ones, stay as they are. Its group and kind never change.
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
    const yesterday = addDays(localToday(membership.group.timezone, now), -1)
    const changes = {
      ...scheduleColumns(input),
      // Expand again from today, never before: nothing past is made, changed or deleted. Empty
      // stays empty, so a schedule that never expanded starts from startsOn, like a new one.
      generatedThrough: schedule.generatedThrough === null ? null : yesterday,
      // Due at once, so a cron run finishes the expansion if this request can't.
      nextRunAt: now.toISOString(),
    }
    const ledger = await loadLedger(db, membership)
    const people = checkTemplate({ ...schedule, ...changes }, ledger)
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, schedule, changes)
      // The people the new template names stay members while it exists (ledger.md#concurrency).
      await guardGroupAndMembers(tx, db, membership.group, ledger, people)
    })
    // The expansion brings the occurrences from today on in line with the new rule. One that
    // stops partway is finished by the next cron run.
    const { created, removed } = await generateOccurrences(
      db,
      await getSchedule(db, scheduleId),
      membership.group,
      ledger,
      now,
      changes.generatedThrough,
    )
    return { schedule: await getSchedule(db, scheduleId), created, removed }
  })
}
