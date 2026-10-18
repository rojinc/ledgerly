import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import { queryKeys } from '../../lib/query-keys'

/** After a session is created: reload the user and go back where they came from. */
export function useSignedIn() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  return async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
    navigate(from, { replace: true })
  }
}
