import { NavLink, Outlet } from 'react-router'
import { useLogOut } from './features/auth/use-log-out'
import { VerifyEmailBanner } from './features/auth/verify-email-banner'
import { cn } from './lib/utils'
import { Button } from './ui/button'

// Only screens that exist. Each feature adds its own entry when it lands.
const NAV = [{ to: '/', label: 'Home' }]

export function AppLayout() {
  const logOut = useLogOut()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-2">
          <span className="font-semibold">Ledgerly</span>
          <nav aria-label="Main" className="flex flex-1 gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
            disabled={logOut.isPending}
            onClick={() => logOut.mutate()}
          >
            Log out
          </Button>
        </div>
      </header>
      <VerifyEmailBanner />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
