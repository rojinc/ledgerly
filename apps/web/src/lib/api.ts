import { AppwriteException, ExecutionMethod, type Models } from 'appwrite'
import { functions } from './appwrite'

// Mirrors docs/architecture/functions-api.md#response-envelope.
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'VALIDATION_FAILED'
  | 'NOT_A_MEMBER'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LOCKED'
  | 'ARCHIVED'
  | 'INVITE_INVALID'
  | 'RATE_LIMITED'
  | 'INVARIANT_VIOLATION'
  | 'INTERNAL'

export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
export type Result<T> = Ok<T> | Err

export type FunctionId = 'ledger' | 'groups' | 'identity' | 'statements'
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

const ERROR_CODES = new Set<string>([
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

function err(code: ErrorCode, message: string): Err {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Turns a synchronous execution into the function's envelope, or an `INTERNAL` error. */
export function parseEnvelope<T>(execution: Pick<Models.Execution, 'responseBody'>): Result<T> {
  let body: unknown
  try {
    body = JSON.parse(execution.responseBody)
  } catch {
    return err('INTERNAL', 'The server sent a response we could not read.')
  }
  if (isRecord(body) && body.ok === true && 'data' in body) {
    return { ok: true, data: body.data as T }
  }
  if (isRecord(body) && body.ok === false && isRecord(body.error)) {
    const { code, message, details } = body.error
    if (typeof code === 'string' && ERROR_CODES.has(code) && typeof message === 'string') {
      return {
        ok: false,
        error: { code: code as ErrorCode, message, ...(details === undefined ? {} : { details }) },
      }
    }
  }
  return err('INTERNAL', 'The server sent a response we could not read.')
}

/** Calls a function route synchronously. Never throws: failures come back as `Err`. */
export async function callFunction<T>(
  functionId: FunctionId,
  method: Method,
  path: string,
  payload?: unknown,
): Promise<Result<T>> {
  try {
    const execution = await functions.createExecution({
      functionId,
      body: payload === undefined ? '' : JSON.stringify(payload),
      async: false,
      xpath: path,
      method: ExecutionMethod[method],
    })
    return parseEnvelope<T>(execution)
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 401) {
      return err('UNAUTHENTICATED', 'Please log in again.')
    }
    return err('INTERNAL', 'Could not reach the server. Check your connection and try again.')
  }
}
