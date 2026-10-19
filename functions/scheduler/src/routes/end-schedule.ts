import { compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { type EndedSchedule, endScheduleBodySchema } from '@ledgerly/core/schemas/scheduler'
import { AppError } from '@ledgerly/server/http/app-error'
import { ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { endScheduleOn } from '@ledgerly/server/scheduler/end-schedule'
import { parseBody } from '../parse-body'
import { getSchedule, requireScheduleWriter } from '../schedule-rows'
import type { Services } from '../services'

/**
 * `scheduler POST /schedules/{id}/end` (scheduling.md#schedule-routes): sets `endsOn` and
 * deletes the future occurrences after it that are still `scheduled` or `due` and not edited. It
 * never plans the template, so a schedule can always be ended. It is due at once, so the next
 * cron run deletes whatever this request didn't get to (a timeout, say), or carries on up to a
 * later `endsOn` than before.
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
    // An archive that lands meanwhile makes this run again and get ARCHIVED.
    const removed = await endScheduleOn(db, membership.group, schedule, endsOn, now)
    return { schedule: await getSchedule(db, scheduleId), removed }
  })
}
