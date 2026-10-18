import { Navigate, Outlet, useLocation } from 'react-router'
import { useCurrentUser } from './use-current-user'

function Loading() {
  return (
    <p role="status" className="p-6 text-center text-muted-foreground">
      Loading…
    </p>
  )
}

/** Renders child routes only for a signed-in user; everyone else goes to /login. */
export function RequireAuth() {
  const { data: user, isPending } = useCurrentUser()
  const location = useLocation()
  if (isPending) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

/** Keeps a signed-in user away from the login and sign-up pages. */
export function RedirectIfSignedIn() {
  const { data: user, isPending } = useCurrentUser()
  if (isPending) return <Loading />
  if (user) return <Navigate to="/" replace />
  return <Outlet />
}
