import type { Groups } from '@ledgerly/core/generated/rows'
import type { PendingGroup, PendingGroupsResult } from '@ledgerly/core/schemas/identity'
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

/**
 * Groups the user was added to but hasn't joined (D-016), each with Join. Shows nothing when
 * there are none, or when they can't be read: the joined groups above still work. `onJoined`
 * gets the group's name once it's joined, since its row (and the focused Join button) goes away.
 */
export function PendingGroups({ onJoined }: { onJoined: (name: string) => void }) {
  const userId = useCurrentUser().data?.$id ?? ''
  const pending = useQuery({
    queryKey: pendingKey(userId),
    enabled: userId !== '',
    queryFn: async () => {
      const result = await callFunction<PendingGroupsResult>('identity', 'GET', '/groups/pending')
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
          <PendingRow key={group.id} group={group} onJoined={onJoined} />
        ))}
      </ul>
    </section>
  )
}

function PendingRow({
  group,
  onJoined,
}: {
  group: PendingGroup
  onJoined: (name: string) => void
}) {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  // A pair group's own name is what its creator calls the caller: show who added them instead.
  const name = group.counterpartName ?? group.name
  const join = useMutation({
    mutationFn: async () => {
      const result = await callFunction('identity', 'POST', `/groups/${group.id}/join`)
      if (!result.ok) {
        // Not in it any more (or never was): the list is out of date, so read it again.
        if (result.error.code === 'NOT_A_MEMBER') {
          void queryClient.invalidateQueries({ queryKey: pendingKey(userId) })
        }
        throw new Error(result.error.message)
      }
    },
    // Joined: it's one of the user's groups now, and no longer waiting.
    onSuccess: () => {
      onJoined(name)
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) }),
        queryClient.invalidateQueries({ queryKey: pendingKey(userId) }),
      ])
    },
  })
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">{name}</p>
          <p className="text-sm text-muted-foreground">
            {TYPE_LABEL[group.type]}
            {group.archivedAt ? ' · Archived' : ''}
          </p>
        </div>
        {/* Named for its group: every row has a Join button. */}
        {/* aria-disabled, not disabled: a disabled button loses focus. */}
        <Button
          size="sm"
          onClick={() => !join.isPending && join.mutate()}
          aria-disabled={join.isPending}
          aria-label={`Join ${name}`}
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
