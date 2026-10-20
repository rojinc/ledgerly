import { parseLocalDate } from '@ledgerly/core/dates/local-date'
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
  nextCloseAtFor,
  parseBody,
  tryAgain,
} from '../shared'

/**
 * `groups POST /groups/{id}/unarchive` (#428): admin only. The group is writable again from
 * today; nothing in its past changes. Unarchiving a group that isn't archived returns it
 * unchanged, so a retry is safe. Allowed with a timer still running: unarchiving is the only way
 * to stop it. Returns the group as stored.
 */
export async function unarchiveGroup(
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
  if (!group.archivedAt) return group
  const anchor = group.cycleAnchor === null ? null : parseLocalDate(group.cycleAnchor)
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: groupId,
        // From today, as for a cycle change (statements.md#periods): the archived weeks join the
        // first period after it, which starts the day after the latest statement.
        data: {
          archivedAt: null,
          nextCloseAt: nextCloseAtFor(group.statementCycle, anchor, group.timezone, now),
        },
      })
      // Stage, then check (conventions.md): an unarchive committed since the first read would
      // get a second group.unarchived. The retry returns the stored group instead.
      const current = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
      if (!current?.archivedAt) throw tryAgain()
      // Names no one, nor the group, as group.archived: a pair's name is its creator's label for
      // the other person.
      await tx.write(
        activityWrite(groupId, person.$id, 'group.unarchived', 'Unarchived the group', now),
      )
    }),
  )
  return db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId })
}
