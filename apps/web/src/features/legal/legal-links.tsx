import { Link } from 'react-router'

const LINK = 'font-medium text-foreground underline underline-offset-4'

/** What signing up agrees to, where an account can be made (#566, the lead's D2 call). */
export function AgreeNotice() {
  return (
    <p className="text-sm text-muted-foreground">
      By creating an account, you agree to the{' '}
      <Link to="/terms" className={LINK}>
        Terms of use
      </Link>{' '}
      and the{' '}
      <Link to="/privacy" className={LINK}>
        Privacy policy
      </Link>
      .
    </p>
  )
}

/** The two pages' links, where no account is made (#566). */
export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <p className={`text-sm text-muted-foreground ${className}`}>
      <Link to="/terms" className={LINK}>
        Terms of use
      </Link>{' '}
      ·{' '}
      <Link to="/privacy" className={LINK}>
        Privacy policy
      </Link>
    </p>
  )
}
