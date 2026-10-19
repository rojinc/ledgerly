import { requireUser } from '@ledgerly/server/auth/require-member'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { acceptInvite } from './routes/accept-invite'
import { bootstrap } from './routes/bootstrap'
import { postClaim } from './routes/claim'
import { eventRun } from './routes/event-run'
import { createInvite } from './routes/invites'
import { joinPendingGroup, listPendingGroups } from './routes/pending-groups'
import { updateProfile } from './routes/profile'
import { sendReminder } from './routes/reminders'
import { run } from './routes/run'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The identity routes (functions-api.md#identity). Tests pass fake services. */
export function identityRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'identity', version }), { public: true }),
    // One route for every run that comes with no caller: the hourly schedule finishes merges
    // (identity-and-invites.md#finishing-merges), and the users.*.update.password,
    // users.*.recovery.*.update, users.*.update.email and users.*.update.phone events send the
    // password and change notices (#password-notice, #email-and-phone-change-notice). A signed-in
    // call gets FORBIDDEN; one with neither a JWT nor a trigger gets createHandler's
    // UNAUTHENTICATED first.
    route(
      'POST',
      '/',
      async (ctx) =>
        ctx.scheduled
          ? run(ctx.scheduled, () => services(ctx))
          : eventRun(services(ctx), ctx.event, ctx.headers, ctx.body),
      { event: true },
    ),
    route('POST', '/bootstrap', async (ctx) =>
      bootstrap(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('PATCH', '/profile', async (ctx) =>
      updateProfile(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/claim', async (ctx) =>
      postClaim(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/invites', async (ctx) =>
      createInvite(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/invites/accept', async (ctx) =>
      acceptInvite(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/reminders', async (ctx) =>
      sendReminder(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('GET', '/groups/pending', async (ctx) =>
      listPendingGroups(services(ctx), requireUser(ctx.userId)),
    ),
    route('POST', '/groups/:id/join', async (ctx) =>
      joinPendingGroup(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
  ]
}

export default createHandler(identityRoutes(servicesFromRequest))
