import type { Transactions } from '@ledgerly/core/generated/rows'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { guardGroup, ledgerRoute, Raced } from '@ledgerly/server/ledger/transactions'
import { Query } from 'node-appwrite'
import { removeOccurrences } from '../occurrences'
import { requireScheduleWriter } from '../schedule-rows'
import type { Services } from '../services'

/**
 * `scheduler DELETE /schedules/{id}` (scheduling.md#schedule-routes): only while none of its
 * occurrences is posted, otherwise it is ended instead. Deletes the schedule and all its
 * occurrences, voided and edited ones included, with their items.
 */
export async function deleteSchedule(
  services: Services,
  userId: string | null,
  scheduleId: string,
): Promise<Record<string, never>> {
  const { db } = services
  return ledgerRoute(async () => {
    const { membership } = await requireScheduleWriter(services, userId, scheduleId)
    if ((await occurrences(services, scheduleId, [Query.equal('status', 'posted')])).length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This schedule has posted transactions, so end it instead of deleting it.',
      )
    }
    await removeOccurrences(db, membership.group, scheduleId, null, services.now, { all: true })
    await withTransaction(db, async (tx) => {
      await tx.write({ action: 'delete', tableId: TABLES.schedules, rowId: scheduleId })
      // An archive that lands meanwhile makes this run again and get ARCHIVED.
      await guardGroup(tx, db, membership.group)
      // An occurrence created meanwhile (a cron run) would be left without its schedule. One
      // created after this was staged also wrote the schedule row, so the commit fails.
      if ((await occurrences(services, scheduleId, [])).length > 0) throw new Raced()
    })
    return {}
  })
}

// idx_schedule_date, on its first column.
async function occurrences(
  { db }: Services,
  scheduleId: string,
  queries: string[],
): Promise<Transactions[]> {
  const { rows } = await db.listRows<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    queries: [Query.equal('scheduleId', scheduleId), ...queries, Query.limit(1)],
    total: false,
  })
  return rows
}
