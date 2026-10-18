import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../appwrite/client'
import { FakeDb } from '../appwrite/fake'
import { AppError } from './app-error'
import { type AppwriteContext, createHandler, type Route, route } from './create-handler'

type Request = Partial<AppwriteContext['req']>

async function call(handler: ReturnType<typeof createHandler>, request: Request = {}) {
  const logs: string[] = []
  const errors: string[] = []
  let response: { body: unknown; status: number | undefined } | undefined
  await handler({
    req: { method: 'GET', path: '/', headers: {}, bodyText: '', ...request },
    res: {
      json: (body, status) => {
        response = { body, status }
        return response
      },
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  })
  return { ...response, logs, errors }
}

describe('createHandler', () => {
  beforeEach(() => {
    vi.stubEnv('APPWRITE_FUNCTION_ID', 'ledger')
    verify.mockClear()
  })
  afterEach(() => vi.unstubAllEnvs())

  const echo = route('POST', '/transactions/:id/post', async ({ params, body, userId }) => ({
    id: params.id,
    body,
    userId,
  }))
  // Stands in for Appwrite's account.get(): `jwt-<id>` is a valid JWT for user <id>.
  const verify = vi.fn(async (jwt: string) => {
    if (!jwt.startsWith('jwt-')) throw new AppwriteException('Invalid JWT', 401, 'user_jwt_invalid')
    return jwt.slice(4)
  })

  it('routes by method and path, with :params, the JSON body and the caller', async () => {
    const result = await call(createHandler([echo], undefined, verify), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-jwt': 'jwt-u1' },
      bodyText: '{"date":"2026-10-18"}',
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      data: { id: 't1', body: { date: '2026-10-18' }, userId: 'u1' },
    })
  })

  it('picks the route whose method and every segment match', async () => {
    const routes: Route[] = [
      route('GET', '/groups/:groupId/balances', async ({ params }) => `balances ${params.groupId}`),
      route('POST', '/groups/:id/archive', async ({ params }) => `archive ${params.id}`),
      route('POST', '/groups/:id/members', async ({ params }) => `members ${params.id}`),
    ]
    const handler = createHandler(routes)
    const archive = await call(handler, { method: 'POST', path: '/groups/g1/archive' })
    const balances = await call(handler, { method: 'get', path: '/groups/g1/balances/' })
    expect(archive.body).toEqual({ ok: true, data: 'archive g1' })
    expect(balances.body).toEqual({ ok: true, data: 'balances g1' })
  })

  it('accepts any Appwrite ID as a param, and header names in any case', async () => {
    const id = 'sched_2026.10-18_abcdefghijklmnopqrs' // 36 chars: the longest Appwrite ID
    const result = await call(createHandler([echo], undefined, verify), {
      method: 'POST',
      path: `/transactions/${id}/post`,
      headers: { 'X-Appwrite-User-Jwt': 'jwt-u2' },
    })
    expect(result.body).toEqual({ ok: true, data: { id, body: undefined, userId: 'u2' } })
  })

  it('prefers the route with more literal segments, whatever the order', async () => {
    const handler = createHandler([
      route('POST', '/statements/:id', async ({ params }) => `statement ${params.id}`),
      route('POST', '/statements/reissue', async () => 'reissue'),
    ])
    const reissue = await call(handler, { method: 'POST', path: '/statements/reissue' })
    const statement = await call(handler, { method: 'POST', path: '/statements/s1' })
    expect(reissue.body).toEqual({ ok: true, data: 'reissue' })
    expect(statement.body).toEqual({ ok: true, data: 'statement s1' })
  })

  it.each([
    ['an unknown path', 'POST', '/nope'],
    ['the wrong method', 'GET', '/transactions/t1/post'],
    ['a missing param', 'POST', '/transactions//post'],
    ['an encoded slash', 'POST', '/transactions/a%2Fb/post'],
    ['an encoded ..', 'POST', '/transactions/%2E%2E/post'],
    ['..', 'POST', '/transactions/../post'],
    ['a param starting with a special character', 'POST', '/transactions/_t1/post'],
    ['a param longer than 36 characters', 'POST', `/transactions/${'a'.repeat(37)}/post`],
  ])('returns NOT_FOUND for %s', async (_, method, path) => {
    const result = await call(createHandler([echo]), { method, path })
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(JSON.parse(result.logs[0] ?? '')).toMatchObject({ route: null, status: 404 })
  })

  it('returns VALIDATION_FAILED when the body is not JSON', async () => {
    const result = await call(createHandler([echo]), {
      method: 'POST',
      path: '/transactions/t1/post',
      bodyText: '{"date":',
    })
    expect(result.status).toBe(400)
    expect(result.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'The request body is not valid JSON.' },
    })
  })

  it('never trusts x-appwrite-user-id: without a JWT the caller is signed out', async () => {
    // A client can send X-Appwrite-User-Id in an execution's headers (permissions.md).
    const result = await call(createHandler([echo], undefined, verify), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-id': 'victim' },
    })
    expect(result.body).toMatchObject({ data: { userId: null } })
    expect(verify).not.toHaveBeenCalledWith('victim')
  })

  it('takes the caller from the verified JWT, not a forged user ID', async () => {
    const result = await call(createHandler([echo], undefined, verify), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-jwt': 'jwt-me', 'x-appwrite-user-id': 'victim, me' },
    })
    expect(result.body).toMatchObject({ data: { userId: 'me' } })
  })

  it('returns UNAUTHENTICATED for a JWT Appwrite rejects, without running the route', async () => {
    const handler = vi.fn(async () => 'ran')
    const result = await call(createHandler([route('GET', '/x', handler)], undefined, verify), {
      path: '/x',
      headers: { 'x-appwrite-user-jwt': 'forged.jwt.value' },
    })
    expect(result.status).toBe(401)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    expect(handler).not.toHaveBeenCalled()
    expect(result.logs[0]).not.toMatch(/forged/)
  })

  it('returns INTERNAL when Appwrite can’t be reached to verify the JWT', async () => {
    const unreachable = async (): Promise<string> => {
      throw new TypeError('fetch failed')
    }
    const result = await call(createHandler([echo], undefined, unreachable), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-jwt': 'jwt-u1' },
    })
    expect(result.status).toBe(500)
    expect(JSON.parse(result.errors[0] ?? '')).toMatchObject({ cause: 'TypeError' })
  })

  it('verifies nothing for a path with no route', async () => {
    const result = await call(createHandler([echo], undefined, verify), {
      path: '/nope',
      headers: { 'x-appwrite-user-jwt': 'jwt-u1' },
    })
    expect(result.status).toBe(404)
    expect(verify).not.toHaveBeenCalled()
  })

  it('turns an AppError into the envelope with its status and details', async () => {
    const handler = createHandler([
      route('POST', '/a', async () => {
        throw new AppError('VALIDATION_FAILED', 'Check the date', [{ path: ['date'] }])
      }),
      route('POST', '/b', async () => {
        throw new AppError('ARCHIVED', 'Archived')
      }),
    ])
    const a = await call(handler, { method: 'POST', path: '/a' })
    const b = await call(handler, { method: 'POST', path: '/b' })
    expect(a.status).toBe(400)
    expect(a.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Check the date',
        details: [{ path: ['date'] }],
      },
    })
    expect(b.status).toBe(409)
    expect(b.body).toEqual({ ok: false, error: { code: 'ARCHIVED', message: 'Archived' } })
  })

  it('hides unexpected errors behind INTERNAL and logs them with error()', async () => {
    const handler = createHandler([
      route('GET', '/boom', async () => {
        throw new TypeError('row.status is undefined')
      }),
    ])
    const result = await call(handler, { path: '/boom' })
    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'Something went wrong on our side. Try again.' },
    })
    expect(result.logs).toEqual([])
    expect(JSON.parse(result.errors[0] ?? '')).toMatchObject({
      fn: 'ledger',
      route: 'GET /boom',
      status: 500,
      code: 'INTERNAL',
      cause: 'TypeError',
    })
  })

  it('logs only the name of a 5xx cause, never its message, which can quote input', async () => {
    const handler = createHandler([
      route('GET', '/profile', async () => JSON.parse('alice@example.com')),
      route('GET', '/row', async () => {
        throw new AppwriteException('Row bob@example.com not found', 404, 'row_not_found')
      }),
    ])
    const parse = await call(handler, { path: '/profile' })
    const appwrite = await call(handler, { path: '/row' })
    expect(JSON.parse(parse.errors[0] ?? '')).toMatchObject({ cause: 'SyntaxError' })
    expect(JSON.parse(appwrite.errors[0] ?? '')).toMatchObject({
      cause: 'AppwriteException 404 row_not_found',
    })
    expect([...parse.errors, ...appwrite.errors].join('\n')).not.toMatch(/alice|bob|example/)
  })

  it('sends data: null when a route returns nothing', async () => {
    const handler = createHandler([route('DELETE', '/x/:id', async () => undefined)])
    const result = await call(handler, { method: 'DELETE', path: '/x/1' })
    expect(result.body).toEqual({ ok: true, data: null })
  })

  it('logs one line per request with the route pattern and no personal data', async () => {
    const result = await call(createHandler([echo], undefined, verify), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-jwt': 'jwt-u1' },
      bodyText: '{"email":"alice@example.com","displayName":"Alice"}',
    })
    expect(result.logs).toHaveLength(1)
    const line = JSON.parse(result.logs[0] ?? '')
    expect(line).toEqual({
      fn: 'ledger',
      route: 'POST /transactions/:id/post',
      status: 200,
      ms: expect.any(Number),
    })
    expect(result.logs[0]).not.toMatch(/alice|Alice|t1|u1|jwt/)
  })

  it('creates the database client once, only when a route uses it', async () => {
    const fake = new FakeDb()
    const makeDb = vi.fn((_headers: Record<string, string>): Db => fake)
    const handler = createHandler(
      [
        route('GET', '/health', async () => 'ok'),
        route('GET', '/twice', async (ctx) => {
          const first = ctx.db
          return first === ctx.db
        }),
      ],
      makeDb,
    )
    await call(handler, { path: '/health' })
    expect(makeDb).not.toHaveBeenCalled()
    const result = await call(handler, { path: '/twice', headers: { 'X-Appwrite-Key': 'k' } })
    expect(result.body).toEqual({ ok: true, data: true })
    expect(makeDb).toHaveBeenCalledTimes(1)
    expect(makeDb).toHaveBeenCalledWith(expect.objectContaining({ 'x-appwrite-key': 'k' }))
  })
})
