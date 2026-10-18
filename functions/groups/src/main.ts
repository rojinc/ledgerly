import { requireUser } from '@ledgerly/server/auth/require-member'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { addMember } from './routes/add-member'
import { archiveGroup } from './routes/archive-group'
import { createGroup } from './routes/create-group'
import { deleteMember } from './routes/delete-member'
import { leaveGroup } from './routes/leave-group'
import { updateGroup } from './routes/update-group'
import { updateMember } from './routes/update-member'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The groups routes (functions-api.md#groups). Tests pass fake services. */
export function groupsRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route('GET', '/health', async () => ({ fn: 'groups', version }), { public: true }),
    route('POST', '/groups', async (ctx) =>
      createGroup(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('PATCH', '/groups/:id', async (ctx) =>
      updateGroup(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
    route('POST', '/groups/:id/archive', async (ctx) =>
      archiveGroup(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
    route('POST', '/groups/:id/members', async (ctx) =>
      addMember(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
    route('PATCH', '/groups/:id/members/:memberId', async (ctx) =>
      updateMember(
        services(ctx),
        requireUser(ctx.userId),
        ctx.params.id,
        ctx.params.memberId,
        ctx.body,
      ),
    ),
    route('DELETE', '/groups/:id/members/:memberId', async (ctx) =>
      deleteMember(
        services(ctx),
        requireUser(ctx.userId),
        ctx.params.id,
        ctx.params.memberId,
        ctx.body,
      ),
    ),
    route('POST', '/groups/:id/leave', async (ctx) =>
      leaveGroup(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
  ]
}

export default createHandler(groupsRoutes(servicesFromRequest))
