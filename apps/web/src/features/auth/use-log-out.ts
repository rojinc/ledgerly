import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'

export function useLogOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: () => account.deleteSession({ sessionId: 'current' }),
    onSuccess: () => {
      // Drop every cached row so the next user never sees this user's data.
      queryClient.clear()
      queryClient.setQueryData(queryKeys.currentUser, null)
      navigate('/login', { replace: true })
    },
  })
}
