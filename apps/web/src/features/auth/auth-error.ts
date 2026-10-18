import { AppwriteException } from 'appwrite'

const MESSAGES: Record<string, string> = {
  user_invalid_credentials: 'That email and password don’t match.',
  user_already_exists: 'An account with this email already exists. Try logging in.',
  user_invalid_token: 'That code is wrong or has expired. Request a new one.',
  general_rate_limit_exceeded: 'Too many attempts. Wait a minute and try again.',
}

export function authErrorMessage(error: unknown): string {
  const known = error instanceof AppwriteException ? MESSAGES[error.type] : undefined
  return known ?? 'Something went wrong. Check your connection and try again.'
}
