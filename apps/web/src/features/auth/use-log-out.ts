import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'

/** After a sign-out: drop every cached row so the next user never sees this user's data. */
export function forgetUser(queryClient: QueryClient) {
  queryClient.clear()
  queryClient.setQueryData(queryKeys.currentUser, null)
}

export function useLogOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: () => account.deleteSession({ sessionId: 'current' }),
    onSuccess: () => {
      forgetUser(queryClient)
      navigate('/login', { replace: true })
    },
  })
}
