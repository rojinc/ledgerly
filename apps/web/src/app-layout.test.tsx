import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from './app-layout'

vi.mock('./features/auth/use-log-out', () => ({ useLogOut: () => ({ isPending: false }) }))
vi.mock('./features/auth/verify-email-banner', () => ({ VerifyEmailBanner: () => null }))
vi.mock('./lib/realtime', () => ({ useRealtimeSync: () => {} }))

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/', element: <AppLayout />, children: [{ path: '*', element: null }] }],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
}

afterEach(cleanup)

describe('AppLayout', () => {
  it('marks a tab as current on its subpages', () => {
    renderAt('/groups/g1/settings')
    expect(screen.getByRole('link', { name: 'Groups' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks Home as current only on the home page', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
  })
})
