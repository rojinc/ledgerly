import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { type Sms, SmsError, sendSms, sendSmsWith } from './send-sms'

const sms: Sms = {
  to: '+61412345678',
  text: 'Annie invited you to Flat 2 on Ledgerly: https://app.example.com/invite#secret-token',
  idempotencyKey: 'invite/inv-1',
}
const SECRETS = ['+61412345678', '0412', 'Annie', 'Flat 2', 'secret-token']

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const
let fetchMock: Mock<typeof fetch>

// Stands in for the provider's request until #175 picks one. It carries the number and the
// text, as a real one would, and reads the provider's error code from `code`.
const request = vi.fn((config: { apiKey: string; from: string }, message: Sms) => ({
  url: 'https://sms.example/messages',
  init: {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ from: config.from, ...message }),
  },
  errorCode: (body: unknown) => (body as { code?: unknown } | null)?.code,
}))

function answer(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  fetchMock.mockResolvedValue(new Response(text, { status }))
}

async function failure(promise: Promise<unknown>): Promise<SmsError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(SmsError)
  return thrown as SmsError
}

function shown(error: SmsError): string {
  return `${error.message} ${error.type} ${error.status} ${error.stack} ${JSON.stringify(error)}`
}

beforeEach(() => {
  vi.stubEnv('SMS_API_KEY', 'sms_test_key')
  vi.stubEnv('SMS_FROM', 'Ledgerly')
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  answer(200, { id: 'sms-1' })
  request.mockClear()
  // Nothing about an SMS may reach the logs, so sendSms logs nothing at all.
  for (const method of CONSOLE) vi.spyOn(console, method)
})

afterEach(() => {
  const logged = CONSOLE.filter((method) => vi.mocked(console[method]).mock.calls.length > 0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  expect(logged).toEqual([])
})

describe('sendSms', () => {
  it('sends nothing until #175 picks a provider, even with its settings', async () => {
    const error = await failure(sendSms(sms))
    expect(error).toMatchObject({ type: 'missing_config', status: undefined })
    expect(error.message).toBe('No SMS provider is set up yet (#175).')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['SMS_API_KEY', ''],
    ['SMS_FROM', ''],
    ['SMS_API_KEY', '  '],
    ['SMS_FROM', '\n'],
  ])('fails clearly when %s is %j, before the request is built', async (name, value) => {
    vi.stubEnv(name, value)
    for (const send of [sendSms(sms), sendSmsWith(request, sms)]) {
      const error = await failure(send)
      expect(error).toMatchObject({ type: 'missing_config', status: undefined })
      expect(error.message).toBe(
        `${name} is not set. Add it as an Appwrite project variable (environments-and-deploys.md).`,
      )
    }
    expect(request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendSmsWith', () => {
  it("sends the provider's request with the trimmed settings and a timeout", async () => {
    vi.stubEnv('SMS_API_KEY', ' sms_test_key\n')
    vi.stubEnv('SMS_FROM', ' Ledgerly\n')
    await expect(sendSmsWith(request, sms)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith({ apiKey: 'sms_test_key', from: 'Ledgerly' }, sms)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sms.example/messages')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer sms_test_key' },
      body: JSON.stringify({ from: 'Ledgerly', ...sms }),
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([200, 201, 202, 204])('succeeds on %i, whatever the body', async (status) => {
    fetchMock.mockResolvedValue(new Response(status === 204 ? null : 'queued', { status }))
    await expect(sendSmsWith(request, sms)).resolves.toBeUndefined()
  })

  it.each([
    ['invalid_number', 400],
    ['21211', 400],
    ['rate_limited', 429],
  ])("keeps the provider's error code %s and status %i", async (code, status) => {
    answer(status, { code, message: `The number ${sms.to} is not valid` })
    const error = await failure(sendSmsWith(request, sms))
    expect(error).toMatchObject({ name: 'SmsError', type: code, status })
    expect(error.message).toBe(`The SMS provider answered ${status} ${code}`)
  })

  it.each([
    ['a code that is not an identifier', 400, { code: 'Bad number +61412345678' }],
    ['an upper-case code', 400, { code: 'INVALID' }],
    ['a code over 64 characters', 400, { code: 'a'.repeat(65) }],
    ['a code that is a number', 400, { code: 21211 }],
    ['no code', 500, { message: 'oops' }],
    ['a body that is not JSON', 502, '<html>Bad gateway</html>'],
    ['an empty body', 503, ''],
  ])('reports %s as http_error, with the status', async (_case, status, body) => {
    answer(status, body)
    const error = await failure(sendSmsWith(request, sms))
    expect(error).toMatchObject({ type: 'http_error', status })
    expect(error.message).toBe(`The SMS provider answered ${status} http_error`)
  })

  it.each([
    ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['network', new TypeError('fetch failed')],
    ['network', new Error('getaddrinfo ENOTFOUND sms.example')],
  ])('reports a send that never got an answer as %s', async (type, thrown) => {
    fetchMock.mockRejectedValue(thrown)
    const error = await failure(sendSmsWith(request, sms))
    expect(error).toMatchObject({ type, status: undefined })
    expect(error.message).toBe(`The SMS provider could not be reached: ${type}`)
  })

  it('gives up on a request that hangs for 10 seconds', async () => {
    // Fake timers don't drive AbortSignal.timeout, so the 10 s signal is swapped for a 1 ms one.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(1))
    // Like fetch, reject when the request's signal aborts.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    )
    const error = await failure(sendSmsWith(request, sms))
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(error.type).toBe('timeout')
  })

  it('never puts the number or the text in an error', async () => {
    const failures = [
      () => answer(400, { code: 'invalid_number', message: `Bad number ${sms.to}: ${sms.text}` }),
      () => answer(400, { code: sms.to, message: sms.text }),
      () => fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${sms.to}: ${sms.text}`)),
    ]
    for (const fail of failures) {
      fail()
      const error = await failure(sendSmsWith(request, sms))
      for (const secret of SECRETS) expect(shown(error)).not.toContain(secret)
    }
    vi.stubEnv('SMS_FROM', '')
    const error = await failure(sendSmsWith(request, sms))
    for (const secret of SECRETS) expect(shown(error)).not.toContain(secret)
  })
})
