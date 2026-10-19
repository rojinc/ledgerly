import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../../lib/query-keys'
import { forgetUser } from './use-log-out'

// The real client needs the app's environment; forgetUser never calls it.
vi.mock('../../lib/appwrite', () => ({ account: {} }))

describe('forgetUser', () => {
  it('drops every cached row and leaves no current user', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.currentUser, { $id: 'u1' })
    queryClient.setQueryData(['groups'], [{ $id: 'g1' }])
    forgetUser(queryClient)
    expect(queryClient.getQueryData(['groups'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.currentUser)).toBeNull()
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([queryKeys.currentUser])
  })
})
