import { useQueryClient } from '@tanstack/react-query'
import { AppwriteException } from 'appwrite'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { account } from '../../lib/appwrite'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { AuthCard, focusOnMount } from './auth-card'
import { errorType } from './auth-error'
import { PASSWORD_MAX, PASSWORD_MIN, PASSWORD_TOO_SHORT, passwordRefusal } from './password-rules'
import { forgetUser } from './use-log-out'

// A user that's gone (deleted since the email) makes the link as dead as a used one.
const DEAD_LINK = new Set(['user_invalid_token', 'user_not_found'])

/**
 * Sets a new password from the emailed link (#290). The link's `userId` and `secret` are read
 * once, into a ref, and then taken out of the address bar and the Back/Forward history. The
 * secret goes nowhere but `account.updateRecovery`, and is dropped once the link is used up. The
 * passwords are kept as on Profile (password-section.tsx): uncontrolled fields read with FormData
 * on submit, never in React state. Once the password is set the form is gone for good.
 */
export function RecoverCompletePage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const userId = params.get('userId')
  const secret = params.get('secret')
  const link = useRef(userId && secret ? { userId, secret } : null)
  // A second submit before the first answers sends nothing (state updates aren't instant).
  const sending = useRef(false)
  const [errors, setErrors] = useState<{ password?: string; repeat?: string }>({})
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<'form' | 'expired' | 'signing-out' | 'sign-out-failed'>('form')

  // history.replaceState, through the router so it stops holding them too.
  useEffect(() => {
    navigate('/recover/complete', { replace: true })
  }, [navigate])

  // A browser still signed in would be sent past /login by RedirectIfSignedIn, and miss the
  // sign-in there that signs out every other session. So it's signed out first.
  const signOutHere = async () => {
    setStep('signing-out')
    try {
      await account.deleteSession({ sessionId: 'current' })
    } catch (error) {
      // 401: nobody was signed in here.
      if (!(error instanceof AppwriteException && error.code === 401)) {
        setStep('sign-out-failed')
        return
      }
    }
    forgetUser(queryClient)
    navigate('/login?reset=1', { replace: true })
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    // First, always: the form never submits itself, so nothing reaches a URL.
    event.preventDefault()
    if (sending.current || !link.current) return
    const fields = new FormData(event.currentTarget)
    const password = String(fields.get('new-password') ?? '')
    const repeat = String(fields.get('repeat-password') ?? '')
    const tooShort = password.length < PASSWORD_MIN
    const found = {
      password: tooShort ? PASSWORD_TOO_SHORT : undefined,
      repeat: !tooShort && repeat !== password ? 'The passwords don’t match.' : undefined,
    }
    setErrors(found)
    setRefused('')
    if (found.password || found.repeat) return
    sending.current = true
    setBusy(true)
    try {
      await account.updateRecovery({ ...link.current, password })
    } catch (error) {
      if (DEAD_LINK.has(errorType(error) ?? '')) {
        link.current = null
        setStep('expired')
      } else {
        setRefused(passwordRefusal(error))
      }
      sending.current = false
      setBusy(false)
      return
    }
    link.current = null
    // The link is used up: the form never comes back, whatever happens next.
    await signOutHere()
  }

  return (
    <AuthCard title="Set a new password">
      {step === 'signing-out' ? (
        <p
          ref={focusOnMount}
          tabIndex={-1}
          role="status"
          className="text-center text-muted-foreground outline-none"
        >
          Password changed. Signing this browser out…
        </p>
      ) : step === 'sign-out-failed' ? (
        <>
          <Alert ref={focusOnMount} tabIndex={-1} className="outline-none" variant="destructive">
            Your password is changed, but we couldn’t sign this browser out. Check your connection
            and try again.
          </Alert>
          <Button onClick={() => void signOutHere()}>Try again</Button>
        </>
      ) : step === 'expired' ? (
        <>
          <Alert ref={focusOnMount} tabIndex={-1} className="outline-none" variant="destructive">
            This link has expired or was already used.
          </Alert>
          {/* In case the reset went through after all (a lost reply, then a second send). */}
          <Link to="/login?reset=1" className="text-center text-sm underline underline-offset-4">
            If you just set a new password with this link, sign in with it.
          </Link>
          <Link
            to="/recover"
            className="text-center text-sm font-medium underline underline-offset-4"
          >
            Get a new link
          </Link>
        </>
      ) : !link.current ? (
        <>
          {/* Also what a reload shows: the parameters are gone from the URL. */}
          <Alert variant="destructive">
            This link is incomplete. Open the link from the email again, or get a new one.
          </Alert>
          <Link
            to="/recover"
            className="text-center text-sm font-medium underline underline-offset-4"
          >
            Get a new link
          </Link>
        </>
      ) : (
        <form
          method="post"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          {refused && <Alert variant="destructive">{refused}</Alert>}
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
          <TextField
            id="repeat-password"
            name="repeat-password"
            type="password"
            autoComplete="new-password"
            label="New password again"
            maxLength={PASSWORD_MAX}
            error={errors.repeat ? { type: 'validate', message: errors.repeat } : undefined}
          />
          {/* aria-disabled, not disabled: a disabled button loses focus. */}
          <Button type="submit" aria-disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </Button>
        </form>
      )}
    </AuthCard>
  )
}
