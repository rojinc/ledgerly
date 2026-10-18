import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { Alert } from '../../ui/alert'
import { AuthCard } from './auth-card'
import { authErrorMessage } from './auth-error'

/** Where Appwrite's verification email links back to. */
export function verificationUrl() {
  return `${window.location.origin}/verify-email`
}

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const userId = params.get('userId')
  const secret = params.get('secret')
  const queryClient = useQueryClient()
  const verify = useMutation({
    mutationFn: (input: { userId: string; secret: string }) =>
      account.updateEmailVerification(input),
    onSuccess: async (_, { userId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
      // A verified email can link records others made for it (claim), so bootstrap again.
      await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap(userId) })
    },
  })

  // The secret is single use, so make sure StrictMode's double effect only sends it once.
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !userId || !secret) return
    sent.current = true
    verify.mutate({ userId, secret })
  }, [userId, secret, verify])

  return (
    <AuthCard title="Verify your email">
      {!userId || !secret ? (
        <Alert variant="destructive">
          This link is incomplete. Open the link from the email again.
        </Alert>
      ) : verify.isError ? (
        <Alert variant="destructive">{authErrorMessage(verify.error)}</Alert>
      ) : verify.isSuccess ? (
        <Alert>Your email is verified.</Alert>
      ) : (
        <p role="status" className="text-center text-muted-foreground">
          Checking your link…
        </p>
      )}
      <Link to="/" className="text-center text-sm font-medium underline underline-offset-4">
        Go to Ledgerly
      </Link>
    </AuthCard>
  )
}
