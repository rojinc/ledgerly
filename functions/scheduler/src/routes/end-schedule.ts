import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import type { Schedules } from '@ledgerly/core/generated/rows'
import { endScheduleBodySchema } from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { guardGroup, ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { guardSchedule, removeOccurrences } from '../occurrences'
import { parseBody } from '../parse-body'
import { getSchedule, requireScheduleWriter } from '../schedule-rows'
import type { Services } from '../services'

export type EndedSchedule = { schedule: Schedules; removed: number }

/**
 * `scheduler POST /schedules/{id}/end` (scheduling.md#schedule-routes): sets `endsOn` and
 * deletes the occurrences after it that are still `scheduled` or `due` and not edited. It
 * never plans the template, so a schedule can always be ended. A later `endsOn` than before
 * lets the next cron run carry on up to it.
 */
export async function endSchedule(
  services: Services,
  userId: string | null,
  scheduleId: string,
  body: unknown,
): Promise<EndedSchedule> {
  const { db, now } = services
  const { endsOn } = parseBody(endScheduleBodySchema, body)
  return ledgerRoute(async () => {
    const { schedule, membership } = await requireScheduleWriter(services, userId, scheduleId)
    if (compareDates(endsOn, schedule.startsOn as LocalDate) < 0) {
      throw new AppError('VALIDATION_FAILED', 'endsOn must not be before startsOn.')
    }
    const generated = schedule.generatedThrough as LocalDate | null
    const done = generated !== null && compareDates(generated, endsOn) >= 0
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, schedule, {
        endsOn,
        generatedThrough: done ? endsOn : generated,
        nextRunAt: done ? null : (schedule.nextRunAt ?? now.toISOString()),
      })
      // An archive that lands meanwhile makes this run again and get ARCHIVED.
      await guardGroup(tx, db, membership.group)
    })
    const removed = await removeOccurrences(db, membership.group, scheduleId, addDays(endsOn, 1))
    return { schedule: await getSchedule(db, scheduleId), removed }
  })
}
