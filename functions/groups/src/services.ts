import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { Teams } from 'node-appwrite'

/** What the routes work with, so tests can pass FakeDb, FakeTeams and a fixed clock. */
export type Services = { db: Db; teams: TeamsApi; now: Date }

/** The real services for one request, with the per-execution API key. */
export function servicesFromRequest(ctx: Pick<RouteContext, 'db' | 'headers'>): Services {
  return { db: ctx.db, teams: new Teams(clientFromRequest(ctx.headers)), now: new Date() }
}
