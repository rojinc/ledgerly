import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import { autoPost, type PostCounts } from '../steps/auto-post'
import { type ExpandCounts, expandDueSchedules } from '../steps/expand'
import { cleanUpInvites, type InviteCounts } from '../steps/invite-cleanup'
import { type CheckCounts, nightlyCheck } from '../steps/nightly-check'
import { cleanUpPlaceholders, type PlaceholderCounts } from '../steps/placeholder-cleanup'
import { type CleanUpCounts, cleanUpReceipts } from '../steps/receipts'
import { type ReminderCounts, sendReminders } from '../steps/reminders'
import { type SummaryCounts, sendSummaries } from '../steps/summaries'
import { type ChangeCounts, sendTransactionChanges } from '../steps/transaction-changes'

export type RunResult = {
  expanded: ExpandCounts
  posted: PostCounts
  reminders: ReminderCounts
  changes: ChangeCounts
  summaries: SummaryCounts
  receipts: CleanUpCounts
  invites: InviteCounts
  placeholders: PlaceholderCounts
  nightly: CheckCounts
}

/**
 * The hourly cron run (scheduling.md#the-scheduler-job): Appwrite sends it as `POST /` with
 * the `schedule` trigger. The steps run in order. Returns counts only, so the execution log
 * holds no personal data.
 */
export async function run(scheduled: boolean, services: () => Services): Promise<RunResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled) throw new AppError('FORBIDDEN', 'Only the scheduler’s own cron runs this.')
  const built = services()
  const expanded = await expandDueSchedules(built)
  const posted = await autoPost(built)
  const reminders = await sendReminders(built)
  const changes = await sendTransactionChanges(built)
  const summaries = await sendSummaries(built)
  const receipts = await cleanUpReceipts(built)
  const invites = await cleanUpInvites(built)
  const placeholders = await cleanUpPlaceholders(built)
  const nightly = await nightlyCheck(built)
  return {
    expanded,
    posted,
    reminders,
    changes,
    summaries,
    receipts,
    invites,
    placeholders,
    nightly,
  }
}
