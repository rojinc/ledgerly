import { useMutation } from '@tanstack/react-query'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { account } from '../../lib/appwrite'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { AuthCard, focusOnMount } from './auth-card'
import { authErrorMessage, errorType } from './auth-error'

// Appwrite answers these for an address with no account, or a blocked one (mid-deletion). The
// page answers as if it sent a link, so it never says which addresses have an account (#290).
const NO_LINK_SENT = new Set(['user_not_found', 'user_blocked'])

// 10 an hour for each address and each IP.
const RATE_LIMITED = 'You’ve asked for too many links. Try again in an hour.'

export function RecoverPage() {
  const recover = useMutation({
    mutationFn: async (email: string) => {
      try {
        // No query string: Appwrite adds userId, secret and expire to it.
        await account.createRecovery({ email, url: `${window.location.origin}/recover/complete` })
      } catch (error) {
        if (!NO_LINK_SENT.has(errorType(error) ?? '')) throw error
      }
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (recover.isPending) return
    recover.mutate(String(new FormData(event.currentTarget).get('email')).trim())
  }

  return (
    <AuthCard title="Reset your password">
      {recover.isSuccess ? (
        // Focused as it replaces the form, so it's read out and focus isn't lost.
        <Alert ref={focusOnMount} tabIndex={-1} className="outline-none">
          If that address has an account, we’ve sent a link. It works for 1 hour.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {recover.isError && (
            <Alert variant="destructive">
              {errorType(recover.error) === 'general_rate_limit_exceeded'
                ? RATE_LIMITED
                : authErrorMessage(recover.error)}
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            Enter your account’s email and we’ll send you a link to set a new password.
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <Button type="submit" aria-disabled={recover.isPending}>
            {recover.isPending ? 'Sending…' : 'Send link'}
          </Button>
        </form>
      )}
      <Link to="/login" className="text-center text-sm font-medium underline underline-offset-4">
        Back to log in
      </Link>
    </AuthCard>
  )
}
