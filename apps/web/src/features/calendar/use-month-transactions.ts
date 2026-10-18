import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { useQuery } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'

// Appwrite's limit for one page and for the values of one Query.equal.
const PAGE = 100

/** Only what the calendar shows. */
export type CalendarItem = Pick<
  Transactions,
  '$id' | 'groupId' | 'kind' | 'status' | 'date' | 'description' | 'totalCents'
>

const COLUMNS = ['$id', 'groupId', 'kind', 'status', 'date', 'description', 'totalCents']

/**
 * Every transaction dated `start` to `end` (both included) in `groups`, on
 * `transactions.idx_group_date`, in cursor pages of 100. Sorted by date.
 */
export function useMonthTransactions(
  groups: Groups[] | undefined,
  start: LocalDate,
  end: LocalDate,
) {
  const userId = useCurrentUser().data?.$id ?? ''
  const groupIds = (groups ?? []).map((group) => group.$id)
  return useQuery({
    queryKey: queryKeys.calendar(userId, start, end, groupIds),
    enabled: userId !== '' && groups !== undefined,
    queryFn: async () => {
      const items: CalendarItem[] = []
      for (let index = 0; index < groupIds.length; index += PAGE) {
        let cursor: string | undefined
        for (;;) {
          const { rows } = await tablesDB.listRows<Transactions>({
            databaseId: DATABASE_ID,
            tableId: 'transactions',
            queries: [
              Query.equal('groupId', groupIds.slice(index, index + PAGE)),
              Query.greaterThanEqual('date', start),
              Query.lessThanEqual('date', end),
              Query.select(COLUMNS),
              Query.orderAsc('date'),
              Query.limit(PAGE),
              ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
            ],
          })
          items.push(...rows)
          if (rows.length < PAGE) break
          cursor = rows.at(-1)?.$id
        }
      }
      return items.sort((a, b) => a.date.localeCompare(b.date))
    },
  })
}
