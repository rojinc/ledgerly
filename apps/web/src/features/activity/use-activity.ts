import type { Activity } from '@ledgerly/core/generated/rows'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'

/** Appwrite's limit for one page (scaling.md). */
export const ACTIVITY_PAGE = 100
/** Only what an entry shows: never `changesJson`, which can hold person IDs and stored input. */
const COLUMNS = ['$id', 'actorPersonId', 'subjectPersonId', 'transactionId', 'summary', 'at']
export type ActivityEntry = Pick<
  Activity,
  '$id' | 'actorPersonId' | 'subjectPersonId' | 'transactionId' | 'summary' | 'at'
>

/**
 * A group's activity, newest first, in cursor pages on `activity.idx_group_at`. One write can add
 * two rows with the same `at`, so ties go by ID and the cursor stays stable.
 */
export function useActivity(groupId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.activity(groupId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { rows } = await tablesDB.listRows<Activity>({
        databaseId: DATABASE_ID,
        tableId: 'activity',
        queries: [
          Query.equal('groupId', groupId),
          Query.select(COLUMNS),
          Query.orderDesc('at'),
          Query.orderDesc('$id'),
          Query.limit(ACTIVITY_PAGE),
          ...(pageParam === undefined ? [] : [Query.cursorAfter(pageParam)]),
        ],
      })
      return rows as ActivityEntry[]
    },
    getNextPageParam: (last) => (last.length < ACTIVITY_PAGE ? undefined : last.at(-1)?.$id),
  })
}
