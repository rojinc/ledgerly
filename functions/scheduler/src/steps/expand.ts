import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Schedules } from '@ledgerly/core/generated/rows'
import { pages } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { ledgerRoute, loadGroupLedger } from '@ledgerly/server/ledger/transactions'
import { guardSchedule } from '@ledgerly/server/scheduler/end-schedule'
import { Query } from 'node-appwrite'
import { generateOccurrences } from '../occurrences'
import { findSchedule } from '../schedule-rows'
import type { Services } from '../services'

export type ExpandCounts = { schedules: number; created: number; failed: number }

/**
 * Step 1 (scheduling.md#step-1-expand-due-schedules): expands every schedule whose
 * `nextRunAt` has come. A schedule in an archived group gets its `nextRunAt` cleared instead.
 * One that fails (a template a member change has made invalid, say) is counted, keeps its
 * `nextRunAt`, and is tried again next run.
 */
export async function expandDueSchedules(services: Services): Promise<ExpandCounts> {
  const { db, now } = services
  const counts: ExpandCounts = { schedules: 0, created: 0, failed: 0 }
  // idx_nextRunAt
  const due = pages<Schedules>(services, TABLES.schedules, [
    Query.lessThanEqual('nextRunAt', now.toISOString()),
  ])
  for await (const { $id } of due) {
    try {
      counts.created += await ledgerRoute(async () => {
        // As it is now: an edit or another run may have got there first.
        const schedule = await findSchedule(db, $id)
        if (!schedule?.nextRunAt || schedule.nextRunAt > now.toISOString()) return 0
        const group = await db.getRow<Groups>({
          databaseId: DATABASE_ID,
          tableId: TABLES.groups,
          rowId: schedule.groupId,
        })
        if (group.archivedAt) {
          await withTransaction(db, (tx) => guardSchedule(tx, db, schedule, { nextRunAt: null }))
          return 0
        }
        const ledger = await loadGroupLedger(db, group, schedule.createdBy)
        const after = schedule.generatedThrough as LocalDate | null
        const { created } = await generateOccurrences(
          db,
          schedule,
          group,
          ledger,
          now,
          after,
          services.outOfTime,
        )
        return created
      })
      counts.schedules += 1
    } catch {
      counts.failed += 1
    }
  }
  return counts
}
