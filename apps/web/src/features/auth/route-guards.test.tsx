import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { RedirectIfSignedIn, RequireAuth } from './route-guards'

vi.mock('../../lib/appwrite', () => ({ account: { get: vi.fn() } }))

const getUser = vi.mocked(account.get)

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
  })

  it('sends a signed-out user to /login and remembers where they were going', async () => {
    getUser.mockRejectedValue(new AppwriteException('No session', 401))
    const router = renderAt('/secret')
    expect(await screen.findByText('Login page')).toBeTruthy()
    expect(router.state.location.state).toEqual({ from: '/secret' })
  })

  it('shows a protected page to a signed-in user', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    renderAt('/secret')
    expect(await screen.findByText('Secret page')).toBeTruthy()
  })

  it('sends a signed-in user away from /login', async () => {
    getUser.mockResolvedValue({ $id: 'u1' } as never)
    renderAt('/login')
    expect(await screen.findByText('Home page')).toBeTruthy()
  })
})
