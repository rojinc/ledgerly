import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { callFunction, type ErrorCode } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { Button, buttonVariants } from '../../ui/button'
import { AuthCard, focusOnMount } from '../auth/auth-card'
import { authErrorMessage } from '../auth/auth-error'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { verificationUrl } from '../auth/verify-email-page'

/** `identity POST /invites/accept`'s answer (functions-api.md#identity). */
type AcceptResult = { groupId: string } | { needsVerification: 'email' | 'phone' }

// The token waits here, in this tab only, while the visitor logs in or signs up. It's never put
// back in an address, and it's dropped once the invite is used up or turns out to be invalid.
const TOKEN_KEY = 'ledgerly.inviteToken'

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function storeToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Without storage the token lives only in this page's state: it still works if they're
    // already signed in.
  }
}

/** Drops `token`, unless a newer link in this tab has stored its own since. */
function dropToken(token: string) {
  try {
    if (sessionStorage.getItem(TOKEN_KEY) === token) sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing stored.
  }
}

/** The token from `/invite#<token>`, taken from the address and kept for this tab. */
function takeToken(hash: string): string | null {
  const token = hash.replace(/^#/, '')
  if (token === '') return readToken()
  storeToken(token)
  return token
}

class AcceptError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The link can't work: INVITE_INVALID, or VALIDATION_FAILED for a token over 128 characters
 * (the body holds nothing else), so sending it again can't help.
 */
function isInvalid(error: Error): boolean {
  return (
    error instanceof AcceptError &&
    (error.code === 'INVITE_INVALID' || error.code === 'VALIDATION_FAILED')
  )
}

function isSignedOut(error: Error): boolean {
  return (
    error instanceof AcceptError && (error.code === 'UNAUTHENTICATED' || error.code === 'NOT_FOUND')
  )
}

/** What accepting says while it runs, and for each `needsVerification` answer. */
const STEPS = {
  joining: 'Joining the group…',
  email: 'To join, first verify your email: open the link we sent you, then come back here.',
  phone:
    'This invite was sent to a phone number. Joining by phone isn’t ready yet; ask whoever added you to invite your email instead.',
}

/** The way out of a dead end, as on verify-email. */
function GoToLedgerly() {
  return (
    <Link to="/" className="text-center text-sm font-medium underline underline-offset-4">
      Go to Ledgerly
    </Link>
  )
}

/** `/invite#<token>`: log in or sign up, verify if asked, and join the group (#174). */
export function InvitePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [token, setToken] = useState(() => takeToken(location.hash))
  // Off the address bar before anything else can see or log it. A second link opened in this
  // tab only changes the hash, so this takes its token too.
  useLayoutEffect(() => {
    if (location.hash === '') return
    setToken(takeToken(location.hash))
    navigate({ hash: '' }, { replace: true })
  }, [location.hash, navigate])
  const user = useCurrentUser()

  let content: ReactNode
  if (!token) {
    content = (
      <>
        <Alert variant="destructive">
          This invite link is incomplete. Open the link from the email again.
        </Alert>
        <GoToLedgerly />
      </>
    )
  } else if (user.isPending) {
    content = (
      <p role="status" className="text-center text-muted-foreground">
        Loading…
      </p>
    )
  } else if (user.isError && !user.data) {
    content = (
      <Alert variant="destructive">
        We couldn’t reach Ledgerly. Check your connection and reload the page.
      </Alert>
    )
  } else if (!user.data) {
    content = <SignedOut />
  } else {
    // A new token is a new accept, sent once like the first.
    content = <Accept key={token} token={token} userId={user.data.$id} />
  }
  return <AuthCard title="Join a group">{content}</AuthCard>
}

function SignedOut() {
  // Both come back here once signed in; the token waits in this tab.
  const back = { from: '/invite' }
  return (
    <>
      <p className="text-center">
        Someone added you to a group on Ledgerly. Log in or create an account to join it.
      </p>
      <div className="flex flex-col gap-2">
        <Link to="/signup" state={back} className={buttonVariants()}>
          Create an account
        </Link>
        <Link to="/login" state={back} className={buttonVariants({ variant: 'outline' })}>
          Log in
        </Link>
      </div>
    </>
  )
}

function Accept({ token, userId }: { token: string; userId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // The person and profile first: accepting claims records for them.
  const bootstrap = useBootstrap(userId)
  const accept = useMutation({
    mutationFn: async () => {
      const result = await callFunction<AcceptResult>('identity', 'POST', '/invites/accept', {
        token,
      })
      if (!result.ok) throw new AcceptError(result.error.code, result.error.message)
      return result.data
    },
    onSuccess: async (data) => {
      if (!('groupId' in data)) return
      dropToken(token)
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups(userId) })
      navigate('/groups', { replace: true })
    },
    onError: (error) => {
      // An earlier link's answer can land after a newer one was opened: only its own token goes.
      if (isInvalid(error)) dropToken(token)
      // The session ended, or NOT_FOUND: the account was deleted after bootstrap, which bootstrap
      // itself answers with UNAUTHENTICATED. Either way, log in or sign up; the token waits.
      if (isSignedOut(error)) queryClient.setQueryData(queryKeys.currentUser, null)
    },
  })

  // Once, also under StrictMode's double effect: a used invite can't be accepted twice.
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !bootstrap.data) return
    sent.current = true
    accept.mutate()
  }, [bootstrap.data, accept])

  // Each message below is focused as it appears: it replaces the one before, or the button that
  // was clicked, so focus isn't lost.
  if (bootstrap.isError && !bootstrap.data) {
    return (
      <>
        <Alert ref={focusOnMount} tabIndex={-1} className="outline-none" variant="destructive">
          We couldn’t set up your account. Try again in a moment.
        </Alert>
        {/* aria-disabled, not disabled, so it keeps the focus while it tries. */}
        <Button
          aria-disabled={bootstrap.isFetching}
          onClick={() => {
            if (!bootstrap.isFetching) void bootstrap.refetch()
          }}
        >
          Try again
        </Button>
      </>
    )
  }
  if (accept.isError) {
    return isInvalid(accept.error) ? (
      <>
        <Alert ref={focusOnMount} tabIndex={-1} className="outline-none" variant="destructive">
          This invite has expired or was already used.
        </Alert>
        <GoToLedgerly />
      </>
    ) : (
      <>
        <Alert ref={focusOnMount} tabIndex={-1} className="outline-none" variant="destructive">
          {accept.error.message}
        </Alert>
        <Button onClick={() => accept.mutate()}>Try again</Button>
      </>
    )
  }
  const step =
    accept.data && 'needsVerification' in accept.data ? accept.data.needsVerification : 'joining'
  return (
    <>
      {/* There from "Joining the group…" on, so the answer that replaces it is read out. */}
      <div role="status">
        {/* Keyed, so each step is a new message and takes the focus. */}
        <p
          key={step}
          ref={focusOnMount}
          tabIndex={-1}
          className={`text-center outline-none ${step === 'joining' ? 'text-muted-foreground' : ''}`}
        >
          {STEPS[step]}
        </p>
      </div>
      {step === 'email' && <VerifyEmail onVerified={() => accept.mutate()} />}
      {step === 'phone' && <GoToLedgerly />}
    </>
  )
}

function VerifyEmail({ onVerified }: { onVerified: () => void }) {
  const send = useMutation({
    mutationFn: () => account.createEmailVerification({ url: verificationUrl() }),
  })
  return (
    <>
      <p role="status" className="text-center text-sm text-muted-foreground empty:hidden">
        {send.isSuccess
          ? 'We sent you a new link.'
          : send.isError
            ? authErrorMessage(send.error)
            : ''}
      </p>
      <div className="flex flex-col gap-2">
        {/* Accepting again replaces the prompt with "Joining the group…", which takes the focus. */}
        <Button onClick={onVerified}>I’ve verified it, join now</Button>
        <Button
          variant="outline"
          aria-disabled={send.isPending}
          onClick={() => {
            if (!send.isPending) send.mutate()
          }}
        >
          Send the link again
        </Button>
      </div>
    </>
  )
}
