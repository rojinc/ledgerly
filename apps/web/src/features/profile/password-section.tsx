import { useQueryClient } from '@tanstack/react-query'
import { AppwriteException } from 'appwrite'
import { type FormEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { authErrorMessage } from '../auth/auth-error'
import { useCurrentUser } from '../auth/use-current-user'

/** Appwrite's limits for a password; the minimum matches sign-up. */
const MIN = 8
const MAX = 256

// Appwrite's refusals of a new password, by error type. The others go to authErrorMessage.
const REFUSED: Record<string, string> = {
  user_invalid_credentials: 'Your current password isn’t right.',
  password_recently_used: 'Pick a password you haven’t used recently.',
  password_personal_data: 'Pick a password that doesn’t include your name, email or phone.',
  password_pwned: 'This password has appeared in a data breach. Pick another one.',
  general_argument_invalid: 'Pick a stronger password: at least 8 characters, not a common one.',
  general_rate_limit_exceeded: 'Too many tries. Wait a few minutes and try again.',
}

function refusal(error: unknown): string {
  const known = error instanceof AppwriteException ? REFUSED[error.type] : undefined
  return known ?? authErrorMessage(error)
}

// The field's maxLength keeps it to MAX.
function lengthError(password: string): string | undefined {
  return password.length < MIN ? `Use at least ${MIN} characters.` : undefined
}

/**
 * Set a password on an account made with an email code, which has none (`passwordUpdate` is
 * empty), or change one (#203). The passwords live only in the fields: they're cleared after a
 * save, never logged and never sent anywhere but `account.updatePassword`.
 */
export function PasswordSection() {
  const user = useCurrentUser().data
  const queryClient = useQueryClient()
  // ProfilePage mounts this once the user is known, so `false` here never means "loading".
  const hasPassword = Boolean(user?.passwordUpdate)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [current, setCurrent] = useState('')
  const [errors, setErrors] = useState<{ password?: string; current?: string }>({})
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const editing = !hasPassword || open

  const close = () => {
    flushSync(() => {
      setOpen(false)
      setPassword('')
      setCurrent('')
      setErrors({})
      setRefused('')
    })
    opener.current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found = {
      password: lengthError(password),
      current: hasPassword && current === '' ? 'Enter your current password.' : undefined,
    }
    setErrors(found)
    setRefused('')
    setDone('')
    if (found.password || found.current) return
    setBusy(true)
    let updated: Awaited<ReturnType<typeof account.updatePassword>>
    try {
      updated = await account.updatePassword(
        hasPassword ? { password, oldPassword: current } : { password },
      )
    } catch (error) {
      setRefused(refusal(error))
      setBusy(false)
      return
    }
    flushSync(() => {
      // The answer is the user with `passwordUpdate` set: shown at once, so the set form can't
      // be sent again without the current password, even if the re-read below fails.
      queryClient.setQueryData(queryKeys.currentUser, updated)
      setBusy(false)
      setPassword('')
      setCurrent('')
      setOpen(false)
      setDone(hasPassword ? 'Password changed.' : 'Password set.')
    })
    heading.current?.focus()
    // `passwordUpdate` is set now: the phone section (#176) stops asking for one.
    void queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
  }

  return (
    <section id="password" aria-labelledby="password-heading" className="flex flex-col gap-4">
      <h2
        id="password-heading"
        ref={heading}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        Password
      </h2>
      {/* Mounted from the start, so the message is read out. */}
      <p role="status" className="text-sm empty:hidden">
        {done}
      </p>
      {!hasPassword && (
        <p className="text-sm text-muted-foreground">
          Your account has no password yet. Set one to log in with it, or to add a phone.
        </p>
      )}
      {editing ? (
        <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          {refused && <Alert variant="destructive">{refused}</Alert>}
          {hasPassword && (
            <TextField
              id="current-password"
              type="password"
              autoComplete="current-password"
              label="Current password"
              maxLength={MAX}
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              error={errors.current ? { type: 'validate', message: errors.current } : undefined}
            />
          )}
          <TextField
            id="new-password"
            type="password"
            autoComplete="new-password"
            label="New password"
            hint={`At least ${MIN} characters.`}
            maxLength={MAX}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={errors.password ? { type: 'validate', message: errors.password } : undefined}
          />
          <div className="flex flex-wrap gap-3">
            {/* aria-disabled, not disabled: a disabled button loses focus. */}
            <Button type="submit" aria-disabled={busy}>
              {busy ? 'Saving…' : hasPassword ? 'Save' : 'Set password'}
            </Button>
            {hasPassword && (
              <Button
                type="button"
                variant="ghost"
                aria-disabled={busy}
                onClick={() => !busy && close()}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <Button
          ref={opener}
          variant="outline"
          className="self-start"
          onClick={() => {
            setDone('')
            flushSync(() => setOpen(true))
            document.getElementById(hasPassword ? 'current-password' : 'new-password')?.focus()
          }}
        >
          Change password
        </Button>
      )}
    </section>
  )
}
