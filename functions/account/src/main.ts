import { requireUser } from '@ledgerly/server/auth/require-member'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { deleteAccount } from './routes/delete-account'
import { hourlyJob } from './routes/hourly-job'
import { JOB_BUDGET_MS, ROUTE_BUDGET_MS, type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The account routes (functions-api.md#account). Tests pass fake services. */
export function accountRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>, budgetMs: number) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'account', version }), { public: true }),
    // Appwrite runs the cron as POST /. Never for a person.
    route('POST', '/', async (ctx) => hourlyJob(ctx.scheduled, () => services(ctx, JOB_BUDGET_MS))),
    route('POST', '/delete', async (ctx) =>
      deleteAccount(
        services(ctx, ROUTE_BUDGET_MS),
        requireUser(ctx.userId),
        ctx.sessionId,
        ctx.body,
      ),
    ),
  ]
}

export default createHandler(accountRoutes(servicesFromRequest))
