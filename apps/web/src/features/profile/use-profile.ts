import type { Persons, Profiles } from '@ledgerly/core/generated/rows'
import type { UpdateProfileBody } from '@ledgerly/core/schemas/identity'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { callFunction } from '../../lib/api'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'

/** The user's `profiles` row (row ID = user ID). Bootstrap seeds it. */
export function useProfile(userId: string) {
  return useQuery({
    queryKey: queryKeys.profile(userId),
    queryFn: () =>
      tablesDB.getRow<Profiles>({ databaseId: DATABASE_ID, tableId: 'profiles', rowId: userId }),
  })
}

/** The user's own `persons` row, which holds their display name. */
export function usePerson(personId: string) {
  return useQuery({
    queryKey: queryKeys.person(personId),
    enabled: personId !== '',
    queryFn: () =>
      tablesDB.getRow<Persons>({ databaseId: DATABASE_ID, tableId: 'persons', rowId: personId }),
  })
}

/** `identity PATCH /profile`. Throws the function's error so forms can show it. */
export function useUpdateProfile(userId: string, personId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: UpdateProfileBody) => {
      const result = await callFunction<Profiles>('identity', 'PATCH', '/profile', body)
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: (profile, body) => {
      queryClient.setQueryData(queryKeys.profile(userId), profile)
      if (body.displayName !== undefined) {
        queryClient.invalidateQueries({ queryKey: queryKeys.person(personId) })
      }
    },
  })
}
