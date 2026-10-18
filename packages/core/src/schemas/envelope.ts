import { z } from 'zod'

// functions-api.md#response-envelope. The HTTP status for each code lives with
// AppError in packages/server.

export const errorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'VALIDATION_FAILED',
  'NOT_A_MEMBER',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'LOCKED',
  'ARCHIVED',
  'INVITE_INVALID',
  'RATE_LIMITED',
  'INVARIANT_VIOLATION',
  'INTERNAL',
])

export type ErrorCode = z.infer<typeof errorCodeSchema>

export const errSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
})

export type Err = z.infer<typeof errSchema>

export function okSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ ok: z.literal(true), data })
}

export type Ok<T> = z.infer<ReturnType<typeof okSchema<z.ZodType<T>>>>

/** What every route returns: `{ ok: true, data }` or `{ ok: false, error }`. */
export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [okSchema(data), errSchema])
}
