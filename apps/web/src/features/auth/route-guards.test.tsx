import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { RedirectIfSignedIn, RequireAuth } from './route-guards'
import { bootstrapBody } from './use-bootstrap'

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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

describe('route guards', () => {
  afterEach(() => {
    cleanup()
    getUser.mockReset()
    call.mockReset()
  })

  it('sends a signed-out user to /login and remembers where they were going', async () => {
    getUser.mockRejectedValue(new AppwriteException('No session', 401))
    const { router } = renderAt('/secret?tab=2#top')
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

  it('sends the user to /login when bootstrap finds the session has ended', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValue({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Log in' } })
    renderAt('/secret')
    expect(await screen.findByText('Login page')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shows a retryable error when bootstrap fails', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    // Three retries, then the error.
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Boom' } })
    renderAt('/secret')
    expect(await screen.findByText(/couldn’t set up your account/)).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(4)
    call.mockResolvedValue(bootstrapped(['g1']))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Secret page')).toBeTruthy()
    expect(screen.getByText('We found 1 group you were added to.')).toBeTruthy()
  })

  it('retries a CONFLICT', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: 'Again' } })
    call.mockResolvedValueOnce(bootstrapped())
    renderAt('/secret')
    expect(await screen.findByText('Secret page')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('does not retry a VALIDATION_FAILED', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValue({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'Bad' } })
    renderAt('/secret')
    expect(await screen.findByText(/couldn’t set up your account/)).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('keeps the app up when a background refetch of bootstrap fails', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    call.mockResolvedValueOnce(bootstrapped())
    const { queryClient } = renderAt('/secret')
    expect(await screen.findByText('Secret page')).toBeTruthy()
    // As after verifying an email, which re-runs bootstrap.
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Boom' } })
    await queryClient.invalidateQueries({ queryKey: ['bootstrap', 'u1'] })
    await waitFor(() => {
      expect(queryClient.getQueryState(['bootstrap', 'u1'])?.status).toBe('error')
      expect(screen.getByText('Secret page')).toBeTruthy()
      expect(screen.queryByText(/couldn’t set up your account/)).toBeNull()
    })
  })

  it('shows the error, not the login form, when the user refetch after signing in fails', async () => {
    getUser.mockRejectedValueOnce(new AppwriteException('No session', 401))
    const { router, queryClient } = renderAt('/login')
    expect(await screen.findByText('Login page')).toBeTruthy()
    // Signed in, but Appwrite can't be reached when the app asks who it is.
    getUser.mockRejectedValue(new TypeError('Failed to fetch'))
    await queryClient.invalidateQueries({ queryKey: ['currentUser'] })
    await router.navigate('/secret')
    expect(await screen.findByText(/couldn’t reach Ledgerly/)).toBeTruthy()
    expect(router.state.location.pathname).toBe('/secret')
  })

  it('sends a signed-in user away from /login', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    renderAt('/login')
    expect(await screen.findByText('Home page')).toBeTruthy()
  })
})

describe('bootstrapBody', () => {
  afterEach(() => vi.restoreAllMocks())

  it('falls back to UTC when the browser reports a zone the schema rejects', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Etc/Unknown',
    } as Intl.ResolvedDateTimeFormatOptions)
    expect(bootstrapBody()).toEqual({ timezone: 'UTC' })
  })
})
