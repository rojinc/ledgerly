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
  | 'auto_post_failed'
  | 'summary_failed'
  | 'typed_keys_deleted'
  | 'person_reminder_failed'
  | 'balances_row_unusable'
  | 'balances_row_deleted'
  | 'pdf_characters_replaced'
  | 'nightly_check_failed'
  | 'nightly_check_finding'
  | 'nightly_check_cut_off'
  | 'password_notice'

/** What the password notice did (identity-and-invites.md#password-notice). */
export type NoticeOutcome = 'sent' | 'stale' | 'unverified' | 'gone' | 'failed'

/** What a nightly-check finding breaks: the `balances` row, or a ledger invariant (ledger.md). */
export type LogRule = 'balances_row' | `I-${1 | 2 | 3 | 4 | 5 | 6 | 7}` | 'invariant'

export type LogFields = {
  groupId?: string
  statementId?: string
  transactionId?: string
  profileId?: string
  personId?: string
  reminderId?: string
  userId?: string
  problems?: readonly SnapshotProblem[]
  identityType?: 'email' | 'phone'
  rule?: LogRule
  outcome?: NoticeOutcome
  /** How many, such as the keys an adoption deleted. Anything but a whole number is `invalid`. */
  count?: number
  /** The error behind it. Only its name is written (`describe`). */
  error?: unknown
}

/**
 * Writes one JSON line for something that happened inside a route: `{ fn, event, groupId?,
 * statementId?, transactionId?, profileId?, personId?, reminderId?, userId?, problems?,
 * identityType?, rule?, outcome?, count?, cause? }`. Only IDs, fixed names, counts and error names, never text that could
 * quote what someone typed (security-and-privacy.md). A value passed as an ID that isn't one is
 * written as `invalid`.
 */
export function logProblem(event: LogEvent, fields: LogFields = {}): void {
  const { groupId, statementId, transactionId, profileId, personId, reminderId, userId } = fields
  const { problems, identityType, rule, outcome, count } = fields
  const line = {
    fn: process.env.APPWRITE_FUNCTION_ID ?? 'unknown',
    event,
    groupId: id(groupId),
    statementId: id(statementId),
    transactionId: id(transactionId),
    profileId: id(profileId),
    personId: id(personId),
    reminderId: id(reminderId),
    userId: id(userId),
    problems,
    identityType,
    rule,
    outcome,
    count: count === undefined || (Number.isSafeInteger(count) && count >= 0) ? count : 'invalid',
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
