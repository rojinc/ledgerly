import { idSchema } from '@ledgerly/core/schemas/common'
import type { ErrorCode } from '@ledgerly/core/schemas/envelope'
import { AppwriteException } from 'node-appwrite'
import { callerFromJwt, type Db, dbFromRequest } from '../appwrite/client'
import { AppError } from './app-error'

/** The parts of the context Appwrite's Node runtime passes to a function that we use. */
export type AppwriteContext = {
  req: { method: string; path: string; headers: Record<string, string>; bodyText: string }
  res: { json(body: unknown, statusCode?: number): unknown }
  log(message: string): void
  error(message: string): void
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type RouteContext<Params = Record<string, string>> = {
  /**
   * From the JWT in `x-appwrite-user-jwt`, verified with Appwrite; null without one (cron
   * runs). Never `x-appwrite-user-id`, which a client can forge (permissions.md).
   */
  userId: string | null
  params: Params
  /** The parsed JSON body, or undefined when there is none. Validate it with the route's schema. */
  body: unknown
  /** Lower-cased request headers, for example to build other Appwrite services. */
  headers: Record<string, string>
  /** Created on first use, so routes that don't touch the database don't need a key. */
  db: Db
}

export type Route = {
  method: Method
  path: string
  handler: (ctx: RouteContext) => Promise<unknown>
}

// '/transactions/:id/post' → { id: string }
type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : Record<never, never>

/** Declares a route; `ctx.params` is typed from the `:params` in `path`. */
export function route<P extends string>(
  method: Method,
  path: P,
  handler: (ctx: RouteContext<PathParams<P>>) => Promise<unknown>,
): Route {
  // Matching guarantees every :param in `path` is present.
  return { method, path, handler: (ctx) => handler(ctx as RouteContext<PathParams<P>>) }
}

/**
 * The entry point of every function (functions-api.md#function-code-layout). Routes by method
 * and path, parses the JSON body, reads the caller, wraps the result in the response envelope
 * and logs one line per request: `{ fn, route, status, ms, code?, cause? }`, with no personal
 * data.
 */
export function createHandler(
  routes: readonly Route[],
  makeDb: (headers: Record<string, string>) => Db = dbFromRequest,
  verifyCaller: (jwt: string) => Promise<string> = callerFromJwt,
) {
  return async ({ req, res, log, error }: AppwriteContext): Promise<unknown> => {
    const started = performance.now()
    const method = req.method.toUpperCase()
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([name, value]) => [name.toLowerCase(), value]),
    )
    let routeName: string | null = null
    let status = 200
    let code: ErrorCode | undefined
    let cause: string | undefined
    let body: unknown
    try {
      const match = findRoute(routes, method, req.path)
      if (!match) throw new AppError('NOT_FOUND', `There is no ${method} ${req.path} route.`)
      routeName = `${method} ${match.route.path}`
      const jwt = headers['x-appwrite-user-jwt']
      const userId = jwt ? await callerOrUnauthenticated(verifyCaller, jwt) : null
      let db: Db | undefined
      const data = await match.route.handler({
        userId,
        params: match.params,
        body: parseBody(req.bodyText),
        headers,
        get db() {
          db ??= makeDb(headers)
          return db
        },
      })
      // The envelope always has `data`, so a route that returns nothing sends null.
      body = { ok: true, data: data ?? null }
    } catch (thrown) {
      const appError =
        thrown instanceof AppError
          ? thrown
          : new AppError('INTERNAL', 'Something went wrong on our side. Try again.')
      status = appError.status
      code = appError.code
      if (status >= 500) cause = describe(thrown)
      body = {
        ok: false,
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details === undefined ? {} : { details: appError.details }),
        },
      }
    }
    const ms = Math.round(performance.now() - started)
    const fn = process.env.APPWRITE_FUNCTION_ID ?? 'unknown'
    const line = JSON.stringify({ fn, route: routeName, status, ms, code, cause })
    if (status >= 500) error(line)
    else log(line)
    return res.json(body, status)
  }
}

// When several routes match, the one with the most literal segments wins, so a route like
// `POST /statements/reissue` beats `POST /statements/:id`.
function findRoute(
  routes: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | undefined {
  const parts = trimSlashes(path).split('/')
  let best: { route: Route; params: Record<string, string>; literals: number } | undefined
  for (const route of routes) {
    if (route.method !== method) continue
    const pattern = trimSlashes(route.path).split('/')
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    let literals = 0
    const matched = pattern.every((segment, index) => {
      const part = parts[index] ?? ''
      if (!segment.startsWith(':')) {
        literals += 1
        return segment === part
      }
      // A param must be an Appwrite ID, and is never URL-decoded: `%2E%2E` would become `..`,
      // and the SDK would send `rows/..` to another endpoint with the server key.
      if (!idSchema.safeParse(part).success) return false
      params[segment.slice(1)] = part
      return true
    })
    if (matched && (!best || literals > best.literals)) best = { route, params, literals }
  }
  return best
}

async function callerOrUnauthenticated(
  verifyCaller: (jwt: string) => Promise<string>,
  jwt: string,
): Promise<string> {
  try {
    return await verifyCaller(jwt)
  } catch (thrown) {
    // A forged, merged or expired JWT; anything else (Appwrite unreachable) stays a 500.
    if (thrown instanceof AppwriteException && thrown.code === 401) {
      throw new AppError('UNAUTHENTICATED', 'Your session has ended. Log in again.')
    }
    throw thrown
  }
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The request body is not valid JSON.')
  }
}

// Names the error behind a 5xx for the log line, never its message: messages can quote input
// (JSON.parse puts the text it failed on in its message), and logs hold no personal data.
function describe(thrown: unknown): string {
  if (thrown instanceof AppwriteException) {
    return `AppwriteException ${thrown.code} ${thrown.type}`
  }
  return thrown instanceof Error ? thrown.name : typeof thrown
}
