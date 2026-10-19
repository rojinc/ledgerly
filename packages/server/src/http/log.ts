import { idSchema } from '@ledgerly/core/schemas/common'
import type { SnapshotProblem } from '@ledgerly/core/statements/snapshot'
import { AppwriteException } from 'node-appwrite'
import { EmailError } from '../email/send-email'
import { AppError } from './app-error'

/** Everything a route may log (conventions.md#functions). Add an event here to log a new one. */
export type LogEvent =
  | 'draft_failed'
  | 'ready_email_failed'
  | 'auto_finalize_failed'
  | 'snapshot_check_failed'
  | 'claim_identity_unusable'
  | 'claim_needs_merge'
  | 'reminder_failed'

export type LogFields = {
  groupId?: string
  statementId?: string
  transactionId?: string
  problems?: readonly SnapshotProblem[]
  identityType?: 'email' | 'phone'
  /** The error behind it. Only its name is written (`describe`). */
  error?: unknown
}

/**
 * Writes one JSON line for something that went wrong inside a route: `{ fn, event, groupId?,
 * statementId?, transactionId?, problems?, identityType?, cause? }`. Only IDs, fixed names and
 * error names, never text that could quote what someone typed (security-and-privacy.md). A value
 * passed as an ID that isn't one is written as `invalid`.
 */
export function logProblem(event: LogEvent, fields: LogFields = {}): void {
  const { groupId, statementId, transactionId, problems, identityType } = fields
  const line = {
    fn: process.env.APPWRITE_FUNCTION_ID ?? 'unknown',
    event,
    groupId: id(groupId),
    statementId: id(statementId),
    transactionId: id(transactionId),
    problems,
    identityType,
    cause: 'error' in fields ? describe(fields.error) : undefined,
  }
  // biome-ignore lint/suspicious/noConsole: the one place a function logs from inside a route.
  console.error(JSON.stringify(line))
}

/**
 * Names an error for a log line, never its message: messages can quote input or stored text
 * (JSON.parse puts the text it failed on in its message).
 */
export function describe(error: unknown): string {
  if (error instanceof AppError) return `AppError ${error.code}`
  if (error instanceof AppwriteException) return `AppwriteException ${error.code} ${error.type}`
  if (error instanceof EmailError) return `EmailError ${error.type} ${error.status ?? ''}`.trim()
  return error instanceof Error ? error.name : typeof error
}

const id = (value: string | undefined) =>
  value === undefined || idSchema.safeParse(value).success ? value : 'invalid'
