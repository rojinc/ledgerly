import type { Groups } from '@ledgerly/core/generated/rows'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { callFunction } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { Button } from '../../ui/button'
import { useCurrentUser } from '../auth/use-current-user'

// Local to this file: the shared keys file is outside #34's Scope.
const pendingKey = (userId: string) => ['pendingGroups', userId] as const

/** A group's type in words; the groups list uses it too. */
export const TYPE_LABEL: Record<Groups['type'], string> = {
  personal: 'Personal',
  employer: 'Employer',
  house: 'House',
  pair: 'Shared with one person',
}

/** What `identity GET /groups/pending` answers (functions-api.md#identity). */
type PendingGroup = Pick<Groups, 'type' | 'name' | 'archivedAt'> & { id: string }

/**
 * Groups the user was added to but hasn't joined (D-016), each with Join. Shows nothing when
 * there are none, or when they can't be read: the joined groups above still work.
 */
export function PendingGroups() {
  const userId = useCurrentUser().data?.$id ?? ''
  const pending = useQuery({
    queryKey: pendingKey(userId),
    enabled: userId !== '',
    queryFn: async () => {
      const result = await callFunction<{ groups: PendingGroup[] }>(
        'identity',
        'GET',
        '/groups/pending',
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.data.groups
    },
  })
  if (!pending.data || pending.data.length === 0) return null
  return (
    <section aria-labelledby="pending-groups" className="flex flex-col gap-2">
      <h2 id="pending-groups" className="font-medium">
        Waiting for you to join
      </h2>
      <p className="text-sm text-muted-foreground">
        Someone added you to these. Join to see what they’ve recorded.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {pending.data.map((group) => (
          <PendingRow key={group.id} group={group} />
        ))}
      </ul>
    </section>
  )
}

function PendingRow({ group }: { group: PendingGroup }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  const join = useMutation({
    mutationFn: async () => {
      const result = await callFunction('identity', 'POST', `/groups/${group.id}/join`)
      if (!result.ok) throw new Error(result.error.message)
    },
    // Joined: it's one of the user's groups now, and no longer waiting.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) }),
        queryClient.invalidateQueries({ queryKey: pendingKey(userId) }),
      ]),
  })
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">{group.name}</p>
          <p className="text-sm text-muted-foreground">
            {TYPE_LABEL[group.type]}
            {group.archivedAt ? ' · Archived' : ''}
          </p>
        </div>
        {/* Named for its group: every row has a Join button. */}
        <Button
          size="sm"
          onClick={() => join.mutate()}
          disabled={join.isPending}
          aria-label={`Join ${group.name}`}
        >
          {join.isPending ? 'Joining…' : 'Join'}
        </Button>
      </div>
      {join.isError && (
        <p role="alert" className="text-sm text-destructive">
          {join.error.message}
        </p>
      )}
    </li>
  )
}
