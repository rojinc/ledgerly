import type { Groups, Persons, Statements, Transactions } from '@ledgerly/core/generated/rows'
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
 * `groups POST /groups/{id}/archive`: admin only. The group stays read-only until an admin
 * unarchives it (unarchive-group.ts). Archiving an archived group returns it unchanged, so a
 * retry is safe. Refused while a timer is running or a statement is being finalized in the
 * group, bar an invoice whose issuer deleted their account more than an hour ago (#519).
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
      // A finalize resumed after the archive would get ARCHIVED and stay `finalizing`, with its
      // locks, for good. Finalize step 1 stages the group row in the transaction that sets
      // `finalizing` (statements.md#2-finalize-post-statementsidfinalize), so the same order
      // argument as for a timer start holds.
      if (await finalizeInTheWay(db, group, now)) {
        throw new AppError(
          'CONFLICT',
          'A statement in this group is being finalized. Finish it first.',
        )
      }
      // Not the group's name either: a pair group's is what its creator calls the other person.
      await tx.write(
        activityWrite(groupId, person.$id, 'group.archived', 'Archived the group', now),
      )
    }),
  )
  return db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId })
}

/**
 * Whether a statement of the group is `finalizing` (`idx_group_period`), other than an invoice
 * whose issuer deleted their account more than an hour ago. That one's finalize is refused for
 * good, and no run that began before the deletion can still be going, since a run stops after
 * 300 s. So the archive goes over it, it stays `finalizing`, and the group can be deleted
 * (#519).
 */
async function finalizeInTheWay(db: Db, group: Groups, now: Date): Promise<boolean> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', group.$id), Query.equal('status', 'finalizing')],
    total: false,
  })
  if (rows.length === 0) return false
  if (rows.some((row) => row.type !== 'invoice')) return true
  const deletedAt = (await getRowOrNull<Persons>(db, TABLES.persons, group.ownerPersonId))
    ?.deletedAt
  // Fails closed: a date that doesn't parse counts as within the hour.
  return !deletedAt || !(now.getTime() - Date.parse(deletedAt) > ISSUER_DELETED_MARGIN_MS)
}

const ISSUER_DELETED_MARGIN_MS = 60 * 60 * 1000

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
