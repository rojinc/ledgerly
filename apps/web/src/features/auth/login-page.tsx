import { useMutation } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type FormEvent, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { account } from '../../lib/appwrite'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { AuthCard, focusOnMount } from './auth-card'
import { authErrorMessage } from './auth-error'
import { signOutOtherSessions } from './sign-out-other-sessions'
import { useSignedIn } from './use-signed-in'

type Mode = 'password' | 'code'

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('password')
  const reset = useSearchParams()[0].get('reset') === '1'
  // Passed on to sign-up, so signing up there still goes back where they were going.
  const from = (useLocation().state as { from?: string } | null)?.from
  const signedIn = useSignedIn()
  // After a password reset (#290), signing in signs out every other session: the reset leaves
  // them signed in, so this is what locks out anyone else who had one.
  const others = useMutation({ mutationFn: signOutOtherSessions, onSuccess: signedIn })
  const onSignedIn = reset ? () => others.mutate() : signedIn

  if (!others.isIdle) {
    return (
      <AuthCard title="Log in">
        {others.isError ? (
          <>
            <Alert ref={focusOnMount} tabIndex={-1} className="outline-none" variant="destructive">
              You’re signed in, but we couldn’t sign out your other devices. Check your connection
              and try again.
            </Alert>
            <Button onClick={() => others.mutate()}>Try again</Button>
          </>
        ) : (
          <p
            ref={focusOnMount}
            tabIndex={-1}
            role="status"
            className="text-center text-muted-foreground outline-none"
          >
            Signing out your other devices…
          </p>
        )}
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Log in">
      {reset && <Alert>Password changed. Sign in to finish.</Alert>}
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="sr-only">How to log in</legend>
        <Button
          aria-pressed={mode === 'password'}
          variant={mode === 'password' ? 'default' : 'outline'}
          onClick={() => setMode('password')}
        >
          Password
        </Button>
        <Button
          aria-pressed={mode === 'code'}
          variant={mode === 'code' ? 'default' : 'outline'}
          onClick={() => setMode('code')}
        >
          Email code
        </Button>
      </fieldset>
      {mode === 'password' ? (
        <PasswordForm onSignedIn={onSignedIn} />
      ) : (
        <EmailCodeForm onSignedIn={onSignedIn} />
      )}
      <p className="text-center text-sm text-muted-foreground">
        New here?{' '}
        <Link
          to="/signup"
          state={{ from }}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Create an account
        </Link>
      </p>
    </AuthCard>
  )
}

function PasswordForm({ onSignedIn }: { onSignedIn: () => void }) {
  const login = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      account.createEmailPasswordSession(input),
    onSuccess: onSignedIn,
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (login.isPending) return
    const form = new FormData(event.currentTarget)
    login.mutate({ email: String(form.get('email')), password: String(form.get('password')) })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {login.isError && <Alert variant="destructive">{authErrorMessage(login.error)}</Alert>}
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
          autoComplete="current-password"
          required
        />
        <Link to="/recover" className="self-end text-sm underline underline-offset-4">
          Forgot your password?
        </Link>
      </div>
      <Button type="submit" aria-disabled={login.isPending}>
        {login.isPending ? 'Logging in…' : 'Log in'}
      </Button>
    </form>
  )
}

function EmailCodeForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  // Back from the code step, whose form had focus: focus goes to the email (#539).
  const [back, setBack] = useState(false)
  const sendCode = useMutation({
    mutationFn: (address: string) =>
      account.createEmailToken({ userId: ID.unique(), email: address }),
  })
  const verifyCode = useMutation({
    mutationFn: (input: { userId: string; secret: string }) => account.createSession(input),
    onSuccess: onSignedIn,
  })
  const userId = sendCode.data?.userId

  if (!userId) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (sendCode.isPending) return
          sendCode.mutate(email)
        }}
        className="flex flex-col gap-4"
      >
        {sendCode.isError && (
          <Alert variant="destructive">{authErrorMessage(sendCode.error)}</Alert>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="code-email">Email</Label>
          <Input
            ref={back ? focusOnMount : undefined}
            id="code-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" aria-disabled={sendCode.isPending}>
          {sendCode.isPending ? 'Sending…' : 'Email me a code'}
        </Button>
      </form>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (verifyCode.isPending) return
        const secret = String(new FormData(event.currentTarget).get('code')).trim()
        verifyCode.mutate({ userId, secret })
      }}
      className="flex flex-col gap-4"
    >
      <Alert id="code-sent">We sent a 6-digit code to {email}.</Alert>
      {verifyCode.isError && (
        <Alert variant="destructive">{authErrorMessage(verifyCode.error)}</Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="code">Code</Label>
        {/* The form it replaced is gone: focus goes to the code, which reads out where it went (#539). */}
        <Input
          ref={focusOnMount}
          id="code"
          name="code"
          aria-describedby="code-sent"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
      </div>
      <Button type="submit" aria-disabled={verifyCode.isPending}>
        {verifyCode.isPending ? 'Checking…' : 'Log in'}
      </Button>
      <Button
        variant="link"
        onClick={() => {
          setBack(true)
          sendCode.reset()
        }}
      >
        Use a different email
      </Button>
    </form>
  )
}
