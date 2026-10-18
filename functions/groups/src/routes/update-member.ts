import type { Members } from '@ledgerly/core/generated/rows'
import { updateMemberBodySchema } from '@ledgerly/core/schemas/groups'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getMemberOf,
  getRowOrNull,
  invalid,
  keepAnotherAdmin,
  parseBody,
  tryAgain,
} from '../shared'

type Fields = Pick<Members, 'displayName' | 'role' | 'status' | 'joinedOn' | 'leftOn'>

/**
 * `groups PATCH /groups/{id}/members/{memberId}`: writes only the fields that change. Setting
 * `leftOn` moves someone out (permissions.md#leaving-a-group): role `viewer`, and status `left`
 * for someone who joined. Anyone with a `leftOn` stays a viewer. Teams are left alone, so they
 * can still see and settle what they owe.
 */
export async function updateMember(
  { db, now }: Services,
  userId: string,
  groupId: string,
  memberId: string,
  body: unknown,
): Promise<Members> {
  const changes = parseBody(updateMemberBodySchema, body)
  const { person: caller } = await requireMember(db, userId, groupId, { roles: ['admin'] })
  const stored = await getMemberOf(db, groupId, memberId)

  const movingOut = changes.leftOn !== undefined
  const next: Fields = {
    displayName: changes.displayName ?? stored.displayName,
    // Moving someone out makes them a viewer, a placeholder too.
    role: changes.role ?? (movingOut ? 'viewer' : stored.role),
    // Only someone who joined becomes `left`; a placeholder stays one.
    status: movingOut && stored.status === 'active' ? 'left' : stored.status,
    joinedOn: changes.joinedOn ?? stored.joinedOn,
    leftOn: changes.leftOn ?? stored.leftOn,
  }
  // Stored dates are plain YYYY-MM-DD strings, which sort as text.
  if (next.leftOn !== null && next.leftOn < next.joinedOn) {
    throw invalid('leftOn must be on or after joinedOn.')
  }
  if (next.leftOn !== null && next.role !== 'viewer') {
    throw invalid('A member who left can only be a viewer.')
  }
  const before: Partial<Fields> = {}
  const after: Partial<Fields> = {}
  for (const key of Object.keys(next) as Array<keyof Fields>) {
    if (next[key] !== stored[key]) {
      Object.assign(before, { [key]: stored[key] })
      Object.assign(after, { [key]: next[key] })
    }
  }
  if (Object.keys(after).length === 0) return stored

  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      await tx.write({ action: 'update', tableId: TABLES.members, rowId: memberId, data: after })
      // Stage, then check (conventions.md): from here on, any change to the row fails the
      // commit. Read the stored row, not this transaction's view, which has the new values.
      const current = await getRowOrNull<Members>(db, TABLES.members, memberId)
      // The admin check below goes by the stored role and status, and the date order and
      // `before` by the stored dates, so all must still hold.
      if (
        current?.groupId !== groupId ||
        current.status !== stored.status ||
        current.role !== stored.role ||
        current.joinedOn !== stored.joinedOn ||
        current.leftOn !== stored.leftOn
      ) {
        throw tryAgain()
      }
      if (isJoinedAdmin(stored) && !isJoinedAdmin(next)) {
        await keepAnotherAdmin(
          db,
          tx,
          groupId,
          memberId,
          'The group needs at least one admin who has joined.',
        )
      }
      await tx.write(
        activityWrite(
          groupId,
          caller.$id,
          'member.updated',
          `${next.displayName}'s membership was changed`,
          now,
          { before, after },
        ),
      )
    }),
  )
  return db.getRow<Members>({ databaseId: DATABASE_ID, tableId: TABLES.members, rowId: memberId })
}

function isJoinedAdmin(member: Pick<Members, 'role' | 'status'>): boolean {
  return member.role === 'admin' && member.status === 'active'
}
