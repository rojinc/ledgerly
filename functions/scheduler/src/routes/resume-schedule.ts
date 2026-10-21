import { addDays } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import type { ResumedSchedule } from '@ledgerly/core/schemas/scheduler'
import { ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { generateOccurrences } from '../occurrences'
import { parseBody } from '../parse-body'
import { getSchedule, requireScheduleWriter, saveToExpand } from '../schedule-rows'
import type { Services } from '../services'

/**
 * `scheduler POST /schedules/{id}/resume` (scheduling.md#schedule-routes): clears `pausedFrom`
 * and expands from today, so the occurrences from today on are made again, and none on the
 * dates the pause skipped. It could start the schedule again, so it checks the stored template
 * as `PATCH` does. A schedule that isn't paused is left as it is.
 */
export async function resumeSchedule(
  services: Services,
  userId: string | null,
  scheduleId: string,
  body: unknown,
): Promise<ResumedSchedule> {
  const { db, now } = services
  parseBody(emptyBodySchema, body ?? {})
  return ledgerRoute(async () => {
    const { schedule, membership } = await requireScheduleWriter(services, userId, scheduleId)
    if (!schedule.pausedFrom) return { schedule, created: 0 }
    const today = localToday(membership.group.timezone, now)
    const changes = {
      pausedFrom: null,
      // From today, never before: the dates the pause skipped stay empty. Empty stays empty, so
      // a schedule that never expanded starts from startsOn.
      generatedThrough: schedule.generatedThrough === null ? null : addDays(today, -1),
      // Due at once, so a cron run finishes the expansion if this request can't.
      nextRunAt: now.toISOString(),
    }
    const ledger = await saveToExpand(db, membership, schedule, changes, today)
    const { created } = await generateOccurrences(
      db,
      await getSchedule(db, scheduleId),
      membership.group,
      ledger,
      now,
      changes.generatedThrough,
    )
    return { schedule: await getSchedule(db, scheduleId), created }
  })
}
