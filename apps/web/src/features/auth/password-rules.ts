import { authErrorMessage, errorType } from './auth-error'

/** Appwrite's limits for a password; the minimum matches sign-up. */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 256
export const PASSWORD_TOO_SHORT = `Use at least ${PASSWORD_MIN} characters.`

// Appwrite's refusals of a new password, by error type (its response codes). The others go to
// authErrorMessage.
const REFUSED: Record<string, string> = {
  user_invalid_credentials: 'Your current password isn’t right.',
  password_recently_used: 'Pick a password you haven’t used recently.',
  password_personal_data: 'Pick a password that doesn’t include your name, email or phone.',
  password_pwned: 'This password has appeared in a data breach. Pick another one.',
  general_pwned_passwords_unavailable:
    'We couldn’t check that password just now. Try again in a minute.',
  // Appwrite's abuse limit: 10 an hour.
  general_rate_limit_exceeded: 'Too many tries. Try again in an hour.',
}

/** What to say when Appwrite refuses a new password. */
export function passwordRefusal(error: unknown): string {
  // Not `type && …`: a type can be '' (a reply that isn't JSON), and '' would show no message.
  return REFUSED[errorType(error) ?? ''] ?? authErrorMessage(error)
}
