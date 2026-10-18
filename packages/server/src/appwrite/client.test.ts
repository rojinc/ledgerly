import { TablesDB } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientFromRequest, dbFromRequest } from './client'

describe('clientFromRequest', () => {
  afterEach(() => vi.unstubAllEnvs())

  function stubFunctionEnv() {
    vi.stubEnv('APPWRITE_FUNCTION_API_ENDPOINT', 'https://syd.cloud.appwrite.io/v1')
    vi.stubEnv('APPWRITE_FUNCTION_PROJECT_ID', 'ledgerly-dev')
  }

  it('uses the function endpoint, the project and the per-execution key', () => {
    stubFunctionEnv()
    const client = clientFromRequest({ 'x-appwrite-key': 'execution-key' })
    expect(client.config.endpoint).toBe('https://syd.cloud.appwrite.io/v1')
    expect(client.config.project).toBe('ledgerly-dev')
    expect(client.config.key).toBe('execution-key')
  })

  it('fails without the x-appwrite-key header', () => {
    stubFunctionEnv()
    expect(() => clientFromRequest({})).toThrow('x-appwrite-key')
  })

  it('fails outside the Appwrite runtime', () => {
    vi.stubEnv('APPWRITE_FUNCTION_API_ENDPOINT', '')
    vi.stubEnv('APPWRITE_FUNCTION_PROJECT_ID', '')
    expect(() => clientFromRequest({ 'x-appwrite-key': 'k' })).toThrow('must be set')
  })

  it('gives TablesDB to dbFromRequest', () => {
    stubFunctionEnv()
    expect(dbFromRequest({ 'x-appwrite-key': 'k' })).toBeInstanceOf(TablesDB)
  })
})
