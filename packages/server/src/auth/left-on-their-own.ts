import type { Activity } from '@ledgerly/core/generated/rows'
import { Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'

/**
 * Leaving on your own is final for that row (permissions.md#leaving-a-group). It counts as their
 * own leave when the newest member.left or member.joined row this person wrote in the group,
 * since this member row was created, is member.left. A later member.joined (they came back, say
 * through a merge) means a fresh membership. With `before`, only rows written before it count:
 * a deleted person's leave of their own from before the deletion, not the deletion's keep.
 * Uses idx_group_at (groupId, at).
 */
export async function leftOnTheirOwn(
  db: Db,
  groupId: string,
  personId: string,
  memberCreatedAt: string,
  before?: string | null,
): Promise<boolean> {
  const { rows } = await db.listRows<Activity>({
    databaseId: DATABASE_ID,
    tableId: TABLES.activity,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('action', ['member.left', 'member.joined']),
      Query.equal('actorPersonId', personId),
      Query.greaterThanEqual('$createdAt', memberCreatedAt),
      ...(before ? [Query.lessThan('$createdAt', before)] : []),
      Query.orderDesc('at'),
      Query.limit(1),
    ],
    total: false,
  })
  return rows[0]?.action === 'member.left'
}
