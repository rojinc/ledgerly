import { requireUser } from '@ledgerly/server/auth/require-member'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { bootstrap } from './routes/bootstrap'
import { postClaim } from './routes/claim'
import { passwordNotice } from './routes/password-notice'
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
    // One route for both runs that come with no caller: the hourly schedule finishes merges
    // (identity-and-invites.md#finishing-merges), and the users.*.update.password and
    // users.*.recovery.*.update events send the password notice (#password-notice). Anything
    // else, a signed-in call included, gets the password notice's FORBIDDEN.
    route(
      'POST',
      '/',
      async (ctx) =>
        ctx.scheduled
          ? run(ctx.scheduled, () => services(ctx))
          : passwordNotice(services(ctx), ctx.event, ctx.headers, ctx.body),
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
