import { requireUser } from '@ledgerly/server/auth/require-member'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { previewStatement } from './routes/preview'
import { refreshStatement } from './routes/refresh'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The statements routes (functions-api.md#statements). Tests pass fake services. */
export function statementsRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'statements', version }), { public: true }),
    route('POST', '/statements/preview', async (ctx) =>
      previewStatement(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/statements/:id/refresh', async (ctx) =>
      refreshStatement(services(ctx), requireUser(ctx.userId), ctx.params.id),
    ),
  ]
}

export default createHandler(statementsRoutes(servicesFromRequest))
