import { AppwriteException } from 'appwrite'

const MESSAGES: Record<string, string> = {
  user_invalid_credentials: 'That email and password don’t match.',
  user_already_exists: 'An account with this email already exists. Try logging in.',
  user_invalid_token: 'That code is wrong or has expired. Request a new one.',
  general_rate_limit_exceeded: 'Too many attempts. Wait a minute and try again.',
}

/** Appwrite's error type (its response code), if it is one of Appwrite's errors. */
export function errorType(error: unknown): string | undefined {
  return error instanceof AppwriteException ? error.type : undefined
}

export function authErrorMessage(error: unknown): string {
  const known = error instanceof AppwriteException ? MESSAGES[error.type] : undefined
  return known ?? 'Something went wrong. Check your connection and try again.'
}
