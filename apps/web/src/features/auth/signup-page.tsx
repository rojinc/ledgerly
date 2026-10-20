import { useMutation } from '@tanstack/react-query'
import { ID } from 'appwrite'
import type { FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { account } from '../../lib/appwrite'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { AuthCard } from './auth-card'
import { authErrorMessage } from './auth-error'
import { useSignedIn } from './use-signed-in'
import { verificationUrl } from './verify-email-page'

export function SignupPage() {
  const signedIn = useSignedIn()
  // Passed on to log-in, so logging in there still goes back where they were going.
  const from = (useLocation().state as { from?: string } | null)?.from
  const signup = useMutation({
    mutationFn: async (input: { name: string; email: string; password: string }) => {
      await account.create({ userId: ID.unique(), ...input })
      await account.createEmailPasswordSession({ email: input.email, password: input.password })
      // The banner in the app offers "Send it again", so a failed send shouldn't block sign-up.
      await account.createEmailVerification({ url: verificationUrl() }).catch(() => undefined)
    },
    onSuccess: signedIn,
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (signup.isPending) return
    const form = new FormData(event.currentTarget)
    signup.mutate({
      name: String(form.get('name')).trim(),
      email: String(form.get('email')).trim(),
      password: String(form.get('password')),
    })
  }

  return (
    <AuthCard title="Create your account">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {signup.isError && <Alert variant="destructive">{authErrorMessage(signup.error)}</Alert>}
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required maxLength={128} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="text-sm text-muted-foreground">
            At least 8 characters.
          </p>
        </div>
        <Button type="submit" aria-disabled={signup.isPending}>
          {signup.isPending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          to="/login"
          state={{ from }}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Log in
        </Link>
      </p>
    </AuthCard>
  )
}
