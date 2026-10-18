import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import { type Email, sendEmail } from '@ledgerly/server/email/send-email'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { type Models, Users } from 'node-appwrite'

// One cron run stops starting new batches after this, well inside the function's 900 s
// timeout; the next hourly run picks up the rest (scheduling.md#the-scheduler-job).
const RUN_BUDGET_MS = 12 * 60_000

/** The parts of an Appwrite account the reminders read. */
export type AccountUser = Pick<Models.User, '$id' | 'email' | 'emailVerification'>

/** The parts of Users that the scheduler uses; the real `Users` satisfies it. */
export interface UsersApi {
  get(params: { userId: string }): Promise<AccountUser>
}

/** What the routes and jobs work with, so tests can pass FakeDb, fakes and a fixed clock. */
export type Services = {
  db: Db
  users: UsersApi
  sendEmail: (email: Email) => Promise<unknown>
  now: Date
  /** The web app's address, for links in emails (environments-and-deploys.md). */
  appUrl: string
  /** True once this run's time budget is used up. */
  outOfTime: () => boolean
}

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  const stopAt = performance.now() + RUN_BUDGET_MS
  return {
    db: ctx.db,
    users: new Users(clientFromRequest(ctx.headers)),
    sendEmail,
    now: new Date(),
    appUrl: process.env.APP_URL ?? '',
    outOfTime: () => performance.now() >= stopAt,
  }
}
