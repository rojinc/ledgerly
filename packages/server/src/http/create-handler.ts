import { type Db, dbFromRequest } from '../appwrite/client'
import { AppError, type ErrorCode } from './app-error'

/** The parts of the context Appwrite's Node runtime passes to a function that we use. */
export type AppwriteContext = {
  req: { method: string; path: string; headers: Record<string, string>; bodyText: string }
  res: { json(body: unknown, statusCode?: number): unknown }
  log(message: string): void
  error(message: string): void
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type RouteContext<Params = Record<string, string>> = {
  /** From `x-appwrite-user-id`; null when nobody is signed in (and for cron runs). */
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
 * and logs one line per request: `{ fn, route, status, ms, code? }`, with no personal data.
 */
export function createHandler(
  routes: readonly Route[],
  makeDb: (headers: Record<string, string>) => Db = dbFromRequest,
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
      let db: Db | undefined
      const data = await match.route.handler({
        userId: headers['x-appwrite-user-id'] || null,
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

function findRoute(
  routes: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | undefined {
  const parts = trimSlashes(path).split('/')
  for (const route of routes) {
    if (route.method !== method) continue
    const pattern = trimSlashes(route.path).split('/')
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    const matched = pattern.every((segment, index) => {
      const part = parts[index] ?? ''
      if (!segment.startsWith(':')) return segment === part
      const value = decode(part)
      if (!value) return false
      params[segment.slice(1)] = value
      return true
    })
    if (matched) return { route, params }
  }
  return undefined
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined // malformed %-escape: treat as no match
  }
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The request body is not valid JSON.')
  }
}

// For the log line of a 5xx. Error messages from our code and the SDK name IDs, not people.
function describe(thrown: unknown): string {
  const text = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
  return text.slice(0, 300)
}
