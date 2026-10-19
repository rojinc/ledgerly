import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { useQueries } from '@tanstack/react-query'
import { queryKeys } from '../../lib/query-keys'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useMembers } from '../transactions/use-transactions'

type Named = Pick<Groups, '$id' | 'type' | 'name'>

function useMyPersonId(): string {
  const userId = useCurrentUser().data?.$id ?? ''
  return useBootstrap(userId).data?.personId ?? ''
}

function shownName(group: Named, personId: string, members: Members[] | undefined): string {
  const other = personId
    ? members?.find((member) => member.personId !== personId)?.displayName
    : undefined
  return (group.type === 'pair' && other) || group.name
}

/**
 * A group's name as the viewer should see it. A pair group's own `name` is its creator's label
 * for the other person, which is the viewer when the viewer was added, so a pair is named by its
 * other member instead (#145). Until the viewer's person and the members are known, either member
 * could be the other one, so it's the group's `name` until then. Other groups keep their name.
 */
export function useGroupName(group: Named): string {
  const personId = useMyPersonId()
  const members = useMembers(group.type === 'pair' ? group.$id : '')
  return shownName(group, personId, members.data)
}

/** `useGroupName` for a list, where each item needs its own hook. */
export function GroupName({ group }: { group: Named }) {
  return useGroupName(group)
}

/**
 * `groups` sorted by the names `useGroupName` shows, so a pair sorts under its other member
 * (#147 O11). It reads the members the rows' `useGroupName` loads, and loads none itself, so the
 * list may move once as they arrive.
 */
export function useSortedByName<T extends Named>(groups: T[]): T[] {
  const personId = useMyPersonId()
  const pairs = groups.filter((group) => group.type === 'pair')
  const members = useQueries({
    queries: pairs.map((group) => ({
      queryKey: queryKeys.members(group.$id),
      // Watches the rows' members query without fetching. No queryFn: one here (even skipToken)
      // would replace the rows' on the shared query, and a later invalidation couldn't refetch.
      enabled: false,
    })),
  })
  const membersOf = new Map(
    pairs.map((group, index) => [group.$id, members[index]?.data as Members[] | undefined]),
  )
  const names = new Map(
    groups.map((group) => [group.$id, shownName(group, personId, membersOf.get(group.$id))]),
  )
  return [...groups].sort((a, b) => (names.get(a.$id) ?? '').localeCompare(names.get(b.$id) ?? ''))
}
