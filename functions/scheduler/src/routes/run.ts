import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import { autoPost, type PostCounts } from '../steps/auto-post'
import { type ExpandCounts, expandDueSchedules } from '../steps/expand'
import { cleanUpInvites, type InviteCounts } from '../steps/invite-cleanup'
import { type CheckCounts, nightlyCheck } from '../steps/nightly-check'
import { type CleanUpCounts, cleanUpReceipts } from '../steps/receipts'
import { type ReminderCounts, sendReminders } from '../steps/reminders'
import { type SummaryCounts, sendSummaries } from '../steps/summaries'

export type RunResult = {
  expanded: ExpandCounts
  posted: PostCounts
  reminders: ReminderCounts
  summaries: SummaryCounts
  receipts: CleanUpCounts
  invites: InviteCounts
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
  const summaries = await sendSummaries(built)
  const receipts = await cleanUpReceipts(built)
  const invites = await cleanUpInvites(built)
  return {
    expanded,
    posted,
    reminders,
    summaries,
    receipts,
    invites,
    nightly: await nightlyCheck(built),
  }
}
