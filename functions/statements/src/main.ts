import { requireUser } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import {
  createHandler,
  type Route,
  type RouteContext,
  route,
} from '@ledgerly/server/http/create-handler'
import { checkFonts } from '@ledgerly/server/pdf/fonts'
import { closeStatement } from './routes/close'
import { discardRoute } from './routes/discard'
import { draftDueStatements } from './routes/draft-due'
import { finalizeRoute } from './routes/finalize'
import { previewStatement } from './routes/preview'
import { refreshStatement } from './routes/refresh'
import { reissueStatement } from './routes/reissue'
import { sendRoute } from './routes/send'
import { voidRoute } from './routes/void'
import { type Services, servicesFromRequest } from './services'

// The commit this bundle was built from (scripts/build-functions.mjs).
const version = process.env.LEDGERLY_VERSION ?? 'dev'

/** The statements routes (functions-api.md#statements). Tests pass fake services. */
export function statementsRoutes(
  services: (ctx: Pick<RouteContext, 'db' | 'headers'>) => Services,
): Route[] {
  return [
    route(
      'GET',
      '/health',
      async () => {
        // The invoice PDF's font files are in dist/fonts/ (scripts/build-functions.mjs).
        checkFonts()
        return { fn: 'statements', version }
      },
      { public: true },
    ),
    // Appwrite runs the cron as POST / (statements.md#1-draft). Never for a person.
    route('POST', '/', async (ctx) => {
      if (!ctx.scheduled) throw new AppError('FORBIDDEN', 'Only the statements job runs this.')
      return draftDueStatements(services(ctx))
    }),
    route('POST', '/statements/preview', async (ctx) =>
      previewStatement(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/statements/close', async (ctx) =>
      closeStatement(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
    route('POST', '/statements/:id/refresh', async (ctx) =>
      refreshStatement(services(ctx), requireUser(ctx.userId), ctx.params.id),
    ),
    route('POST', '/statements/:id/finalize', async (ctx) =>
      finalizeRoute(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
    route('POST', '/statements/:id/send', async (ctx) =>
      sendRoute(services(ctx), requireUser(ctx.userId), ctx.params.id),
    ),
    route('POST', '/statements/:id/void', async (ctx) =>
      voidRoute(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
    route('POST', '/statements/:id/discard', async (ctx) =>
      discardRoute(services(ctx), requireUser(ctx.userId), ctx.params.id, ctx.body),
    ),
    route('POST', '/statements/reissue', async (ctx) =>
      reissueStatement(services(ctx), requireUser(ctx.userId), ctx.body),
    ),
  ]
}

export default createHandler(statementsRoutes(servicesFromRequest))
