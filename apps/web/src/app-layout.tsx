import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NavLink, Outlet } from 'react-router'
import { authErrorMessage } from './features/auth/auth-error'
import { useLogOut } from './features/auth/use-log-out'
import { VerifyEmailBanner } from './features/auth/verify-email-banner'
import { useRealtimeSync } from './lib/realtime'
import { cn } from './lib/utils'
import { Alert } from './ui/alert'
import { Button } from './ui/button'

// Only screens that exist. Each feature adds its own entry when it lands.
const NAV = [
  { to: '/', label: 'Home' },
  { to: '/today', label: 'Today' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/transactions', label: 'History' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/groups', label: 'Groups' },
  { to: '/people', label: 'People' },
  { to: '/bills', label: 'Bills' },
  { to: '/activity', label: 'Activity' },
  { to: '/profile', label: 'Profile' },
]

/**
 * The menu moves to the left side from here up (#194). In `rem`, so it follows the browser's
 * font size; the page's left padding comes from this too, so the two never disagree (#205).
 */
const WIDE = '(min-width: 48rem)'

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia?.(WIDE)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

/** Whether the screen is wide enough for the side menu. */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia?.(WIDE).matches ?? false)
}

export function AppLayout() {
  const logOut = useLogOut()
  // Other people's changes refresh what's on screen while signed in (#48).
  useRealtimeSync()
  const wide = useWide()
  const logOutButton = (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 justify-start"
      aria-disabled={logOut.isPending}
      onClick={() => {
        if (!logOut.isPending) logOut.mutate()
      }}
    >
      Log out
    </Button>
  )
  return (
    <div className={cn('flex min-h-dvh flex-col', wide && 'pl-56')}>
      {/* The first Tab stop, past the menu to the page, shown only while focused: the browser
          focuses <main>, which takes focus from a link (#539). */}
      <a
        href="#main"
        className="sr-only rounded-md bg-background text-sm font-medium outline-none focus:not-sr-only focus:fixed focus:px-3 focus:py-2 focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      {wide ? (
        // Scrolls on a short screen (a phone on its side), so Log out can always be reached. A
        // header, as on a phone, so the brand is inside a landmark (#539).
        <header className="fixed inset-y-0 left-0 flex w-56 flex-col gap-4 overflow-y-auto border-r border-border bg-background px-3 py-4">
          <span className="px-3 font-semibold">Ledgerly</span>
          <NavList className="flex-1" />
          {logOutButton}
        </header>
      ) : (
        <PhoneMenu logOut={logOutButton} />
      )}
      {logOut.isError && (
        <Alert variant="destructive" className="mx-auto mt-3 w-[calc(100%-2rem)] max-w-3xl">
          {authErrorMessage(logOut.error)}
        </Alert>
      )}
      <VerifyEmailBanner />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none"
      >
        <Outlet />
      </main>
    </div>
  )
}

/** The one main menu, as a vertical list, for both layouts. */
function NavList({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className={className}>
      <ul className="flex flex-col gap-1">
        {NAV.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              // Home only on `/`; other items stay active on their subpages.
              end={item.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  // A bar and bold text, not colour alone, mark the current page.
                  'block rounded-md border-l-4 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isActive
                    ? 'border-primary bg-muted font-semibold'
                    : 'border-transparent text-muted-foreground hover:bg-muted',
                )
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Below the wide breakpoint: a slim bar, and a Menu button that opens the list below it. */
function PhoneMenu({ logOut }: { logOut: ReactNode }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const header = useRef<HTMLElement>(null)
  // Escape in the menu closes it and puts focus back on Menu; one typed in a page field doesn't.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !header.current?.contains(event.target as Node)) return
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <header ref={header} className="border-b border-border">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="font-semibold">Ledgerly</span>
        <Button
          ref={button}
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls="main-menu"
          onClick={() => setOpen((was) => !was)}
        >
          Menu
        </Button>
      </div>
      {/* Closed, it's hidden from everyone, so only one main menu is ever there. */}
      <div
        id="main-menu"
        hidden={!open}
        className={cn(open && 'flex', 'flex-col gap-1 border-t border-border px-4 py-2')}
      >
        <NavList onNavigate={() => setOpen(false)} />
        {logOut}
      </div>
    </header>
  )
}
