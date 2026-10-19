import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { type Models, Teams, Users } from 'node-appwrite'

// `POST /delete` stops starting new work after this, inside the 30 s synchronous limit; the
// hourly job deletes the rest (functions-api.md#account).
const ROUTE_BUDGET_MS = 20_000

/** The parts of an Appwrite account that deletion reads. */
export type AccountUser = Pick<Models.User, '$id' | 'labels' | 'passwordUpdate' | 'status'>

/** The parts of Users that account uses; the real `Users` satisfies it. */
export interface UsersApi {
  get(params: { userId: string }): Promise<AccountUser>
  listSessions(params: {
    userId: string
  }): Promise<{ sessions: Array<Pick<Models.Session, '$id' | '$createdAt'>> }>
  updateLabels(params: { userId: string; labels: string[] }): Promise<unknown>
  updateStatus(params: { userId: string; status: boolean }): Promise<unknown>
  deleteSessions(params: { userId: string }): Promise<unknown>
  delete(params: { userId: string }): Promise<unknown>
}

/** What the routes work with, so tests can pass FakeDb, fakes and a fixed clock. */
export type Services = {
  db: Db
  teams: TeamsApi
  users: UsersApi
  now: Date
  /** True once this request's time budget is used up. */
  outOfTime: () => boolean
}

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  const stopAt = performance.now() + ROUTE_BUDGET_MS
  const client = clientFromRequest(ctx.headers)
  return {
    db: ctx.db,
    teams: new Teams(client),
    users: new Users(client),
    now: new Date(),
    outOfTime: () => performance.now() >= stopAt,
  }
}
