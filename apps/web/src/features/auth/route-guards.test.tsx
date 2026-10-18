import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { RedirectIfSignedIn, RequireAuth } from './route-guards'

vi.mock('../../lib/appwrite', () => ({ account: { get: vi.fn() } }))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))

const getUser = vi.mocked(account.get)
const call = vi.mocked(callFunction)

function bootstrapped(linkedGroupIds: string[] = []) {
  return {
    ok: true as const,
    data: { profile: { $id: 'u1' }, personId: 'p1', personalGroupId: 'g0', linkedGroupIds },
  }
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <RedirectIfSignedIn />,
        children: [{ path: 'login', element: <p>Login page</p> }],
      },
      { element: <RequireAuth />, children: [{ path: 'secret', element: <p>Secret page</p> }] },
      { path: '/', element: <p>Home page</p> },
    ],
    { initialEntries: [path] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('route guards', () => {
  afterEach(() => {
    cleanup()
    getUser.mockReset()
    call.mockReset()
  })

  it('sends a signed-out user to /login and remembers where they were going', async () => {
    getUser.mockRejectedValue(new AppwriteException('No session', 401))
    const router = renderAt('/secret?tab=2#top')
    expect(await screen.findByText('Login page')).toBeTruthy()
    expect(router.state.location.state).toEqual({ from: '/secret?tab=2#top' })
  })

  it('shows a retryable error instead of the login page when Appwrite is unreachable', async () => {
    getUser.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    getUser.mockResolvedValueOnce({ $id: 'u1' } as never)
    call.mockResolvedValue(bootstrapped())
    renderAt('/secret')
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Secret page')).toBeTruthy()
  })

  it('bootstraps a signed-in user once, with the browser time zone, before the page', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValue(bootstrapped())
    renderAt('/secret')
    expect(await screen.findByText('Secret page')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/bootstrap', {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    expect(screen.queryByText(/We found/)).toBeNull()
  })

  it('says how many groups were linked', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValue(bootstrapped(['g1', 'g2']))
    renderAt('/secret')
    expect(await screen.findByText('We found 2 groups you were added to.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/We found/)).toBeNull()
  })

  it('shows a retryable error when bootstrap fails', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Boom' } })
    call.mockResolvedValueOnce(bootstrapped(['g1']))
    renderAt('/secret')
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Secret page')).toBeTruthy()
    expect(screen.getByText('We found 1 group you were added to.')).toBeTruthy()
  })

  it('sends a signed-in user away from /login', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    renderAt('/login')
    expect(await screen.findByText('Home page')).toBeTruthy()
  })
})
