import { AppwriteException } from 'appwrite'

const MESSAGES: Record<string, string> = {
  user_invalid_credentials: 'That email and password don’t match.',
  user_already_exists: 'An account with this email already exists. Try logging in.',
  user_invalid_token: 'That code is wrong or has expired. Request a new one.',
  user_password_recently_used: 'Choose a password you haven’t used before.',
  general_rate_limit_exceeded: 'Too many attempts. Wait a minute and try again.',
}

export function authErrorMessage(error: unknown): string {
  if (error instanceof AppwriteException) {
    return MESSAGES[error.type] ?? error.message
  }
  return 'Something went wrong. Check your connection and try again.'
}
