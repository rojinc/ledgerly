import { AppError } from '@ledgerly/server/http/app-error'
import type { Services } from '../services'
import { type ReminderCounts, sendReminders } from '../steps/reminders'

export type RunResult = { reminders: ReminderCounts }

/**
 * The hourly cron run (scheduling.md#the-scheduler-job): Appwrite sends it as `POST /` with
 * the `schedule` trigger. The steps run in order; steps 1 and 2 come with the rest of #24.
 * Returns counts only, so the execution log holds no personal data.
 */
export async function run(scheduled: boolean, services: () => Services): Promise<RunResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled) throw new AppError('FORBIDDEN', 'Only the scheduler’s own cron runs this.')
  return { reminders: await sendReminders(services()) }
}
