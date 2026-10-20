import { compareDates } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { type PausedSchedule, pauseScheduleBodySchema } from '@ledgerly/core/schemas/scheduler'
import { AppError } from '@ledgerly/server/http/app-error'
import { ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { pauseScheduleFrom } from '@ledgerly/server/scheduler/end-schedule'
import { parseBody } from '../parse-body'
import { getSchedule, requireScheduleWriter } from '../schedule-rows'
import type { Services } from '../services'

/**
 * `scheduler POST /schedules/{id}/pause` (scheduling.md#schedule-routes): sets `pausedFrom` and
 * deletes the occurrences from it on that are still `scheduled` or `due` and not edited, as an
 * end on the day before does, but it keeps `endsOn`. Pausing again moves the date. It never
 * plans the template, so a schedule can always be paused.
 */
export async function pauseSchedule(
  services: Services,
  userId: string | null,
  scheduleId: string,
  body: unknown,
): Promise<PausedSchedule> {
  const { db, now } = services
  const { pausedFrom } = parseBody(pauseScheduleBodySchema, body)
  return ledgerRoute(async () => {
    const { schedule, membership } = await requireScheduleWriter(services, userId, scheduleId)
    if (compareDates(pausedFrom, localToday(membership.group.timezone, now)) < 0) {
      throw new AppError('VALIDATION_FAILED', 'pausedFrom must not be before today.')
    }
    // An archive that lands meanwhile makes this run again and get ARCHIVED.
    const removed = await pauseScheduleFrom(db, membership.group, schedule, pausedFrom, now)
    return { schedule: await getSchedule(db, scheduleId), removed }
  })
}
