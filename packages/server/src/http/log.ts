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
  | 'change_notice'
  | 'team_membership_removed'
  | 'schedule_template_unreadable'
  | 'stuck_finalize_not_archived'
  | 'merge_no_member_dates'
  | 'merge_member_dates_unreadable'
  | 'merge_left_transaction'
  | 'merge_left_locked_transaction'
  | 'merge_left_schedule'
  | 'merge_left_stray_row'
  | 'merge_left_subjects'
  | 'merge_put_off_team_gone'
  | 'merge_left_inputs'
  | 'merge_typed_keys_deleted'
  | 'merge_finished'
  | 'merge_carries_on'
  | 'merge_stopped_into_deleted'
  | 'merge_stopped'
  | 'merge_run_failed'
  | 'merge_walk_cut_off'
  | 'merge_run'
  | 'invite_cleanup_failed'
  | 'account_finish_failed'

/**
 * How each event is written. Most are problems, written with `console.error`: until alerting
 * exists, the error lines are the alert (scheduling.md#step-6-nightly-check). These aren't: `log`
 * for what went as it should, `warn` for something to look at that isn't a failure. A password or
 * change notice is an error only when a send failed, and a change notice's `mismatch` a warning.
 */
const LEVELS: Partial<Record<LogEvent, 'log' | 'warn'>> = {
  typed_keys_deleted: 'log',
  merge_typed_keys_deleted: 'log',
  merge_finished: 'log',
  merge_carries_on: 'log',
  merge_stopped_into_deleted: 'log',
  merge_run: 'log',
  claim_identity_unusable: 'warn',
  nightly_check_cut_off: 'warn',
  pdf_characters_replaced: 'warn',
  merge_left_transaction: 'warn',
  merge_left_locked_transaction: 'warn',
  merge_left_schedule: 'warn',
  merge_left_stray_row: 'warn',
  merge_left_subjects: 'warn',
  merge_put_off_team_gone: 'warn',
  merge_left_inputs: 'warn',
  merge_stopped: 'warn',
  merge_walk_cut_off: 'warn',
}

/** What the password notice did (identity-and-invites.md#password-notice). */
export type NoticeOutcome = 'sent' | 'stale' | 'unverified' | 'gone' | 'failed'

/**
 * What the email or phone change notice did, for one email or for the run
 * (identity-and-invites.md#email-and-phone-change-notice).
 */
export type ChangeNoticeOutcome =
  | 'sent'
  | 'gone'
  | 'no_old_address'
  | 'unverified'
  | 'mismatch'
  | 'failed'

/**
 * What a merge moved or left (identity-and-invites.md#merging-two-persons), and what the hourly
 * run found (#finishing-merges): merges, and the merged persons it read. Each a count.
 */
const COUNTS = [
  'groupsJoined',
  'inputs',
  'voided',
  'shares',
  'subjects',
  'reminders',
  'leftAsTheyAre',
  'identities',
  'groupsPutOff',
  'unfinished',
  'finished',
  'skipped',
  'cutOff',
  'stopped',
  'personsRead',
] as const
export type LogCount = (typeof COUNTS)[number]

/** What a nightly-check finding breaks: the `balances` row, or a ledger invariant (ledger.md). */
export type LogRule = 'balances_row' | `I-${1 | 2 | 3 | 4 | 5 | 6 | 7}` | 'invariant'

/**
 * Row IDs only: an ID is checked for its shape, so a name or number shaped like one gets through.
 */
export type LogFields = {
  groupId?: string
  statementId?: string
  transactionId?: string
  profileId?: string
  personId?: string
  reminderId?: string
  userId?: string
  membershipId?: string
  scheduleId?: string
  /** The person a merge moves another one into (`personId` is the one it moves). */
  intoPersonId?: string
  /** A row a merge left, and its table. */
  rowId?: string
  table?: 'members' | 'shares'
  problems?: readonly SnapshotProblem[]
  identityType?: 'email' | 'phone'
  rule?: LogRule
  outcome?: NoticeOutcome | ChangeNoticeOutcome
  /**
   * How many things, such as the keys an adoption deleted; never an amount of money. Anything
   * but a whole number is `invalid`.
   */
  count?: number
  /** Several counts, by name; each is checked as `count` is. */
  counts?: Partial<Record<LogCount, number>>
  /** The error behind it. Only its name is written (`describe`). */
  error?: unknown
  /**
   * A fixed cause, for a failure with no error behind it: `budget`, a change notice's addresses
   * left when its time ran out. `error` wins over it.
   */
  cause?: 'budget'
}

/**
 * Writes one JSON line for something that happened inside a route: `{ fn, event, groupId?,
 * statementId?, transactionId?, profileId?, personId?, reminderId?, userId?, membershipId?,
 * scheduleId?, intoPersonId?, rowId?, table?, problems?, identityType?, rule?, outcome?, count?,
 * counts?, cause? }`, at the event's
 * level (`LEVELS`). Only row IDs, fixed names, counts and error names, never text that could quote
 * what someone typed (security-and-privacy.md). A value passed as an ID that isn't shaped like one
 * is written as `invalid`.
 */
export function logProblem(event: LogEvent, fields: LogFields = {}): void {
  const { groupId, statementId, transactionId, profileId, personId, reminderId, userId } = fields
  const { membershipId, scheduleId, intoPersonId, rowId, table } = fields
  const { problems, identityType, rule, outcome, count, counts } = fields
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
    membershipId: id(membershipId),
    scheduleId: id(scheduleId),
    intoPersonId: id(intoPersonId),
    rowId: id(rowId),
    table,
    problems,
    identityType,
    rule,
    outcome,
    count: whole(count),
    counts:
      counts &&
      Object.fromEntries(
        COUNTS.filter((name) => counts[name] !== undefined).map((name) => [
          name,
          whole(counts[name]),
        ]),
      ),
    // Pinned at run time too, as a cast could pass any text.
    cause:
      'error' in fields ? describe(fields.error) : fields.cause === 'budget' ? 'budget' : undefined,
  }
  const level =
    event === 'password_notice' || event === 'change_notice'
      ? outcome === 'failed'
        ? 'error'
        : outcome === 'mismatch'
          ? 'warn'
          : 'log'
      : (LEVELS[event] ?? 'error')
  // biome-ignore lint/suspicious/noConsole: the one place a function logs from inside a route.
  console[level](JSON.stringify(line))
}

/**
 * Names an error for a log line, never its message: messages can quote input or stored text
 * (JSON.parse puts the text it failed on in its message).
 */
export function describe(error: unknown): string {
  if (error instanceof AppError) return `AppError ${error.code}`
  if (error instanceof AppwriteException) {
    // node-appwrite's type is '' for a reply that isn't JSON (a 502 from the edge, say).
    return `AppwriteException ${error.code} ${name(error.type)}`.trim()
  }
  if (error instanceof EmailError) return `EmailError ${error.type} ${error.status ?? ''}`.trim()
  return error instanceof Error ? name(error.name) : typeof error
}

// An error's name or type is written only when it looks like one (as sendEmail checks
// EmailError.type), since any code can set it.
const name = (value: string) => (/^[A-Za-z_]{0,64}$/.test(value) ? value : 'invalid')

const whole = (value: number | undefined) =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0) ? value : 'invalid'

const id = (value: string | undefined) =>
  value === undefined || idSchema.safeParse(value).success ? value : 'invalid'
