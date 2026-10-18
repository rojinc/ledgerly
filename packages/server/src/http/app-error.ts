import type { ErrorCode } from '@ledgerly/core/schemas/envelope'

// functions-api.md#response-envelope: the HTTP status of every error code.
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  VALIDATION_FAILED: 400,
  NOT_A_MEMBER: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LOCKED: 409,
  ARCHIVED: 409,
  INVITE_INVALID: 400,
  RATE_LIMITED: 429,
  INVARIANT_VIOLATION: 500,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>

/** Thrown by route code; `createHandler` turns it into `{ ok: false, error }` with the code's status. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  get status(): number {
    return ERROR_STATUS[this.code]
  }
}
