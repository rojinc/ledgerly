import type { Profiles } from '@ledgerly/core/generated/rows'
import { type BootstrapBody, bootstrapBodySchema } from '@ledgerly/core/schemas/identity'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'

export type BootstrapResult = {
  profile: Profiles
  personId: string
  personalGroupId: string
  linkedGroupIds: string[]
}

/** The browser's IANA time zone for a new profile, or UTC if the schema rejects it. */
export function bootstrapBody(): BootstrapBody {
  const parsed = bootstrapBodySchema.safeParse({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  return parsed.success ? parsed.data : { timezone: 'UTC' }
}

class SessionEnded extends Error {}

/** A rejected request: sending it again can't change the answer. */
class Rejected extends Error {}

/**
 * `identity POST /bootstrap`, once per session and user: the query never goes
 * stale, and log out clears the cache. It is idempotent, so a retry is safe.
 */
export function useBootstrap(userId: string) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.bootstrap(userId),
    queryFn: async () => {
      const result = await callFunction<BootstrapResult>(
        'identity',
        'POST',
        '/bootstrap',
        bootstrapBody(),
      )
      if (!result.ok) {
        if (result.error.code === 'UNAUTHENTICATED') {
          // The session ended: RequireAuth sends them to /login.
          queryClient.setQueryData(queryKeys.currentUser, null)
          throw new SessionEnded(result.error.message)
        }
        if (result.error.code === 'VALIDATION_FAILED') throw new Rejected(result.error.message)
        throw new Error(result.error.message)
      }
      // The profile row ID is the user ID, so the profile page needn't fetch it again.
      queryClient.setQueryData(queryKeys.profile(userId), result.data.profile)
      return result.data
    },
    // Only UNAUTHENTICATED and VALIDATION_FAILED are final; anything else, including INTERNAL
    // for a lost connection, may pass next time.
    retry: (failures, error) =>
      !(error instanceof SessionEnded || error instanceof Rejected) && failures < 3,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
