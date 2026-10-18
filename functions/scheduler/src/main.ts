import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { previewSchedule } from './routes/preview-schedule'
import { run } from './routes/run'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The scheduler routes (functions-api.md#scheduler). Tests pass fake services. */
export function schedulerRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'scheduler', version }), { public: true }),
    route('POST', '/', async (ctx) => run(services(ctx), ctx.scheduled)),
    route('POST', '/schedules/preview', async (ctx) =>
      previewSchedule(services(ctx), ctx.userId, ctx.body),
    ),
  ]
}

export default createHandler(schedulerRoutes(servicesFromRequest))
