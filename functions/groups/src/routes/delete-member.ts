import type { Members, Persons } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import type { Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, removeFromTeam, type TeamsApi } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { Query } from 'node-appwrite'
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
const TWO_MEMBERS = 'Employer and pair groups always keep both members. Archive the group instead.'

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
  const { person: caller, group } = await requireMember(db, userId, groupId, { roles: ['admin'] })
  if (group.type === 'employer' || group.type === 'pair') throw invalid(TWO_MEMBERS)
  if (group.type === 'personal') throw invalid('A personal group always keeps its only member.')
  const member = await getMemberOf(db, groupId, memberId)
  // Checked early so a refusal leaves the team alone; checked again in the transaction.
  if (await hasShares(db, groupId, member.personId)) throw invalid(HAS_SHARES)
  const joinedAdmin = member.role === 'admin' && member.status === 'active'
  if (joinedAdmin && !(await joinedAdmins(db, groupId)).some((a) => a.$id !== member.$id)) {
    throw invalid(NEEDS_ADMIN)
  }
  // Fail closed: take away read access before the row goes. A placeholder is never in the team
  // (D-016), so Teams isn't touched for one, which also keeps whether it has an account hidden.
  // If the removal then fails, the member gets their access back.
  const removedUserId =
    member.status === 'placeholder' ? null : await leaveTeam(db, teams, groupId, member.personId)
  try {
    await conflictAsTryAgain(() =>
      withTransaction(db, async (tx) => {
        await tx.write({ action: 'delete', tableId: TABLES.members, rowId: memberId })
        // Stage, then check (conventions.md): from here on, any change to the row fails the
        // commit. Read the stored row, not this transaction's view, where it is gone.
        if (await hasShares(db, groupId, member.personId)) throw invalid(HAS_SHARES)
        // A placeholder who joined after the first read gets CONFLICT; the retry sees them
        // active and takes them out of the team.
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
  } catch (error) {
    if (removedUserId) await rejoinTeam(db, teams, groupId, memberId, removedUserId)
    throw error
  }
  return {}
}

/** Takes the member's user out of the team; their user ID when they were in it, else null. */
async function leaveTeam(
  db: Db,
  teams: TeamsApi,
  groupId: string,
  personId: string,
): Promise<string | null> {
  const person = await getRowOrNull<Persons>(db, TABLES.persons, personId)
  if (!person?.userId) return null
  const { memberships } = await teams.listMemberships({
    teamId: groupId,
    queries: [Query.equal('userId', person.userId), Query.limit(1)],
  })
  if (memberships.length === 0) return null
  await removeFromTeam(teams, groupId, person.userId)
  return person.userId
}

/** Best effort: gives back team access when the removal failed and the member row is still there. */
async function rejoinTeam(
  db: Db,
  teams: TeamsApi,
  groupId: string,
  memberId: string,
  userId: string,
): Promise<void> {
  try {
    if (await getRowOrNull<Members>(db, TABLES.members, memberId)) {
      await addToTeam(teams, groupId, userId)
    }
  } catch {
    // The caller's error matters more.
  }
}
