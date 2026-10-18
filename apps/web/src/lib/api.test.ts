import { AppwriteException, ExecutionMethod } from 'appwrite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, parseEnvelope } from './api'
import { functions } from './appwrite'

vi.mock('./appwrite', () => ({ functions: { createExecution: vi.fn() } }))

const createExecution = vi.mocked(functions.createExecution)

function respond(body: unknown) {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body)
  createExecution.mockResolvedValueOnce({ responseBody } as never)
}

describe('parseEnvelope', () => {
  it('returns Ok with the data', () => {
    expect(parseEnvelope({ responseBody: '{"ok":true,"data":{"id":"t1"}}' })).toEqual({
      ok: true,
      data: { id: 't1' },
    })
  })

  it('keeps null data', () => {
    expect(parseEnvelope({ responseBody: '{"ok":true,"data":null}' })).toEqual({
      ok: true,
      data: null,
    })
  })

  it('returns Err with code, message and details', () => {
    const body = {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Bad input', details: [{ path: ['date'] }] },
    }
    expect(parseEnvelope({ responseBody: JSON.stringify(body) })).toEqual(body)
  })

  it('leaves details out when the server sent none', () => {
    const result = parseEnvelope({
      responseBody: '{"ok":false,"error":{"code":"LOCKED","message":"Locked"}}',
    })
    expect(result).toEqual({ ok: false, error: { code: 'LOCKED', message: 'Locked' } })
  })

  it.each([
    ['empty body', ''],
    ['not JSON', '<html>502</html>'],
    ['not an object', '"hello"'],
    ['ok true without data', '{"ok":true}'],
    ['unknown error code', '{"ok":false,"error":{"code":"NOPE","message":"x"}}'],
    ['message missing', '{"ok":false,"error":{"code":"LOCKED"}}'],
    ['error not an object', '{"ok":false,"error":"LOCKED"}'],
  ])('returns INTERNAL for %s', (_, responseBody) => {
    const result = parseEnvelope({ responseBody })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('INTERNAL')
  })
})

describe('callFunction', () => {
  beforeEach(() => createExecution.mockReset())

  it('runs a synchronous execution with the JSON payload, path and method', async () => {
    respond({ ok: true, data: { id: 't1' } })
    const result = await callFunction('ledger', 'POST', '/transactions', { id: 't1' })
    expect(result).toEqual({ ok: true, data: { id: 't1' } })
    expect(createExecution).toHaveBeenCalledWith({
      functionId: 'ledger',
      body: '{"id":"t1"}',
      async: false,
      xpath: '/transactions',
      method: ExecutionMethod.POST,
    })
  })

  it('sends an empty body when there is no payload', async () => {
    respond({ ok: true, data: [] })
    await callFunction('groups', 'GET', '/groups')
    expect(createExecution).toHaveBeenCalledWith(expect.objectContaining({ body: '' }))
  })

  it('passes the function error through', async () => {
    respond({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a member' } })
    const result = await callFunction('ledger', 'POST', '/transactions', {})
    expect(result).toEqual({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a member' } })
  })

  it('maps an Appwrite 401 to UNAUTHENTICATED', async () => {
    createExecution.mockRejectedValueOnce(new AppwriteException('No session', 401))
    const result = await callFunction('ledger', 'POST', '/transactions', {})
    expect(!result.ok && result.error.code).toBe('UNAUTHENTICATED')
  })

  it('maps any other failure to INTERNAL instead of throwing', async () => {
    createExecution.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const result = await callFunction('ledger', 'POST', '/transactions', {})
    expect(!result.ok && result.error.code).toBe('INTERNAL')
  })
})
