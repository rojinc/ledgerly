import { addDays } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { scheduleInputSchema, type UpdatedSchedule } from '@ledgerly/core/schemas/scheduler'
import { AppError } from '@ledgerly/server/http/app-error'
import { ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { generateOccurrences } from '../occurrences'
import { parseBody } from '../parse-body'
import {
  getSchedule,
  requireRecentStart,
  requireScheduleWriter,
  saveToExpand,
  scheduleColumns,
} from '../schedule-rows'
import type { Services } from '../services'

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
    if (input.startsOn !== schedule.startsOn) {
      requireRecentStart(input.startsOn, membership.group, now)
    }
    const today = localToday(membership.group.timezone, now)
    const yesterday = addDays(today, -1)
    const changes = {
      ...scheduleColumns(input),
      // Expand again from today, never before: nothing past is made, changed or deleted. Empty
      // stays empty, so a schedule that never expanded starts from startsOn, like a new one.
      generatedThrough: schedule.generatedThrough === null ? null : yesterday,
      // Due at once, so a cron run finishes the expansion if this request can't.
      nextRunAt: now.toISOString(),
    }
    const ledger = await saveToExpand(db, membership, schedule, changes, today)
    // The expansion brings the occurrences from today on in line with the new rule. One that
    // stops partway is finished by the next cron run.
    const expansion = await generateOccurrences(
      db,
      await getSchedule(db, scheduleId),
      membership.group,
      ledger,
      now,
      changes.generatedThrough,
    )
    return { schedule: await getSchedule(db, scheduleId), ...expansion }
  })
}
