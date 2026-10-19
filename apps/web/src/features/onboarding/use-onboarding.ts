import type { Transactions } from '@ledgerly/core/generated/rows'
import { useQuery } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'

// Appwrite's limit for the values of one Query.equal.
const PAGE = 100

// Local to this feature: the shared keys file is outside #52's Scope.
const firstEntryKey = (groupIds: readonly string[]) => ['firstEntry', ...groupIds] as const

/**
 * Whether any of the groups has a transaction, in any status: one read of at most one ID, on
 * `transactions.idx_group_date`. True once the user has recorded something, and the guide is done.
 * Not read while `enabled` is false, such as when the guide is hidden.
 */
export function useHasEntry(groupIds: string[], enabled: boolean) {
  return useQuery({
    queryKey: firstEntryKey(groupIds),
    enabled: enabled && groupIds.length > 0,
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Transactions>({
        databaseId: DATABASE_ID,
        tableId: 'transactions',
        queries: [
          // Someone who has joined more than 100 groups isn't new.
          Query.equal('groupId', groupIds.slice(0, PAGE)),
          Query.select(['$id']),
          Query.limit(1),
        ],
      })
      return rows.length > 0
    },
  })
}

const hiddenKey = (userId: string) => `ledgerly:onboarding-hidden:${userId}`

/** Whether this user hid the guide on this device. Storage that can't be read hides nothing. */
export function isHidden(userId: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(userId)) !== null
  } catch {
    return false
  }
}

/** Hides the guide for this user on this device. Blocked storage just shows it next visit. */
export function storeHidden(userId: string): void {
  try {
    localStorage.setItem(hiddenKey(userId), '1')
  } catch {
    // Nothing to do: the guide hides for now, and shows again next visit.
  }
}
