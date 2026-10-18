import { useMutation } from '@tanstack/react-query'
import { ID } from 'appwrite'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { account } from '../../lib/appwrite'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { AuthCard } from './auth-card'
import { authErrorMessage } from './auth-error'
import { useSignedIn } from './use-signed-in'

type Mode = 'password' | 'code'

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('password')
  return (
    <AuthCard title="Log in">
      <div role="radiogroup" aria-label="How to log in" className="grid grid-cols-2 gap-2">
        <Button
          role="radio"
          aria-checked={mode === 'password'}
          variant={mode === 'password' ? 'default' : 'outline'}
          onClick={() => setMode('password')}
        >
          Password
        </Button>
        <Button
          role="radio"
          aria-checked={mode === 'code'}
          variant={mode === 'code' ? 'default' : 'outline'}
          onClick={() => setMode('code')}
        >
          Email code
        </Button>
      </div>
      {mode === 'password' ? <PasswordForm /> : <EmailCodeForm />}
      <p className="text-center text-sm text-muted-foreground">
        New here?{' '}
        <Link to="/signup" className="font-medium text-foreground underline underline-offset-4">
          Create an account
        </Link>
      </p>
    </AuthCard>
  )
}

function PasswordForm() {
  const signedIn = useSignedIn()
  const login = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      account.createEmailPasswordSession(input),
    onSuccess: signedIn,
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
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
      </div>
      <Button type="submit" disabled={login.isPending}>
        {login.isPending ? 'Logging in…' : 'Log in'}
      </Button>
    </form>
  )
}

function EmailCodeForm() {
  const signedIn = useSignedIn()
  const [email, setEmail] = useState('')
  const sendCode = useMutation({
    mutationFn: (address: string) =>
      account.createEmailToken({ userId: ID.unique(), email: address }),
  })
  const verifyCode = useMutation({
    mutationFn: (input: { userId: string; secret: string }) => account.createSession(input),
    onSuccess: signedIn,
  })
  const userId = sendCode.data?.userId

  if (!userId) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
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
            id="code-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={sendCode.isPending}>
          {sendCode.isPending ? 'Sending…' : 'Email me a code'}
        </Button>
      </form>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const secret = String(new FormData(event.currentTarget).get('code')).trim()
        verifyCode.mutate({ userId, secret })
      }}
      className="flex flex-col gap-4"
    >
      <Alert>We sent a 6-digit code to {email}.</Alert>
      {verifyCode.isError && (
        <Alert variant="destructive">{authErrorMessage(verifyCode.error)}</Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="code">Code</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
      </div>
      <Button type="submit" disabled={verifyCode.isPending}>
        {verifyCode.isPending ? 'Checking…' : 'Log in'}
      </Button>
      <Button variant="link" onClick={() => sendCode.reset()}>
        Use a different email
      </Button>
    </form>
  )
}
