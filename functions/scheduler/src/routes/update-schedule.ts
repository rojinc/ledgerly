import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Schedules } from '@ledgerly/core/generated/rows'
import { scheduleInputSchema } from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { guardGroupAndMembers, ledgerRoute, loadLedger } from '@ledgerly/server/ledger/transactions'
import { generateOccurrences, guardSchedule, removeOccurrences } from '../occurrences'
import { parseBody } from '../parse-body'
import {
  checkTemplate,
  findSchedule,
  requireScheduleWriter,
  scheduleColumns,
} from '../schedule-rows'
import type { Services } from '../services'

export type UpdatedSchedule = { schedule: Schedules; created: number; removed: number }

/**
 * `scheduler PATCH /schedules/{id}` (scheduling.md#schedule-routes): replaces the schedule,
 * deletes its occurrences from today on that are still `scheduled` or `due` and not edited,
 * then expands it again. Earlier occurrences, and edited or posted ones, stay as they are. Its
 * group and kind never change.
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
    const changes = {
      ...scheduleColumns(input),
      // Expand again from today; dates before it that were never expanded still will be.
      generatedThrough: generated && compareDates(generated, yesterday) > 0 ? yesterday : generated,
    }
    const ledger = await loadLedger(db, membership)
    const people = checkTemplate({ ...schedule, ...changes }, ledger)
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, schedule, changes)
      // The people the new template names stay members while it exists (ledger.md#concurrency).
      await guardGroupAndMembers(tx, db, membership.group, ledger, people)
    })
    const removed = await removeOccurrences(db, scheduleId, today)
    const updated = (await findSchedule(db, scheduleId)) as Schedules
    const created = await generateOccurrences(db, updated, membership.group, ledger, now)
    return { schedule: (await findSchedule(db, scheduleId)) as Schedules, created, removed }
  })
}
