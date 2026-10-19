import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Shares } from '@ledgerly/core/generated/rows'
import type { ReportShare } from '@ledgerly/core/reports/personal-report'
import type { Balances } from '@ledgerly/core/schemas/ledger'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { callFunction } from '../../lib/api'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'

// Appwrite's limit for one page.
const PAGE = 100

// Local to this feature: the shared keys file is outside its Scope.
const dashboardKeys = {
  myShares: (personId: string, start: string, end: string) =>
    ['myShares', personId, start, end] as const,
}

const COLUMNS = [
  '$id',
  'personId',
  'groupId',
  'date',
  'kind',
  'category',
  'givenCents',
  'receivedCents',
]

/**
 * Every share of `personId`'s dated `start` to `end` (both included), on `shares.idx_person_date`,
 * in cursor pages of 100 (scaling.md#appwrite-limits-we-design-around). Only the columns a report
 * needs.
 */
export function useMyShares(personId: string, start: LocalDate, end: LocalDate) {
  return useQuery({
    queryKey: dashboardKeys.myShares(personId, start, end),
    enabled: personId !== '',
    queryFn: async () => {
      const shares: ReportShare[] = []
      let cursor: string | undefined
      for (;;) {
        const { rows } = await tablesDB.listRows<Shares>({
          databaseId: DATABASE_ID,
          tableId: 'shares',
          queries: [
            Query.equal('personId', personId),
            Query.greaterThanEqual('date', start),
            Query.lessThanEqual('date', end),
            Query.select(COLUMNS),
            Query.orderAsc('date'),
            Query.limit(PAGE),
            ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
          ],
        })
        shares.push(...rows)
        if (rows.length < PAGE) break
        cursor = rows.at(-1)?.$id
      }
      return shares
    },
  })
}

/**
 * `ledger GET /groups/{id}/balances` for each group, never a sum of shares on the client
 * (functions-api.md#ledger). Same key and answer as `useBalances`, so the groups page and the
 * dashboard share the cache.
 */
export function useAllBalances(groups: Groups[]) {
  return useQueries({
    queries: groups.map((group) => ({
      queryKey: queryKeys.balances(group.$id),
      queryFn: async () => {
        const result = await callFunction<Balances>(
          'ledger',
          'GET',
          `/groups/${group.$id}/balances`,
        )
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      retry: false,
      staleTime: 60_000,
    })),
  })
}
