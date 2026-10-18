import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { LinkedGroupsNotice } from './linked-groups-notice'
import { useBootstrap } from './use-bootstrap'
import { useCurrentUser } from './use-current-user'

/** Shows loading, or a retryable error, until the query has data. */
function UserGate({
  query,
  failure = 'We couldn’t reach Ledgerly. Check your connection and try again.',
  children,
}: {
  query: UseQueryResult
  failure?: string
  children: ReactNode
}) {
  if (query.isPending) {
    return (
      <p role="status" className="p-6 text-center text-muted-foreground">
        Loading…
      </p>
    )
  }
  // A failed background refetch keeps the data it had, so the app stays up. A cached `null`
  // user (signed out) is no answer to keep: after signing in it is out of date.
  if (query.isError && query.data == null) {
    return (
      <main className="mx-auto flex max-w-sm flex-col gap-4 px-4 py-10">
        <Alert variant="destructive">{failure}</Alert>
        <Button onClick={() => query.refetch()} disabled={query.isFetching}>
          Try again
        </Button>
      </main>
    )
  }
  return children
}

/**
 * Renders child routes only for a signed-in user whose person and profile exist
 * (`identity /bootstrap`); everyone else goes to /login.
 */
export function RequireAuth() {
  const query = useCurrentUser()
  const { pathname, search, hash } = useLocation()
  return (
    <UserGate query={query}>
      {query.data ? (
        <Bootstrapped userId={query.data.$id} />
      ) : (
        <Navigate to="/login" replace state={{ from: pathname + search + hash }} />
      )}
    </UserGate>
  )
}

function Bootstrapped({ userId }: { userId: string }) {
  const bootstrap = useBootstrap(userId)
  return (
    <UserGate query={bootstrap} failure="We couldn’t set up your account. Try again in a moment.">
      <LinkedGroupsNotice count={bootstrap.data?.linkedGroupIds.length ?? 0} />
      <Outlet />
    </UserGate>
  )
}

/** Keeps a signed-in user away from the login and sign-up pages. */
export function RedirectIfSignedIn() {
  const query = useCurrentUser()
  return <UserGate query={query}>{query.data ? <Navigate to="/" replace /> : <Outlet />}</UserGate>
}
