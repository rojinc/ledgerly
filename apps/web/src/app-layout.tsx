import { NavLink, Outlet } from 'react-router'
import { authErrorMessage } from './features/auth/auth-error'
import { useLogOut } from './features/auth/use-log-out'
import { VerifyEmailBanner } from './features/auth/verify-email-banner'
import { cn } from './lib/utils'
import { Alert } from './ui/alert'
import { Button } from './ui/button'

// Only screens that exist. Each feature adds its own entry when it lands.
const NAV = [
  { to: '/', label: 'Home' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/groups', label: 'Groups' },
  { to: '/profile', label: 'Profile' },
]

export function AppLayout() {
  const logOut = useLogOut()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        {/* On a phone the tabs get their own row, and scroll if they still don't fit. */}
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <span className="font-semibold">Ledgerly</span>
          <nav
            aria-label="Main"
            className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:px-0"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                // Home only on `/`; other tabs stay active on their subpages.
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    // Inset: the nav scrolls on a phone, which clips a ring drawn outside the tab.
                    'shrink-0 rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto sm:ml-0"
            disabled={logOut.isPending}
            onClick={() => logOut.mutate()}
          >
            Log out
          </Button>
        </div>
      </header>
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
