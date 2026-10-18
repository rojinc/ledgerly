import type { Members } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import type { Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import {
  activityWrite,
  balanceOf,
  conflictAsTryAgain,
  getRowOrNull,
  invalid,
  keepAnotherAdmin,
  parseBody,
  today,
  tryAgain,
} from '../shared'

/**
 * `groups POST /groups/{id}/leave` (permissions.md#leaving-a-group): once the caller's balance
 * is 0 and they aren't the last joined admin, their row becomes `left` and `viewer` in one
 * transaction, then their team membership goes. A caller who is already `left` only has the
 * team step left to do, so a retry finishes an interrupted leave, even in an archived group.
 */
export async function leaveGroup(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<Record<string, never>> {
  parseBody(emptyBodySchema, body ?? {})
  const { person, member, group } = await requireMember(db, userId, groupId, {
    allowArchived: true,
  })
  if (group.archivedAt && member.status !== 'left') {
    throw new AppError('ARCHIVED', 'This group is archived, so it can no longer be changed.')
  }
  if (group.type === 'personal') throw invalid("You can't leave your personal group.")
  if (member.status === 'left') {
    await requireSettled(db, groupId, person.$id)
  } else {
    const joinedOn = member.joinedOn
    const todayHere = today(group, now)
    await conflictAsTryAgain(() =>
      withTransaction(db, async (tx) => {
        await tx.write({
          action: 'update',
          tableId: TABLES.members,
          rowId: member.$id,
          // Stored dates are plain YYYY-MM-DD strings, which sort as text.
          data: {
            status: 'left',
            role: 'viewer',
            leftOn: member.leftOn ?? (todayHere < joinedOn ? joinedOn : todayHere),
          },
        })
        // Stage, then check (transaction.ts): from here on, any change to the row fails the
        // commit. Read the stored row, not this transaction's view, which has the new status.
        const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
        // leftOn above came from the dates read first, so they must still hold too.
        if (
          !isJoinedBy(current, person.$id) ||
          current.joinedOn !== member.joinedOn ||
          current.leftOn !== member.leftOn
        ) {
          throw tryAgain()
        }
        await requireSettled(db, groupId, person.$id)
        if (current.role === 'admin') {
          await keepAnotherAdmin(
            db,
            tx,
            groupId,
            member.$id,
            'Make someone else an admin first: a group needs at least one admin.',
          )
        }
        await tx.write(
          activityWrite(groupId, person.$id, 'member.left', `${current.displayName} left`, now),
        )
      }),
    )
  }
  await removeFromTeam(teams, groupId, userId)
  return {}
}

async function requireSettled(db: Db, groupId: string, personId: string): Promise<void> {
  if ((await balanceOf(db, groupId, personId)) !== 0) {
    throw invalid("Settle up first: your balance in this group isn't 0.")
  }
}

function isJoinedBy(row: Members | null, personId: string): row is Members {
  return row !== null && row.personId === personId && row.status === 'active'
}
