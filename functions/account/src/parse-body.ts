import { AppError } from '@ledgerly/server/http/app-error'

// The part of a zod schema this uses.
type Schema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } }
}

/** functions-api.md#validation: the body parsed with the route's schema, or VALIDATION_FAILED. */
export function parseBody<T>(schema: Schema<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'The request is not valid.', result.error.issues)
  }
  return result.data
}
