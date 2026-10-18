import type { Persons } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getMemberOf,
  getRowOrNull,
  hasShares,
  invalid,
  joinedAdmins,
  parseBody,
} from '../shared'

/**
 * `groups DELETE /groups/{id}/members/{memberId}`: removes someone completely, only while they
 * have no shares in the group (permissions.md#leaving-a-group), team membership first.
 */
export async function deleteMember(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  memberId: string,
  body: unknown,
): Promise<Record<string, never>> {
  parseBody(emptyBodySchema, body ?? {})
  const { person: caller } = await requireMember(db, userId, groupId, { roles: ['admin'] })
  const member = await getMemberOf(db, groupId, memberId)
  if (await hasShares(db, groupId, member.personId)) {
    throw invalid("Members with transactions can't be removed. Set leftOn instead.")
  }
  if (member.role === 'admin' && member.status === 'active') {
    const admins = await joinedAdmins(db, groupId)
    if (!admins.some((admin) => admin.$id !== member.$id)) {
      throw invalid('The group needs at least one admin who has joined.')
    }
  }
  // Fail closed: take away read access before the row goes, so a failure in between leaves a
  // member without access, never access without a member row. A retry finishes the job.
  const person = await getRowOrNull<Persons>(db, TABLES.persons, member.personId)
  if (person?.userId) await removeFromTeam(teams, groupId, person.userId)
  await conflictAsTryAgain(() =>
    withTransaction(db, (tx) =>
      tx.write(
        { action: 'delete', tableId: TABLES.members, rowId: memberId },
        activityWrite(
          groupId,
          caller.$id,
          'member.removed',
          `${member.displayName} was removed`,
          now,
        ),
      ),
    ),
  )
  return {}
}
