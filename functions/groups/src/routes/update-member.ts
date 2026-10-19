import type { Members, Persons } from '@ledgerly/core/generated/rows'
import { updateMemberBodySchema } from '@ledgerly/core/schemas/groups'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { isInTeam, type TeamsApi } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { leftOnTheirOwn } from '@ledgerly/server/auth/left-on-their-own'
import { requireMember } from '@ledgerly/server/auth/require-member'
import type { Services } from '../services'
import {
  activityWrite,
  aRole,
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
 * can still see and settle what they owe. `leftOn: null` moves them back in: `left` becomes
 * `active` again, only for someone who moved out, never for a row that left on its own.
 */
export async function updateMember(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  memberId: string,
  body: unknown,
): Promise<Members> {
  const changes = parseBody(updateMemberBodySchema, body)
  const { person: caller } = await requireMember(db, teams, userId, groupId, { roles: ['admin'] })
  const stored = await getMemberOf(db, groupId, memberId)

  const movingOut = typeof changes.leftOn === 'string'
  // A placeholder with a `leftOn` just loses it; it stays a placeholder.
  const movingBackIn = changes.leftOn === null && stored.status === 'left'
  if (movingBackIn) await requireMovedOut(db, teams, groupId, stored)
  const next: Fields = {
    displayName: changes.displayName ?? stored.displayName,
    // Moving someone out makes them a viewer, a placeholder too. Moving back in keeps the role.
    role: changes.role ?? (movingOut ? 'viewer' : stored.role),
    // Only someone who joined becomes `left`; a placeholder stays one.
    status:
      movingOut && stored.status === 'active' ? 'left' : movingBackIn ? 'active' : stored.status,
    joinedOn: changes.joinedOn ?? stored.joinedOn,
    leftOn: changes.leftOn === undefined ? stored.leftOn : changes.leftOn,
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
      // Their own leave writes no member field, only a guard `rev` and a member.left row. One
      // that committed since the first read shows here; one still to commit fails this commit.
      if (movingBackIn && (await leftOnTheirOwn(db, groupId, stored.personId, stored.$createdAt))) {
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
        activityWrite(groupId, caller.$id, 'member.updated', changeSummary(after), now, {
          subjectPersonId: current.personId,
          changes: { before: withoutName(before), after: withoutName(after) },
        }),
      )
    }),
  )
  return db.getRow<Members>({ databaseId: DATABASE_ID, tableId: TABLES.members, rowId: memberId })
}

/**
 * What changed, to read after the member's current name, which the app shows from
 * `subjectPersonId`: "was renamed and moved in on 2026-08-15". It names no one, not even with
 * a rename (data-model.md#activity).
 */
function changeSummary(after: Partial<Fields>): string {
  const parts: string[] = []
  if (after.displayName !== undefined) parts.push('was renamed')
  if (after.joinedOn !== undefined) parts.push(`moved in on ${after.joinedOn}`)
  if (after.leftOn === null) parts.push('moved back in')
  if (after.leftOn) parts.push(`moved out on ${after.leftOn}`)
  // Moving out makes them a viewer, which "moved out" already says.
  if (after.role !== undefined && !after.leftOn) parts.push(`was made ${aRole(after.role)}`)
  // A status only changes with leftOn, so the fallback is for rows that break that rule.
  const last = parts.pop() ?? 'had their membership changed'
  return parts.length > 0 ? `${parts.join(', ')} and ${last}` : last
}

/** The changes without the name, which the summary only says changed. */
function withoutName({ displayName: _, ...fields }: Partial<Fields>): Partial<Fields> {
  return fields
}

/**
 * permissions.md#leaving-a-group: only someone who moved out can move back in. They are still in
 * the team, and their own member.left isn't the newest of their member.left and member.joined
 * rows. Leaving on your own is final for that row.
 */
async function requireMovedOut(
  db: Db,
  teams: Pick<TeamsApi, 'listMemberships'>,
  groupId: string,
  member: Members,
): Promise<void> {
  const person = await getRowOrNull<Persons>(db, TABLES.persons, member.personId)
  if (
    !person?.userId ||
    !(await isInTeam(teams, groupId, person.userId)) ||
    (await leftOnTheirOwn(db, groupId, member.personId, member.$createdAt))
  ) {
    throw invalid("They left this group on their own, so they can't be moved back in.")
  }
}

function isJoinedAdmin(member: Pick<Members, 'role' | 'status'>): boolean {
  return member.role === 'admin' && member.status === 'active'
}
