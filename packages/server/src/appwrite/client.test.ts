import { Account, type Models, TablesDB } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callerFromJwt, clientFromRequest, dbFromRequest } from './client'

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

describe('callerFromJwt', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('asks Appwrite who the JWT belongs to, with the function endpoint and project', async () => {
    vi.stubEnv('APPWRITE_FUNCTION_API_ENDPOINT', 'https://syd.cloud.appwrite.io/v1')
    vi.stubEnv('APPWRITE_FUNCTION_PROJECT_ID', 'ledgerly-dev')
    let config: Record<string, unknown> = {}
    vi.spyOn(Account.prototype, 'get').mockImplementation(function (this: Account) {
      config = this.client.config
      return Promise.resolve({ $id: 'u1' } as Models.User<Models.Preferences>)
    })
    await expect(callerFromJwt('the-jwt')).resolves.toBe('u1')
    expect(config).toMatchObject({
      endpoint: 'https://syd.cloud.appwrite.io/v1',
      project: 'ledgerly-dev',
      jwt: 'the-jwt',
    })
    expect(config.key).toBeFalsy()
  })
})
