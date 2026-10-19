import { ROLES, type Role } from '@ledgerly/core/constants/domain'
import type { Groups, Members, Persons } from '@ledgerly/core/generated/rows'
import { Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import { isInTeam, type TeamsApi } from '../appwrite/teams'
import { AppError } from '../http/app-error'

export type Membership = { person: Persons; member: Members; group: Groups }

/** The caller's user ID, or UNAUTHENTICATED. For routes that don't belong to a group. */
export function requireUser(userId: string | null): string {
  if (!userId) throw new AppError('UNAUTHENTICATED', 'Log in to continue.')
  return userId
}

/**
 * permissions.md#function-side-checks. `roles` lists the roles allowed to do this (default:
 * all); routes check anything finer, such as "creator or admin", themselves. Archived groups
 * stay readable, so read-only routes pass `allowArchived`. A `left` member counts only while
 * still in the group's team: one who moved out is, one who left on their own isn't.
 */
export async function requireMember(
  db: Db,
  teams: Pick<TeamsApi, 'listMemberships'>,
  userId: string | null,
  groupId: string,
  options: { roles?: readonly Role[]; allowArchived?: boolean } = {},
): Promise<Membership> {
  const callerId = requireUser(userId)
  const person = await findOne<Persons>(db, TABLES.persons, [Query.equal('userId', callerId)])
  const member =
    person &&
    (await findOne<Members>(db, TABLES.members, [
      Query.equal('groupId', groupId),
      Query.equal('personId', person.$id),
    ]))
  // D-016: a placeholder hasn't joined the group, even if the person has an account.
  // permissions.md#members: the same `left` row for both, told apart by the team membership,
  // which leaving on your own removes. Checked before the role, so they get NOT_A_MEMBER everywhere.
  if (
    !person ||
    !member ||
    member.status === 'placeholder' ||
    (member.status === 'left' && !(await isInTeam(teams, groupId, callerId)))
  ) {
    throw new AppError('NOT_A_MEMBER', "You're not a member of this group.")
  }
  if (!(options.roles ?? ROLES).includes(member.role)) {
    throw new AppError('FORBIDDEN', "Your role in this group can't do this.")
  }
  const group = await db.getRow<Groups>({
    databaseId: DATABASE_ID,
    tableId: TABLES.groups,
    rowId: groupId,
  })
  if (group.archivedAt && !options.allowArchived) {
    throw new AppError('ARCHIVED', 'This group is archived, so it can no longer be changed.')
  }
  return { person, member, group }
}

/**
 * requireMember for the group of a row that was looked up by ID: a transaction, statement or
 * schedule. Someone who isn't a member gets the route's `NOT_FOUND`, the same answer as for an
 * ID that doesn't exist, so IDs can't be probed (#121, #136). Every other error passes through.
 */
export async function requireMemberOf(
  db: Db,
  teams: Pick<TeamsApi, 'listMemberships'>,
  userId: string | null,
  groupId: string,
  notFound: string,
  options: { roles?: readonly Role[] } = {},
): Promise<Membership> {
  try {
    return await requireMember(db, teams, userId, groupId, options)
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_A_MEMBER') {
      throw new AppError('NOT_FOUND', notFound)
    }
    throw error
  }
}

async function findOne<R extends Persons | Members>(
  db: Db,
  tableId: string,
  queries: string[],
): Promise<R | undefined> {
  const { rows } = await db.listRows<R>({
    databaseId: DATABASE_ID,
    tableId,
    queries: [...queries, Query.limit(1)],
    total: false,
  })
  return rows[0]
}
