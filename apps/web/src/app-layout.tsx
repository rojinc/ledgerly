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
  { to: '/groups', label: 'Groups' },
  { to: '/people', label: 'People' },
  { to: '/bills', label: 'Bills' },
  { to: '/profile', label: 'Profile' },
]

/** Tailwind's `md`: the menu moves to the left side from here up (#194). */
const WIDE = '(min-width: 768px)'

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
      className="justify-start"
      aria-disabled={logOut.isPending}
      onClick={() => {
        if (!logOut.isPending) logOut.mutate()
      }}
    >
      Log out
    </Button>
  )
  return (
    <div className="flex min-h-dvh flex-col md:pl-56">
      {wide ? (
        <aside className="fixed inset-y-0 left-0 flex w-56 flex-col gap-4 border-r border-border px-3 py-4">
          <span className="px-3 font-semibold">Ledgerly</span>
          <NavList className="flex-1" />
          {logOutButton}
        </aside>
      ) : (
        <PhoneMenu logOut={logOutButton} />
      )}
      {logOut.isError && (
        <Alert variant="destructive" className="mx-auto mt-3 w-[calc(100%-2rem)] max-w-3xl">
          {authErrorMessage(logOut.error)}
        </Alert>
      )}
      <VerifyEmailBanner />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
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

/** Under 768 px: a slim bar, and a Menu button that opens the list below it. */
function PhoneMenu({ logOut }: { logOut: ReactNode }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Escape closes it and puts focus back on Menu.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <header className="border-b border-border">
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
