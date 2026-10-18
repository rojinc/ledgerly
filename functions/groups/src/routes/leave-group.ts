import type { Members } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import type { Services } from '../services'
import {
  activityWrite,
  balanceOf,
  conflictAsTryAgain,
  getRowOrNull,
  invalid,
  joinedAdmins,
  parseBody,
  today,
  tryAgain,
} from '../shared'

/**
 * `groups POST /groups/{id}/leave` (permissions.md#leaving-a-group): once the caller's balance
 * is 0 and they aren't the last joined admin, their row becomes `left` and `viewer` in one
 * transaction, then their team membership goes. A caller who is already `left` only has the
 * team step left to do, so a retry finishes an interrupted leave.
 */
export async function leaveGroup(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<Record<string, never>> {
  parseBody(emptyBodySchema, body ?? {})
  const { person, member, group } = await requireMember(db, userId, groupId)
  if (group.type === 'personal') throw invalid("You can't leave your personal group.")
  if (member.status !== 'left') {
    if ((await balanceOf(db, groupId, person.$id)) !== 0) {
      throw invalid("Settle up first: your balance in this group isn't 0.")
    }
    if (member.role === 'admin') {
      const others = (await joinedAdmins(db, groupId)).filter((admin) => admin.$id !== member.$id)
      if (others.length === 0) {
        throw invalid('Make someone else an admin first: a group needs at least one admin.')
      }
    }
    await conflictAsTryAgain(() =>
      withTransaction(db, async (tx) => {
        await tx.write({
          action: 'update',
          tableId: TABLES.members,
          rowId: member.$id,
          data: { status: 'left', role: 'viewer', leftOn: member.leftOn ?? today(group, now) },
        })
        // Stage, then check (transaction.ts): from here on, any change to the row fails the
        // commit. Read the stored row, not this transaction's view, which has the new status.
        const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
        if (!isJoinedBy(current, person.$id)) throw tryAgain()
        await tx.write(
          activityWrite(groupId, person.$id, 'member.left', `${current.displayName} left`, now),
        )
      }),
    )
  }
  await removeFromTeam(teams, groupId, userId)
  return {}
}

function isJoinedBy(row: Members | null, personId: string): row is Members {
  return row !== null && row.personId === personId && row.status === 'active'
}
