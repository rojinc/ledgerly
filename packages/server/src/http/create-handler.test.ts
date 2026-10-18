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
  beforeEach(() => vi.stubEnv('APPWRITE_FUNCTION_ID', 'ledger'))
  afterEach(() => vi.unstubAllEnvs())

  const echo = route('POST', '/transactions/:id/post', async ({ params, body, userId }) => ({
    id: params.id,
    body,
    userId,
  }))

  it('routes by method and path, with :params, the JSON body and the caller', async () => {
    const result = await call(createHandler([echo]), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-id': 'u1' },
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

  it('decodes params and treats header names case-insensitively', async () => {
    const result = await call(createHandler([echo]), {
      method: 'POST',
      path: '/transactions/a%2Fb/post',
      headers: { 'X-Appwrite-User-Id': 'u2' },
    })
    expect(result.body).toEqual({ ok: true, data: { id: 'a/b', body: undefined, userId: 'u2' } })
  })

  it.each([
    ['an unknown path', 'POST', '/nope'],
    ['the wrong method', 'GET', '/transactions/t1/post'],
    ['a missing param', 'POST', '/transactions//post'],
    ['a malformed escape', 'POST', '/transactions/%E0%A4%A/post'],
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

  it('treats a missing user ID header as signed out', async () => {
    const result = await call(createHandler([echo]), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-id': '' },
    })
    expect(result.body).toMatchObject({ data: { userId: null } })
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
      cause: 'TypeError: row.status is undefined',
    })
  })

  it('sends data: null when a route returns nothing', async () => {
    const handler = createHandler([route('DELETE', '/x/:id', async () => undefined)])
    const result = await call(handler, { method: 'DELETE', path: '/x/1' })
    expect(result.body).toEqual({ ok: true, data: null })
  })

  it('logs one line per request with the route pattern and no personal data', async () => {
    const result = await call(createHandler([echo]), {
      method: 'POST',
      path: '/transactions/t1/post',
      headers: { 'x-appwrite-user-id': 'u1' },
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
    expect(result.logs[0]).not.toMatch(/alice|Alice|t1|u1/)
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
