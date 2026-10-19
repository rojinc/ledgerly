import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { callFunction, type ErrorCode } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { Button } from '../../ui/button'
import { AuthCard } from '../auth/auth-card'
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

function dropToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
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

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : 'status'}
      className={`text-center ${alert ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {children}
    </p>
  )
}

/** `/invite#<token>`: log in or sign up, verify if asked, and join the group (#174). */
export function InvitePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [token] = useState(() => takeToken(location.hash))
  // Off the address bar before anything else can see or log it.
  useLayoutEffect(() => {
    if (location.hash !== '') navigate({ hash: '' }, { replace: true })
  }, [location.hash, navigate])
  const user = useCurrentUser()

  let content: ReactNode
  if (!token) {
    content = (
      <Message alert>This invite link is incomplete. Open the link from the email again.</Message>
    )
  } else if (user.isPending) {
    content = <Message>Loading…</Message>
  } else if (user.isError && !user.data) {
    content = (
      <Message alert>
        We couldn’t reach Ledgerly. Check your connection and reload the page.
      </Message>
    )
  } else if (!user.data) {
    content = <SignedOut />
  } else {
    content = <Accept token={token} userId={user.data.$id} />
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
        <Link
          to="/signup"
          state={back}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Create an account
        </Link>
        <Link
          to="/login"
          state={back}
          className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
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
      dropToken()
      await queryClient.invalidateQueries({ queryKey: ['groups'] })
      navigate('/groups', { replace: true })
    },
    onError: (error) => {
      if (error instanceof AcceptError && error.code === 'INVITE_INVALID') dropToken()
    },
  })

  // Once, also under StrictMode's double effect: a used invite can't be accepted twice.
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !bootstrap.data) return
    sent.current = true
    accept.mutate()
  }, [bootstrap.data, accept])

  if (bootstrap.isError && !bootstrap.data) {
    return <Message alert>We couldn’t set up your account. Reload the page to try again.</Message>
  }
  if (accept.isError) {
    const invalid = accept.error instanceof AcceptError && accept.error.code === 'INVITE_INVALID'
    return invalid ? (
      <Message alert>This invite has expired or was already used.</Message>
    ) : (
      <>
        <Message alert>{accept.error.message}</Message>
        <Button onClick={() => accept.mutate()}>Try again</Button>
      </>
    )
  }
  if (accept.data && 'needsVerification' in accept.data) {
    return accept.data.needsVerification === 'email' ? (
      <VerifyEmail onVerified={() => accept.mutate()} />
    ) : (
      <Message>
        This invite was sent to a phone number. Joining by phone isn’t ready yet; ask whoever added
        you to invite your email instead.
      </Message>
    )
  }
  return <Message>Joining the group…</Message>
}

function VerifyEmail({ onVerified }: { onVerified: () => void }) {
  const send = useMutation({
    mutationFn: () => account.createEmailVerification({ url: verificationUrl() }),
  })
  return (
    <>
      <p className="text-center">
        To join, first verify your email: open the link we sent you, then come back here.
      </p>
      <p role="status" className="text-center text-sm text-muted-foreground empty:hidden">
        {send.isSuccess
          ? 'We sent you a new link.'
          : send.isError
            ? authErrorMessage(send.error)
            : ''}
      </p>
      <div className="flex flex-col gap-2">
        {/* Accepting again replaces this with "Joining the group…". */}
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
