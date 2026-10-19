import { requireUser } from '@ledgerly/server/auth/require-member'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { deleteAccount } from './routes/delete-account'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The account routes (functions-api.md#account). Tests pass fake services. */
export function accountRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'account', version }), { public: true }),
    route('POST', '/delete', async (ctx) =>
      deleteAccount(services(ctx), requireUser(ctx.userId), ctx.sessionId, ctx.body),
    ),
  ]
}

export default createHandler(accountRoutes(servicesFromRequest))
