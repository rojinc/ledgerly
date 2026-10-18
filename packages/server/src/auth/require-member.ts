import { ROLES, type Role } from '@ledgerly/core/constants/domain'
import type { Groups, Members, Persons } from '@ledgerly/core/generated/rows'
import { Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
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
 * stay readable, so read-only routes pass `allowArchived`.
 */
export async function requireMember(
  db: Db,
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
  if (!person || !member || member.status === 'placeholder') {
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
