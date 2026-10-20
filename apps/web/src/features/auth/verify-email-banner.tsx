import { useMutation } from '@tanstack/react-query'
import { account } from '../../lib/appwrite'
import { Button } from '../../ui/button'
import { authErrorMessage } from './auth-error'
import { useCurrentUser } from './use-current-user'
import { verificationUrl } from './verify-email-page'

export function VerifyEmailBanner() {
  const { data: user } = useCurrentUser()
  if (!user || user.emailVerification) return null
  // Keyed by the address: after an email change (#403), what was sent to the old one, and the
  // button that went with it, don't carry over to the new one.
  return <Banner key={user.email} email={user.email} />
}

function Banner({ email }: { email: string }) {
  const resend = useMutation({
    mutationFn: () => account.createEmailVerification({ url: verificationUrl() }),
  })

  return (
    <div role="status" className="border-b border-border bg-muted px-4 py-3 text-sm">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {resend.isSuccess
            ? `We sent a new link to ${email}.`
            : resend.isError
              ? authErrorMessage(resend.error)
              : `Check ${email} for a link to verify your email.`}
        </span>
        {!resend.isSuccess && (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
          >
            Send it again
          </Button>
        )}
      </div>
    </div>
  )
}
