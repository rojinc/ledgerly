import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import { autoPost, type PostCounts } from '../steps/auto-post'
import { type ExpandCounts, expandDueSchedules } from '../steps/expand'
import { type CheckCounts, nightlyCheck } from '../steps/nightly-check'
import { type ReminderCounts, sendReminders } from '../steps/reminders'

export type RunResult = {
  expanded: ExpandCounts
  posted: PostCounts
  reminders: ReminderCounts
  checked: CheckCounts
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
  return { expanded, posted, reminders, checked: await nightlyCheck(built) }
}
