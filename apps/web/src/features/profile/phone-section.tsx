import { normalizePhone } from '@ledgerly/core/identity/normalize'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AppwriteException, type Models } from 'appwrite'
import { type FormEvent, useEffect, useState } from 'react'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button } from '../../ui/button'
import { TextField } from '../../ui/field'
import { useCurrentUser } from '../auth/use-current-user'
import { useProfile } from './use-profile'

/** How long before another code can be sent. */
export const RESEND_SECONDS = 60

const MESSAGES: Record<string, string> = {
  user_invalid_credentials: 'That password isn’t right.',
  user_phone_already_exists: 'This number is already on another account.',
  user_target_already_exists: 'This number is already on another account.',
  user_invalid_token: 'That code is wrong or has expired. Ask for a new one.',
  general_rate_limit_exceeded: 'Too many tries. Wait a few minutes and try again.',
  user_auth_method_unsupported: 'Phone numbers can’t be verified yet. Try again later.',
}

function phoneErrorMessage(error: unknown): string {
  const known = error instanceof AppwriteException ? MESSAGES[error.type] : undefined
  return known ?? 'Something went wrong. Check your connection and try again.'
}

type Step = 'view' | 'edit' | 'code'

/**
 * The account's phone: add or change it, then verify it with an SMS code (#176). A verified
 * number links the records others made with it (claim), so bootstrap runs again afterwards.
 * `onVerified` lets the invite page accept again.
 */
export function PhoneSection({ onVerified }: { onVerified?: () => void }) {
  const user = useCurrentUser().data
  if (!user) return null
  return <Phone user={user} onVerified={onVerified} />
}

function Phone({
  user,
  onVerified,
}: {
  user: Models.User<Models.Preferences>
  onVerified?: () => void
}) {
  const queryClient = useQueryClient()
  const region = useProfile(user.$id).data?.region
  const [step, setStep] = useState<Step>('view')
  const [sentAt, setSentAt] = useState<number>()
  const [done, setDone] = useState(false)

  const sendCode = useMutation({
    mutationFn: () => account.createPhoneVerification(),
    onSuccess: () => {
      setSentAt(Date.now())
      setStep('code')
    },
  })
  const verify = useMutation({
    mutationFn: (code: string) =>
      account.updatePhoneVerification({ userId: user.$id, secret: code }),
    onSuccess: async () => {
      setStep('view')
      setDone(true)
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
      // A verified phone can link records others made for it (claim), so bootstrap again.
      await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap(user.$id) })
      onVerified?.()
    },
  })

  return (
    <section aria-labelledby="phone-heading" className="flex flex-col gap-4">
      <h2 id="phone-heading" className="text-lg font-semibold">
        Phone
      </h2>
      <p>
        {user.phone ? (
          <>
            <span className="tabular-nums">{user.phone}</span> ·{' '}
            {user.phoneVerification ? 'Verified' : 'Not verified yet'}
          </>
        ) : (
          'No phone number yet.'
        )}
      </p>
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {done && user.phoneVerification ? 'Your phone number is verified.' : ''}
      </p>
      {step === 'edit' ? (
        <EditPhone
          user={user}
          region={region}
          onCancel={() => setStep('view')}
          onSaved={() => sendCode.mutate()}
        />
      ) : step === 'code' && sentAt !== undefined ? (
        <EnterCode
          sentAt={sentAt}
          verify={verify}
          resend={sendCode}
          onCancel={() => setStep('view')}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setStep('edit')}>
            {user.phone ? 'Change number' : 'Add a phone number'}
          </Button>
          {user.phone && !user.phoneVerification && (
            <Button
              aria-disabled={sendCode.isPending}
              onClick={() => {
                if (!sendCode.isPending) sendCode.mutate()
              }}
            >
              Send a code to verify it
            </Button>
          )}
        </div>
      )}
      {step !== 'code' && sendCode.isError && (
        <Alert variant="destructive">{phoneErrorMessage(sendCode.error)}</Alert>
      )}
    </section>
  )
}

function EditPhone({
  user,
  region,
  onCancel,
  onSaved,
}: {
  user: Models.User<Models.Preferences>
  region: string | undefined
  onCancel: () => void
  onSaved: () => void
}) {
  const [phoneError, setPhoneError] = useState<string>()
  const save = useMutation({
    mutationFn: (input: { phone: string; password: string }) => account.updatePhone(input),
    onSuccess: onSaved,
  })
  // Appwrite marks an account that never set a password (email-code sign-in) this way.
  if (!user.passwordUpdate) {
    return (
      <p>
        Set a password first: changing the phone on your account needs it, and yours doesn’t have
        one yet.{' '}
        <Button variant="link" className="h-auto px-0" onClick={onCancel}>
          Back
        </Button>
      </p>
    )
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (save.isPending) return
    const form = new FormData(event.currentTarget)
    let phone: string
    try {
      phone = normalizePhone(String(form.get('phone')), region)
    } catch {
      setPhoneError('Enter a mobile number, with its country code if it’s from another country.')
      return
    }
    setPhoneError(undefined)
    save.mutate({ phone, password: String(form.get('password')) })
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {save.isError && <Alert variant="destructive">{phoneErrorMessage(save.error)}</Alert>}
      <TextField
        id="phone"
        name="phone"
        type="tel"
        autoComplete="tel"
        label="Mobile number"
        error={phoneError ? { type: 'validate', message: phoneError } : undefined}
      />
      <TextField
        id="phone-password"
        name="password"
        type="password"
        autoComplete="current-password"
        label="Your Ledgerly password"
        hint="Needed to change the number on your account."
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" aria-disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save and send a code'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function EnterCode({
  sentAt,
  verify,
  resend,
  onCancel,
}: {
  sentAt: number
  verify: { mutate: (code: string) => void; isPending: boolean; isError: boolean; error: unknown }
  resend: { mutate: () => void; isPending: boolean; isError: boolean; error: unknown }
  onCancel: () => void
}) {
  const wait = useWait(sentAt)
  const [codeError, setCodeError] = useState<string>()

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (verify.isPending) return
    const code = String(new FormData(event.currentTarget).get('code')).trim()
    if (code === '') {
      setCodeError('Enter the code from the SMS.')
      return
    }
    setCodeError(undefined)
    verify.mutate(code)
  }

  const error = verify.isError ? verify.error : resend.isError ? resend.error : undefined
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {error !== undefined && <Alert variant="destructive">{phoneErrorMessage(error)}</Alert>}
      <TextField
        id="phone-code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        label="Code from the SMS"
        error={codeError ? { type: 'validate', message: codeError } : undefined}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" aria-disabled={verify.isPending}>
          {verify.isPending ? 'Checking…' : 'Verify'}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-disabled={wait > 0 || resend.isPending}
          aria-describedby="resend-wait"
          onClick={() => {
            if (wait === 0 && !resend.isPending) resend.mutate()
          }}
        >
          Send a new code
        </Button>
        <Button type="button" variant="link" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p id="resend-wait" className="text-sm text-muted-foreground">
        {wait > 0 ? `You can ask for a new code in ${wait} s.` : 'You can ask for a new code now.'}
      </p>
    </form>
  )
}

/** Whole seconds left before another code may be sent, counting down. */
function useWait(sentAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - sentAt) / 1000))
  return Math.max(0, RESEND_SECONDS - elapsed)
}
