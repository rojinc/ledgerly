import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { createSchedule } from './routes/create-schedule'
import { deleteSchedule } from './routes/delete-schedule'
import { endSchedule } from './routes/end-schedule'
import { pauseSchedule } from './routes/pause-schedule'
import { previewSchedule } from './routes/preview-schedule'
import { resumeSchedule } from './routes/resume-schedule'
import { run } from './routes/run'
import { updateSchedule } from './routes/update-schedule'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The scheduler routes (functions-api.md#scheduler). Tests pass fake services. */
export function schedulerRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'scheduler', version }), { public: true }),
    route('POST', '/', async (ctx) => run(ctx.scheduled, () => services(ctx))),
    route('POST', '/schedules', async (ctx) => createSchedule(services(ctx), ctx.userId, ctx.body)),
    route('PATCH', '/schedules/:id', async (ctx) =>
      updateSchedule(services(ctx), ctx.userId, ctx.params.id, ctx.body),
    ),
    route('POST', '/schedules/:id/end', async (ctx) =>
      endSchedule(services(ctx), ctx.userId, ctx.params.id, ctx.body),
    ),
    route('POST', '/schedules/:id/pause', async (ctx) =>
      pauseSchedule(services(ctx), ctx.userId, ctx.params.id, ctx.body),
    ),
    route('POST', '/schedules/:id/resume', async (ctx) =>
      resumeSchedule(services(ctx), ctx.userId, ctx.params.id),
    ),
    route('DELETE', '/schedules/:id', async (ctx) =>
      deleteSchedule(services(ctx), ctx.userId, ctx.params.id),
    ),
    route('POST', '/schedules/preview', async (ctx) =>
      previewSchedule(services(ctx), ctx.userId, ctx.body),
    ),
  ]
}

export default createHandler(schedulerRoutes(servicesFromRequest))
