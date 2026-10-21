import { emailSchema } from '@ledgerly/core/schemas/common'
import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { authErrorMessage, errorType } from '../auth/auth-error'
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/password-rules'
import { useCurrentUser } from '../auth/use-current-user'
import { verificationUrl } from '../auth/verify-email-page'

const WRONG_PASSWORD = 'Your password isn’t right.'
// Sign-up says the same about an address with an account, so this tells nobody anything new.
// Appwrite checks the password first.
const TAKEN = 'Another account already uses this email.'
// Appwrite 1.8 refuses an address another account holds as `user_target_already_exists` (each
// account's email is a messaging target), or as `general_bad_request` from its duplicate and
// sign-in-provider checks; older versions as `user_email_already_exists`. The address's form is
// checked here first, so a bad request is one of those.
const TAKEN_TYPES = [
  'user_target_already_exists',
  'general_bad_request',
  'user_email_already_exists',
]

type User = Awaited<ReturnType<typeof account.updateEmail>>

/** Appwrite's refusal of an email change, in words. */
function refusal(error: unknown): string {
  const type = errorType(error)
  if (type === 'user_invalid_credentials') return WRONG_PASSWORD
  if (type !== undefined && TAKEN_TYPES.includes(type)) return TAKEN
  return authErrorMessage(error)
}

/**
 * `account.updateEmail`: the account with its new email, or the refusal in words. A try whose
 * answer was lost may have made the change, and a retry is then refused as taken, by this
 * account's own address: so after any refusal but the password's, the account is read again,
 * and one that already has the new email counts as changed.
 */
async function changeEmail(email: string, password: string): Promise<User | string> {
  try {
    return await account.updateEmail({ email, password })
  } catch (error) {
    const message = refusal(error)
    if (message === WRONG_PASSWORD) return message
    try {
      const now = await account.get()
      if (now.email.toLowerCase() === email.toLowerCase()) return now
    } catch {
      // The refusal stands.
    }
    return message
  }
}

/**
 * Change the email you sign in with (#403 item 5), with your current password, so a stolen
 * session alone can't. The new address then needs verifying, and the old verified ones are told
 * by the `identity` function's change notice, which the client can't skip
 * (identity-and-invites.md#email-and-phone-change-notice). An account with no password (made
 * with an email code) sets one first. As in PasswordSection, the password is never in React
 * state or the DOM's attributes: the fields are uncontrolled, read with FormData on submit and
 * cleared with `reset()`. It's never logged and goes nowhere but `account.updateEmail`.
 */
export function EmailSection() {
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
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

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
    const email = String(fields.get('new-email') ?? '').trim()
    const password = String(fields.get('current-password') ?? '')
    const found = {
      email:
        email === ''
          ? 'Enter your new email address.'
          : !emailSchema.safeParse(email).success
            ? 'Enter an email address like name@example.com'
            : email.toLowerCase() === user?.email.toLowerCase()
              ? 'That’s already your email.'
              : undefined,
      password:
        password === ''
          ? 'Enter your password.'
          : // No password is shorter than sign-up allows: this one can't be right.
            password.length < PASSWORD_MIN
            ? WRONG_PASSWORD
            : undefined,
    }
    // Shown before focus moves, so a field's error is read out with it.
    flushSync(() => {
      setErrors(found)
      setRefused('')
    })
    if (found.email || found.password) {
      document.getElementById(found.email ? 'new-email' : 'current-password')?.focus()
      return
    }
    sending.current = true
    setBusy(true)
    const updated = await changeEmail(email, password)
    if (typeof updated === 'string') {
      flushSync(() => {
        if (updated === WRONG_PASSWORD) setErrors({ password: updated })
        else setRefused(updated)
        setBusy(false)
      })
      // An error by a field isn't read out on its own: focus takes the reader there. Any other
      // refusal is an alert.
      if (updated === WRONG_PASSWORD) document.getElementById('current-password')?.focus()
      sending.current = false
      return
    }
    form.current?.reset()
    // The answer is the user with the new email, not verified yet: the banner at the top asks
    // for it at once. The link goes to the new address; a failed send is offered again there.
    let sent = true
    try {
      await account.createEmailVerification({ url: verificationUrl() })
    } catch {
      sent = false
    }
    sending.current = false
    flushSync(() => {
      queryClient.setQueryData(queryKeys.currentUser, updated)
      setBusy(false)
      setOpen(false)
      setDone(
        sent
          ? `Your email is now ${updated.email}. We sent a link there to verify it.`
          : `Your email is now ${updated.email}. We couldn’t send the link to verify it: use Send it again at the top of the page.`,
      )
    })
    heading.current?.focus()
    void queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
  }

  return (
    <section id="email" aria-labelledby="email-heading" className="flex flex-col gap-4">
      <h2
        id="email-heading"
        ref={heading}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        Email
      </h2>
      {/* Mounted from the start, so the message is read out. */}
      <p role="status" className="text-sm empty:sr-only">
        {done}
      </p>
      <p className="text-sm break-words text-muted-foreground">You sign in with {user?.email}.</p>
      {!hasPassword ? (
        <p className="text-sm text-muted-foreground">
          To change it, set a password first (below): the change needs it.
        </p>
      ) : open ? (
        <form
          ref={form}
          method="post"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          {refused && <Alert variant="destructive">{refused}</Alert>}
          <TextField
            id="new-email"
            name="new-email"
            type="email"
            autoComplete="email"
            label="New email"
            hint="We send a link there to verify it, and tell your old address if it was verified. Until it’s verified, you can’t send invites or reminders."
            error={errors.email ? { type: 'validate', message: errors.email } : undefined}
          />
          <TextField
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            label="Your password"
            maxLength={PASSWORD_MAX}
            error={errors.password ? { type: 'validate', message: errors.password } : undefined}
          />
          <div className="flex flex-wrap gap-3">
            {/* aria-disabled, not disabled: a disabled button loses focus. */}
            <Button type="submit" aria-disabled={busy}>
              {busy ? 'Saving…' : 'Change email'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-disabled={busy}
              onClick={() => !busy && close()}
            >
              Cancel
            </Button>
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
            document.getElementById('new-email')?.focus()
          }}
        >
          Change email
        </Button>
      )}
    </section>
  )
}
