import type { Members, Persons } from '@ledgerly/core/generated/rows'
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
  keepAnotherAdmin,
  parseBody,
  tryAgain,
} from '../shared'

const HAS_SHARES = "Members with transactions can't be removed. Set leftOn instead."
const NEEDS_ADMIN = 'The group needs at least one admin who has joined.'

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
  // Checked early so a refusal leaves the team alone; checked again in the transaction.
  if (await hasShares(db, groupId, member.personId)) throw invalid(HAS_SHARES)
  const joinedAdmin = member.role === 'admin' && member.status === 'active'
  if (joinedAdmin && !(await joinedAdmins(db, groupId)).some((a) => a.$id !== member.$id)) {
    throw invalid(NEEDS_ADMIN)
  }
  // Fail closed: take away read access before the row goes, so a failure in between leaves a
  // member without access, never access without a member row. A retry finishes the job.
  const person = await getRowOrNull<Persons>(db, TABLES.persons, member.personId)
  if (person?.userId) await removeFromTeam(teams, groupId, person.userId)
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      await tx.write({ action: 'delete', tableId: TABLES.members, rowId: memberId })
      // Stage, then check (conventions.md): from here on, any change to the row fails the
      // commit. Read the stored row, not this transaction's view, where it is gone.
      if (await hasShares(db, groupId, member.personId)) throw invalid(HAS_SHARES)
      // A join after the team step above would leave a team membership behind: a retry
      // removes it again.
      const current = await getRowOrNull<Members>(db, TABLES.members, memberId)
      if (current?.status !== member.status || current.role !== member.role) throw tryAgain()
      if (joinedAdmin) await keepAnotherAdmin(db, tx, groupId, memberId, NEEDS_ADMIN)
      await tx.write(
        activityWrite(
          groupId,
          caller.$id,
          'member.removed',
          `${member.displayName} was removed`,
          now,
        ),
      )
    }),
  )
  return {}
}
