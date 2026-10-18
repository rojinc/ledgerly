import { clientFromRequest } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import type { RouteContext } from '@ledgerly/server/http/create-handler'
import { Teams } from 'node-appwrite'

/** What the routes use besides the database, so tests can pass a FakeTeams. */
export type Services = { teams: Pick<TeamsApi, 'listMemberships'> }

export type ServicesFor = (ctx: Pick<RouteContext, 'headers'>) => Services

/**
 * The real services for one request, with the per-execution API key. Teams is built only when
 * asked, since only a `left` member needs it (requireMember).
 */
export const servicesFromRequest: ServicesFor = (ctx) => ({
  teams: {
    listMemberships: (params) => new Teams(clientFromRequest(ctx.headers)).listMemberships(params),
  },
})
