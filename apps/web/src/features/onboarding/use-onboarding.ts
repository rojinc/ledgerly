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
 * `transactions.idx_group_date`. True once the user has recorded something, and the guide is done:
 * that's remembered on this device, so later visits don't read again. Not read while `enabled` is
 * false. Read once per Home visit and never kept: a cached "no entry" would show the guide again
 * after the first one.
 */
export function useHasEntry(userId: string, groupIds: string[], enabled: boolean) {
  return useQuery({
    queryKey: firstEntryKey(groupIds),
    enabled: enabled && groupIds.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
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
      if (rows.length === 0) return false
      store(doneKey(userId))
      return true
    },
  })
}

const hiddenKey = (userId: string) => `ledgerly:onboarding-hidden:${userId}`
const doneKey = (userId: string) => `ledgerly:onboarding-done:${userId}`

/** Whether this device holds the key. Storage that can't be read holds nothing. */
function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

/** Keeps the key on this device. Blocked storage keeps nothing: the next visit asks again. */
function store(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // Nothing to do: it holds for now, and the next visit works it out again.
  }
}

/** Whether this user hid the guide on this device. */
export const isHidden = (userId: string) => stored(hiddenKey(userId))

/** Hides the guide for this user on this device. */
export const storeHidden = (userId: string) => store(hiddenKey(userId))

/** Whether this device already saw an entry of this user's: the guide is done for good. */
export const isDone = (userId: string) => stored(doneKey(userId))
