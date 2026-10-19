import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import { type Email, sendEmail } from '@ledgerly/server/email/send-email'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { type Models, Teams, Users } from 'node-appwrite'

// One cron run stops taking new rows after this, well inside the function's 900 s
// timeout; the next hourly run picks up the rest (scheduling.md#the-scheduler-job).
const RUN_BUDGET_MS = 12 * 60_000

/** The parts of an Appwrite account the reminders and summaries read. */
export type AccountUser = Pick<Models.User, '$id' | 'email' | 'emailVerification' | 'status'>

/** The parts of Users that the scheduler uses; the real `Users` satisfies it. */
export interface UsersApi {
  get(params: { userId: string }): Promise<AccountUser>
}

/** What the routes and jobs work with, so tests can pass FakeDb, fakes and a fixed clock. */
export type Services = {
  db: Db
  /**
   * For requireMember, which asks it only about a `left` member, and for step 6, which skips a
   * group whose team is gone (scheduling.md#step-6-nightly-check).
   */
  teams: Pick<TeamsApi, 'listMemberships'>
  users: UsersApi
  sendEmail: (email: Email) => Promise<unknown>
  now: Date
  /** The web app's address, for links in emails (environments-and-deploys.md). */
  appUrl: string
  /** True once this run's time budget is used up. */
  outOfTime: () => boolean
}

/**
 * The web app's address for links, without a trailing slash. Steps check it before any row,
 * so a missing APP_URL fails the run instead of every row.
 */
export function appBase(appUrl: string): string {
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error('APP_URL is not set. Add it as an Appwrite project variable.')
  }
  return appUrl.replace(/\/+$/, '')
}

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  const stopAt = performance.now() + RUN_BUDGET_MS
  const client = clientFromRequest(ctx.headers)
  return {
    db: ctx.db,
    teams: new Teams(client),
    users: new Users(client),
    sendEmail,
    now: new Date(),
    appUrl: process.env.APP_URL ?? '',
    outOfTime: () => performance.now() >= stopAt,
  }
}
