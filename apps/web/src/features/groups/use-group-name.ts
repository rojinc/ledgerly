import type { Groups } from '@ledgerly/core/generated/rows'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useMembers } from '../transactions/use-transactions'

/**
 * A group's name as the viewer should see it. A pair group's own `name` is its creator's label
 * for the other person, which is the viewer when the viewer was added, so a pair is named by its
 * other member instead (#145). Until the viewer's person and the members are known, either member
 * could be the other one, so it's the group's `name` until then. Other groups keep their name.
 */
export function useGroupName(group: Pick<Groups, '$id' | 'type' | 'name'>): string {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  const members = useMembers(group.type === 'pair' ? group.$id : '')
  const other = personId
    ? members.data?.find((member) => member.personId !== personId)?.displayName
    : undefined
  return (group.type === 'pair' && other) || group.name
}

/** `useGroupName` for a list, where each item needs its own hook. */
export function GroupName({ group }: { group: Pick<Groups, '$id' | 'type' | 'name'> }) {
  return useGroupName(group)
}
