import { useMutation } from '@tanstack/react-query'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { authErrorMessage } from '../auth/auth-error'
import { signOutOtherSessions } from '../auth/sign-out-other-sessions'

function signedOut(count: number) {
  if (count === 0) return 'You weren’t signed in anywhere else.'
  return `Signed out of ${count} other ${count === 1 ? 'device' : 'devices'}.`
}

/** Signs out every session but this one (#290), as signing in after a password reset does. */
export function OtherDevicesSection() {
  const signOut = useMutation({ mutationFn: signOutOtherSessions })
  return (
    <section aria-labelledby="devices-heading" className="flex flex-col gap-4">
      <h2 id="devices-heading" className="text-lg font-semibold">
        Other devices
      </h2>
      <p className="text-sm text-muted-foreground">
        Signed in somewhere you don’t recognise? Sign out everywhere but here.
      </p>
      {/* Mounted from the start, so the message is read out. */}
      <p role="status" className="text-sm empty:sr-only">
        {signOut.isSuccess ? signedOut(signOut.data) : ''}
      </p>
      {signOut.isError && <Alert variant="destructive">{authErrorMessage(signOut.error)}</Alert>}
      {/* aria-disabled, not disabled: a disabled button loses focus. */}
      <Button
        variant="outline"
        // Wraps at large text sizes rather than running past a phone's edge.
        className="h-auto min-h-10 self-start whitespace-normal"
        aria-disabled={signOut.isPending}
        onClick={() => !signOut.isPending && signOut.mutate()}
      >
        {signOut.isPending ? 'Signing out…' : 'Sign out other devices'}
      </Button>
    </section>
  )
}
