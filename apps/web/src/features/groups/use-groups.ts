import type { Groups, Members } from '@ledgerly/core/generated/rows'
import type { Balances } from '@ledgerly/core/schemas/ledger'
import { useQuery } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { callFunction } from '../../lib/api'
import { DATABASE_ID, tablesDB, teams } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'

// Appwrite's limit for one page and for the values of one Query.equal.
const PAGE = 100

/**
 * The groups the user has joined: their teams, since team ID = group ID (D-004). Groups they
 * were only added to aren't in the team yet (D-016), so they aren't listed. Sorted by name.
 */
export function useGroups() {
  const userId = useCurrentUser().data?.$id ?? ''
  return useQuery({
    queryKey: queryKeys.groups(userId),
    enabled: userId !== '',
    queryFn: async () => {
      const groups: Groups[] = []
      for (let offset = 0; ; offset += PAGE) {
        const { teams: page } = await teams.list({
          queries: [Query.limit(PAGE), Query.offset(offset)],
        })
        if (page.length > 0) {
          const { rows } = await tablesDB.listRows<Groups>({
            databaseId: DATABASE_ID,
            tableId: 'groups',
            queries: [
              Query.equal(
                '$id',
                page.map((team) => team.$id),
              ),
              Query.limit(PAGE),
            ],
          })
          groups.push(...rows)
        }
        if (page.length < PAGE) break
      }
      return groups.sort((a, b) => a.name.localeCompare(b.name))
    },
  })
}

/** One group row, readable by its team. */
export function useGroup(groupId: string) {
  return useQuery({
    queryKey: queryKeys.group(groupId),
    queryFn: () =>
      tablesDB.getRow<Groups>({ databaseId: DATABASE_ID, tableId: 'groups', rowId: groupId }),
  })
}

/** The user's own member row in a group, for their role. Undefined when they have none. */
export function useMyMember(groupId: string, personId: string) {
  return useQuery({
    queryKey: queryKeys.myMember(groupId, personId),
    enabled: personId !== '',
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Members>({
        databaseId: DATABASE_ID,
        tableId: 'members',
        queries: [
          Query.equal('groupId', groupId),
          Query.equal('personId', personId),
          Query.limit(1),
        ],
      })
      return rows[0] ?? null
    },
  })
}

/**
 * `ledger GET /groups/{id}/balances` (functions-api.md#ledger): a function, never a sum on the
 * client, so a later balances table doesn't change this.
 */
export function useBalances(groupId: string) {
  return useQuery({
    queryKey: queryKeys.balances(groupId),
    queryFn: async () => {
      const result = await callFunction<Balances>('ledger', 'GET', `/groups/${groupId}/balances`)
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    },
    retry: false,
    // Not on every focus: one function execution per group row.
    staleTime: 60_000,
  })
}
