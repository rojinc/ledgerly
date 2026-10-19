import type { Members } from '@ledgerly/core/generated/rows'
import { addMemberBodySchema } from '@ledgerly/core/schemas/groups'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { type PersonInput, resolvePerson } from '@ledgerly/server/identity/resolve-person'
import { ID, Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  aRole,
  conflictAsTryAgain,
  findFirst,
  invalid,
  parseBody,
  teamRead,
  today,
} from '../shared'

/**
 * `groups POST /groups/{id}/members` (identity-and-invites.md#adding-someone-to-a-group). The
 * new row is always a `placeholder` and nobody joins the team here (D-016), so the response
 * looks the same whether or not the person has an account.
 */
export async function addMember(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<Members> {
  const { role, joinedOn, ...input } = parseBody(addMemberBodySchema, body)
  const membership = await requireMember(db, teams, userId, groupId, { roles: ['admin', 'member'] })
  const { person: caller, group } = membership
  // permissions.md: a member may add people only to a house, and only as a member.
  if (
    membership.member.role !== 'admin' &&
    (group.type !== 'house' || (role !== undefined && role !== 'member'))
  ) {
    throw new AppError('FORBIDDEN', "Your role in this group can't do this.")
  }
  if (group.type === 'personal') throw invalid('A personal group has no other members.')
  if (group.type !== 'house') {
    throw invalid(`A ${group.type} group always has exactly two members.`)
  }

  const memberId = ID.unique()
  const newRole = role ?? 'member'
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      const resolved = await resolveOrInvalid(db, input, group.region, tx.id)
      const existing = await findFirst<Members>(db, TABLES.members, [
        Query.equal('groupId', groupId),
        Query.equal('personId', resolved.personId),
      ])
      if (existing) throw new AppError('CONFLICT', 'This person is already in the group.')
      // Another request adding the same person, or the same new email, at the same time
      // fails this commit on a unique index (uniq_group_person, identities.key): CONFLICT.
      await tx.write(
        ...resolved.writes,
        {
          action: 'create',
          tableId: TABLES.members,
          rowId: memberId,
          data: {
            groupId,
            personId: resolved.personId,
            displayName: input.displayName,
            role: newRole,
            status: 'placeholder',
            joinedOn: joinedOn ?? today(group, now),
            leftOn: null,
          },
          permissions: teamRead(groupId),
        },
        // No name, email or phone (security-and-privacy.md): the app shows the name the group
        // uses, from subjectPersonId.
        activityWrite(groupId, caller.$id, 'member.added', `was added as ${aRole(newRole)}`, now, {
          subjectPersonId: resolved.personId,
        }),
      )
    }),
  )
  return db.getRow<Members>({ databaseId: DATABASE_ID, tableId: TABLES.members, rowId: memberId })
}

// resolvePerson throws a RangeError, with a fixed message, for an email or phone it can't use.
async function resolveOrInvalid(db: Db, input: PersonInput, region: string, transactionId: string) {
  try {
    return await resolvePerson(db, input, region, transactionId)
  } catch (error) {
    if (error instanceof RangeError) throw invalid(error.message)
    throw error
  }
}
