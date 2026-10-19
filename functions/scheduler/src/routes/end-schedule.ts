import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { type EndedSchedule, endScheduleBodySchema } from '@ledgerly/core/schemas/scheduler'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { guardGroup, ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { guardSchedule, laterOf, removeOccurrences } from '../occurrences'
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
    const today = localToday(membership.group.timezone, now)
    const yesterday = addDays(today, -1)
    const generated = schedule.generatedThrough as LocalDate | null
    const done = generated !== null && compareDates(generated, endsOn) >= 0
    // The next run carries on from here: up to a later end, or deleting what's left after an
    // earlier one. Never from before today, so nothing past is made, changed or deleted.
    const through = generated === null ? null : laterOf(done ? endsOn : generated, yesterday)
    await withTransaction(db, async (tx) => {
      await guardSchedule(tx, db, schedule, {
        endsOn,
        generatedThrough: through,
        nextRunAt: now.toISOString(),
      })
      // An archive that lands meanwhile makes this run again and get ARCHIVED.
      await guardGroup(tx, db, membership.group)
    })
    // Only future ones: a past occurrence that wasn't posted waits for the user.
    const after = addDays(endsOn, 1)
    const from = compareDates(after, today) > 0 ? after : today
    const removed = await removeOccurrences(db, membership.group, scheduleId, from, now)
    return { schedule: await getSchedule(db, scheduleId), removed }
  })
}
