import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
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

/** What the routes work with, so tests can pass FakeDb, FakeTeams and a fixed clock. */
export type Services = { db: Db; teams: TeamsApi; users: UsersApi; now: Date }

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  const client = clientFromRequest(ctx.headers)
  return { db: ctx.db, teams: new Teams(client), users: new Users(client), now: new Date() }
}
