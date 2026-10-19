import { AppError } from '@ledgerly/server/http/app-error'
import { ledgerRoute } from '@ledgerly/server/ledger/transactions'
import { deleteScheduleRows, hasOccurrence } from '@ledgerly/server/scheduler/end-schedule'
import { Query } from 'node-appwrite'
import { requireScheduleWriter } from '../schedule-rows'
import type { Services } from '../services'

/**
 * `scheduler DELETE /schedules/{id}` (scheduling.md#schedule-routes): only while none of its
 * occurrences is posted, otherwise it is ended instead. Deletes the schedule and all its
 * occurrences, voided and edited ones included, with their items, taking their receipts off.
 */
export async function deleteSchedule(
  services: Services,
  userId: string | null,
  scheduleId: string,
): Promise<Record<string, never>> {
  const { db } = services
  return ledgerRoute(async () => {
    const { membership } = await requireScheduleWriter(services, userId, scheduleId)
    if (await hasOccurrence(db, scheduleId, [Query.equal('status', 'posted')])) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This schedule has posted transactions, so end it instead of deleting it.',
      )
    }
    await deleteScheduleRows(db, membership.group, scheduleId, services.now)
    return {}
  })
}
