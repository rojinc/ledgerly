import type { Groups, Members } from '@ledgerly/core/generated/rows'
import type {
  AddMemberBody,
  CreateGroupBody,
  CreateGroupResult,
  UpdateGroupBody,
  UpdateMemberBody,
} from '@ledgerly/core/schemas/groups'
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { callFunction, type ErrorCode, type Method } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { writeErrorMessage } from '../groups/archive-group'

/** A groups refusal, keeping its code so a page can say more than the message. */
export class GroupsError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Calls the groups function; a refusal throws its message in plain words (#37). */
async function groups<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const result = await callFunction<T>('groups', method, path, body)
  if (!result.ok) throw new GroupsError(result.error.code, writeErrorMessage(result.error))
  return result.data
}

/** Who is signed in, and their person, for the keys a write refreshes. */
function useCaller() {
  const userId = useCurrentUser().data?.$id ?? ''
  const personId = useBootstrap(userId).data?.personId ?? ''
  return { userId, personId }
}

type Caller = ReturnType<typeof useCaller>

/** After a write: the house, the groups list, its members and the caller's role, as stored now. */
async function refresh(queryClient: QueryClient, { userId, personId }: Caller, groupId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.members(groupId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.myMember(groupId, personId) }),
  ])
}

/** `POST /groups` for a new house. */
export function useCreateHouse() {
  const userId = useCurrentUser().data?.$id ?? ''
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateGroupBody) => groups<CreateGroupResult>('POST', '/groups', body),
    onSuccess: async ({ group }) => {
      queryClient.setQueryData(queryKeys.group(group.$id), group)
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    },
  })
}

/** `PATCH /groups/{id}`: the house's settings. */
export function useUpdateHouse(groupId: string) {
  const caller = useCaller()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateGroupBody) => groups<Groups>('PATCH', `/groups/${groupId}`, body),
    onSuccess: async (group) => {
      queryClient.setQueryData(queryKeys.group(groupId), group)
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(caller.userId) })
    },
    // The house or the caller's role may have changed: show what's true now.
    onError: () => refresh(queryClient, caller, groupId),
  })
}

/** `POST /groups/{id}/members`, `PATCH` and `DELETE` on one member. */
export function useMemberWrites(groupId: string) {
  const caller = useCaller()
  const queryClient = useQueryClient()
  const done = () => refresh(queryClient, caller, groupId)
  const add = useMutation({
    mutationFn: (body: AddMemberBody) =>
      groups<Members>('POST', `/groups/${groupId}/members`, body),
    onSettled: done,
  })
  const update = useMutation({
    mutationFn: ({ memberId, body }: { memberId: string; body: UpdateMemberBody }) =>
      groups<Members>('PATCH', `/groups/${groupId}/members/${memberId}`, body),
    onSettled: done,
  })
  const remove = useMutation({
    mutationFn: (memberId: string) =>
      groups<Record<string, never>>('DELETE', `/groups/${groupId}/members/${memberId}`),
    onSettled: done,
  })
  return { add, update, remove }
}

/**
 * `POST /groups/{id}/leave`. Once it has finished the caller is out of the team, so a retry gets
 * `NOT_A_MEMBER`, which counts as done (functions-api.md#groups).
 */
export function useLeaveHouse(groupId: string) {
  const { userId, personId } = useCaller()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      try {
        await groups<Record<string, never>>('POST', `/groups/${groupId}/leave`)
      } catch (error) {
        if (!(error instanceof GroupsError && error.code === 'NOT_A_MEMBER')) throw error
      }
    },
    onSuccess: async () => {
      // The caller can't read the house any more: drop what's cached, so Back doesn't show it
      // as it was, with buttons that would all get NOT_A_MEMBER. Removing a query doesn't tell
      // its observers, so the page still open doesn't fetch it again before it goes.
      for (const queryKey of [
        queryKeys.group(groupId),
        queryKeys.members(groupId),
        queryKeys.myMember(groupId, personId),
      ]) {
        queryClient.removeQueries({ queryKey, exact: true })
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
    },
  })
}
