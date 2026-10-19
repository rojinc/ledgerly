import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import { type ExpandCounts, expandDueSchedules } from '../steps/expand'
import { type ReminderCounts, sendReminders } from '../steps/reminders'

export type RunResult = { expanded: ExpandCounts; reminders: ReminderCounts }

/**
 * The hourly cron run (scheduling.md#the-scheduler-job): Appwrite sends it as `POST /` with
 * the `schedule` trigger. The steps run in order; step 2 comes with the rest of #24. Returns
 * counts only, so the execution log holds no personal data.
 */
export async function run(scheduled: boolean, services: () => Services): Promise<RunResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled) throw new AppError('FORBIDDEN', 'Only the scheduler’s own cron runs this.')
  const built = services()
  const expanded = await expandDueSchedules(built)
  return { expanded, reminders: await sendReminders(built) }
}
