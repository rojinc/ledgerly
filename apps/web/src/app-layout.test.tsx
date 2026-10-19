import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from './app-layout'

const logOut = { isPending: false, isError: false, mutate: vi.fn() }
vi.mock('./features/auth/use-log-out', () => ({ useLogOut: () => logOut }))
vi.mock('./features/auth/verify-email-banner', () => ({ VerifyEmailBanner: () => null }))
vi.mock('./lib/realtime', () => ({ useRealtimeSync: () => {} }))

// jsdom has no matchMedia: a screen of a given width, and browser font size, that can change.
let width = 1280
let fontSize = 16
/** A `(min-width: …)` query's width in px, in `px` or in `rem` (which follows the font size). */
function minWidth(query: string): number {
  const match = /min-width: ([\d.]+)(px|rem)/.exec(query)
  if (!match) return Number.NaN
  return Number(match[1]) * (match[2] === 'rem' ? fontSize : 1)
}
const listeners = new Set<() => void>()
function resize(to: number) {
  width = to
  act(() => {
    for (const listener of listeners) listener()
  })
}
beforeEach(() => {
  width = 1280
  fontSize = 16
  logOut.isPending = false
  window.matchMedia = vi.fn((query: string) => ({
    matches: width >= minWidth(query),
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
    const side = nav.parentElement as HTMLElement
    expect(side.className).toContain('fixed')
    // Scrolls on a short screen, over the page's own background.
    expect(side.className).toContain('overflow-y-auto')
    expect(side.className).toContain('bg-background')
    expect(screen.getByRole('button', { name: 'Log out' }).className).toContain('shrink-0')
    // No extra "complementary" landmark around the menu.
    expect(document.querySelector('aside')).toBeNull()
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

  it('leaves room for the side menu exactly when it shows, at any font size (#205)', () => {
    const page = () => document.querySelector('main')?.parentElement as HTMLElement
    for (const [size, at, wide] of [
      [16, 800, true],
      [16, 767, false],
      [20, 900, false],
      [20, 960, true],
      [14, 671, false],
      [14, 700, true],
    ] as const) {
      fontSize = size
      width = at
      renderAt('/')
      expect(Boolean(screen.queryByRole('button', { name: 'Menu' }))).toBe(!wide)
      expect(page().className.split(' ').includes('pl-56')).toBe(wide)
      cleanup()
    }
  })

  it('closes only on Escape, and only for a key pressed in the menu bar (#205)', () => {
    renderAt('/')
    const menu = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(menu)
    fireEvent.keyDown(screen.getByRole('link', { name: 'Calendar' }), { key: 'a' })
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    // Escape typed somewhere on the page isn't for the menu.
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(field)
    field.remove()
  })

  it('stops listening for Escape once the menu is closed (#205)', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    renderAt('/')
    const menu = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(menu)
    fireEvent.click(menu)
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function))
  })
})
