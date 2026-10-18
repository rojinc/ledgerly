import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getRowOrNull,
  invalid,
  parseBody,
  tryAgain,
} from '../shared'

/**
 * `groups POST /groups/{id}/archive`: admin only, permanent in v1. Archiving an archived group
 * returns it unchanged, so a retry is safe. Refused while a timer is running in the group.
 * Returns the group as stored.
 */
export async function archiveGroup(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<Groups> {
  parseBody(emptyBodySchema, body ?? {})
  const { person, group } = await requireMember(db, teams, userId, groupId, {
    roles: ['admin'],
    allowArchived: true,
  })
  if (group.archivedAt) return group
  if (group.type === 'personal') throw invalid("A personal group can't be archived.")
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: groupId,
        // The statements cron selects groups by nextCloseAt, so an archived group leaves it.
        data: { archivedAt: now.toISOString(), nextCloseAt: null },
      })
      // Stage, then check (conventions.md): an archive committed since the first read would
      // get a second group.archived. The retry returns the stored group instead.
      const current = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
      if (current?.archivedAt) throw tryAgain()
      // A timer in an archived group can't be stopped (scheduling.md#timer-shifts). A start
      // guards the group row too (ledger.md#concurrency), and `archivedAt` is a real change to
      // it: a start that commits after this read fails this commit, one staged before this
      // commits fails its own, and one staged after sees `archivedAt`. Its rerun gets ARCHIVED.
      if (await hasRunningTimer(db, groupId)) {
        throw new AppError('CONFLICT', 'A timer is running in this group. Stop or void it first.')
      }
      await tx.write(
        activityWrite(groupId, person.$id, 'group.archived', `${group.name} archived`, now),
      )
    }),
  )
  return db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId })
}

/** Whether any transaction in the group is `running` (`idx_group_status_date`). */
async function hasRunningTimer(db: Db, groupId: string): Promise<boolean> {
  const { rows } = await db.listRows<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    queries: [Query.equal('groupId', groupId), Query.equal('status', 'running'), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}
