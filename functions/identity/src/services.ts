import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import { type Email, sendEmail } from '@ledgerly/server/email/send-email'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { type Sms, sendSms } from '@ledgerly/server/sms/send-sms'
import { type Models, Teams, Users } from 'node-appwrite'

/** The parts of the caller's Appwrite account that identity reads. */
export type AccountUser = Pick<
  Models.User,
  '$id' | 'name' | 'email' | 'emailVerification' | 'phone' | 'phoneVerification'
>

/** The parts of Users that identity uses; the real `Users` satisfies it. */
export interface UsersApi {
  get(params: { userId: string }): Promise<AccountUser>
}

/**
 * What the routes work with, so tests can pass FakeDb, FakeTeams, fake email and SMS and a fixed
 * clock.
 */
export type Services = {
  db: Db
  teams: TeamsApi
  users: UsersApi
  sendEmail: (email: Email) => Promise<unknown>
  sendSms: (sms: Sms) => Promise<unknown>
  now: Date
  /** The web app's address, for links in emails and SMS (environments-and-deploys.md: `APP_URL`). */
  appUrl: string
}

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  const client = clientFromRequest(ctx.headers)
  return {
    db: ctx.db,
    teams: new Teams(client),
    users: new Users(client),
    sendEmail,
    sendSms,
    now: new Date(),
    appUrl: process.env.APP_URL ?? '',
  }
}
