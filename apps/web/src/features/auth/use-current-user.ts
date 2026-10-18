import { useQuery } from '@tanstack/react-query'
import { AppwriteException } from 'appwrite'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'

/** The signed-in Appwrite user, or `null` when nobody is signed in. */
export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: async () => {
      try {
        return await account.get()
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 401) return null
        throw error
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
  })
}
