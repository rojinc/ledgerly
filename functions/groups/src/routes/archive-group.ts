import type { Groups } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
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
 * returns it unchanged, so a retry is safe. Returns the group as stored.
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
      await tx.write(
        activityWrite(groupId, person.$id, 'group.archived', `${group.name} archived`, now),
      )
    }),
  )
  return db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId })
}
