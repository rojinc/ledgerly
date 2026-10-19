import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from './app-layout'

const logOut = { isPending: false, isError: false, mutate: vi.fn() }
vi.mock('./features/auth/use-log-out', () => ({ useLogOut: () => logOut }))
vi.mock('./features/auth/verify-email-banner', () => ({ VerifyEmailBanner: () => null }))
vi.mock('./lib/realtime', () => ({ useRealtimeSync: () => {} }))

// jsdom has no matchMedia: a screen of a given width that can change.
let width = 1280
const listeners = new Set<() => void>()
function resize(to: number) {
  width = to
  act(() => {
    for (const listener of listeners) listener()
  })
}
beforeEach(() => {
  width = 1280
  logOut.isPending = false
  window.matchMedia = vi.fn((query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1]),
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as never
})

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/', element: <AppLayout />, children: [{ path: '*', element: null }] }],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  cleanup()
  listeners.clear()
  vi.clearAllMocks()
})

describe('AppLayout, 768 px and wider', () => {
  it('puts the menu down the left side, with Log out last', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(nav.closest('aside')?.className).toContain('fixed')
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull()
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Home',
      'Today',
      'Calendar',
      'History',
      'Groups',
      'People',
      'Bills',
      'Activity',
      'Profile',
    ])
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
  })

  it('marks an item as current on its subpages, with a bar and bold text too', () => {
    renderAt('/groups/g1/settings')
    const groups = screen.getByRole('link', { name: 'Groups' })
    expect(groups.getAttribute('aria-current')).toBe('page')
    expect(groups.className).toContain('font-semibold')
    expect(groups.className).toContain('border-primary')
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks Home as current only on the home page', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
  })

  it('keeps Log out focusable but does nothing while logging out', () => {
    logOut.isPending = true
    renderAt('/')
    const button = screen.getByRole('button', { name: 'Log out' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(logOut.mutate).not.toHaveBeenCalled()
  })
})

describe('AppLayout, under 768 px', () => {
  beforeEach(() => {
    width = 375
  })

  it('shows a Menu button that opens and closes the same list', () => {
    renderAt('/')
    const menu = screen.getByRole('button', { name: 'Menu' })
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(menu.getAttribute('aria-controls')).toBe('main-menu')
    // Closed: no main menu for anyone.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(document.getElementById('main-menu')?.hidden).toBe(true)
    fireEvent.click(menu)
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1)
    expect(screen.getAllByRole('link')).toHaveLength(9)
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    fireEvent.click(menu)
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
  })

  it('closes when an item is tapped', () => {
    const router = renderAt('/')
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('link', { name: 'Bills' }))
    expect(router.state.location.pathname).toBe('/bills')
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape and puts focus back on Menu', () => {
    renderAt('/')
    const menu = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(menu)
    const link = screen.getByRole('link', { name: 'Calendar' })
    link.focus()
    fireEvent.keyDown(link, { key: 'Escape' })
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(menu)
  })

  it('switches layout when the screen is resized', () => {
    renderAt('/')
    expect(screen.getByRole('button', { name: 'Menu' })).toBeTruthy()
    resize(1024)
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull()
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1)
  })
})
