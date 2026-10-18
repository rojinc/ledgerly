import type { Profiles } from '@ledgerly/core/generated/rows'
import type { BootstrapBody } from '@ledgerly/core/schemas/identity'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'

export type BootstrapResult = {
  profile: Profiles
  personId: string
  personalGroupId: string
  linkedGroupIds: string[]
}

/** The browser's IANA time zone, used for a new profile. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * `identity POST /bootstrap`, once per session: the query never goes stale, and
 * log out clears the cache. It is idempotent, so a retry is safe.
 */
export function useBootstrap(enabled = true) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.bootstrap,
    queryFn: async () => {
      const body: BootstrapBody = { timezone: browserTimeZone() }
      const result = await callFunction<BootstrapResult>('identity', 'POST', '/bootstrap', body)
      if (!result.ok) throw new Error(result.error.message)
      // The profile row ID is the user ID, so the profile page needn't fetch it again.
      queryClient.setQueryData(queryKeys.profile(result.data.profile.$id), result.data.profile)
      return result.data
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
