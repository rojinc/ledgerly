import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { errorType } from '../auth/auth-error'
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_TOO_SHORT,
  passwordRefusal,
} from '../auth/password-rules'
import { useCurrentUser } from '../auth/use-current-user'

// Setting a first one is refused this way when another device set one meanwhile.
const SET_ELSEWHERE = 'Your account has a password now. Enter it to change it.'

/**
 * Set a password on an account made with an email code, which has none (`passwordUpdate` is
 * empty), or change one (#203). The passwords are never in React state or the DOM's attributes:
 * the fields are uncontrolled, as on log-in and sign-up, read with FormData on submit and
 * cleared with `reset()`. No `useMutation` either, whose state would keep them. They're never
 * logged and go nowhere but `account.updatePassword`.
 */
export function PasswordSection() {
  const user = useCurrentUser().data
  const queryClient = useQueryClient()
  // ProfilePage mounts this once the user is known, so `false` here never means "loading".
  const hasPassword = Boolean(user?.passwordUpdate)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const form = useRef<HTMLFormElement>(null)
  // A second submit before the first answers sends nothing (state updates aren't instant).
  const sending = useRef(false)
  const [open, setOpen] = useState(false)
  const [errors, setErrors] = useState<{ password?: string; current?: string }>({})
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const editing = !hasPassword || open
  // Set when another device set a password: the Current field it now needs takes focus.
  const toCurrent = useRef(false)
  useEffect(() => {
    if (hasPassword && toCurrent.current) {
      toCurrent.current = false
      document.getElementById('current-password')?.focus()
    }
  }, [hasPassword])

  const close = () => {
    form.current?.reset()
    flushSync(() => {
      setOpen(false)
      setErrors({})
      setRefused('')
    })
    opener.current?.focus()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    // First, always: the form never submits itself, so nothing reaches a URL.
    event.preventDefault()
    if (sending.current) return
    const fields = new FormData(event.currentTarget)
    const password = String(fields.get('new-password') ?? '')
    const current = String(fields.get('current-password') ?? '')
    const found = {
      password: password.length < PASSWORD_MIN ? PASSWORD_TOO_SHORT : undefined,
      current: !hasPassword
        ? undefined
        : current === ''
          ? 'Enter your current password.'
          : // No password is shorter than sign-up allows: this one can't be right.
            current.length < PASSWORD_MIN
            ? 'Your current password isn’t right.'
            : undefined,
    }
    setErrors(found)
    setRefused('')
    setDone('')
    if (found.password || found.current) return
    sending.current = true
    setBusy(true)
    let updated: Awaited<ReturnType<typeof account.updatePassword>>
    try {
      updated = await account.updatePassword(
        hasPassword ? { password, oldPassword: current } : { password },
      )
    } catch (error) {
      if (!hasPassword && errorType(error) === 'user_invalid_credentials') {
        // Another device set one: read the user again, so the change form appears, open, with
        // this message.
        setOpen(true)
        setRefused(SET_ELSEWHERE)
        toCurrent.current = true
        void queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
      } else {
        setRefused(passwordRefusal(error))
      }
      sending.current = false
      setBusy(false)
      return
    }
    form.current?.reset()
    sending.current = false
    flushSync(() => {
      // The answer is the user with `passwordUpdate` set: shown at once, so the set form can't
      // be sent again without the current password, even if the re-read below fails.
      queryClient.setQueryData(queryKeys.currentUser, updated)
      setBusy(false)
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
        <form
          ref={form}
          method="post"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          {refused && <Alert variant="destructive">{refused}</Alert>}
          {/* For password managers, so they file the new password under this account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={user?.email ?? ''}
            readOnly
            hidden
          />
          {hasPassword && (
            <TextField
              id="current-password"
              name="current-password"
              type="password"
              autoComplete="current-password"
              label="Current password"
              maxLength={PASSWORD_MAX}
              error={errors.current ? { type: 'validate', message: errors.current } : undefined}
            />
          )}
          <TextField
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            label="New password"
            hint={`At least ${PASSWORD_MIN} characters.`}
            maxLength={PASSWORD_MAX}
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
