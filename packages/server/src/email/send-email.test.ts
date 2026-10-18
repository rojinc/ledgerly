import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { type Email, EmailError, sendEmail } from './send-email'

const email: Email = {
  to: 'boss@acme.example',
  subject: 'Invoice INV-0010 from Sam Lee',
  html: '<p>Secret body</p>',
  text: 'Secret body',
}

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const
let fetchMock: Mock<typeof fetch>

function answer(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  fetchMock.mockResolvedValue(new Response(text, { status }))
}

function sent(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) }
}

async function failure(promise: Promise<unknown>): Promise<EmailError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(EmailError)
  return thrown as EmailError
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test_key')
  vi.stubEnv('EMAIL_FROM', 'Ledgerly <hello@ledgerly.example>')
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  answer(200, { id: 'email-1' })
  // Nothing about an email may reach the logs, so sendEmail logs nothing at all.
  for (const method of CONSOLE) vi.spyOn(console, method)
})

afterEach(() => {
  const logged = CONSOLE.filter((method) => vi.mocked(console[method]).mock.calls.length > 0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  expect(logged).toEqual([])
})

describe('sendEmail', () => {
  it('posts the email to Resend with the API key and EMAIL_FROM', async () => {
    await expect(sendEmail(email)).resolves.toEqual({ id: 'email-1' })
    const { url, init, body } = sent()
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: 'Bearer re_test_key',
      'content-type': 'application/json',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // No reply_to or attachments keys when they aren't given.
    expect(body).toEqual({
      from: 'Ledgerly <hello@ledgerly.example>',
      to: 'boss@acme.example',
      subject: 'Invoice INV-0010 from Sam Lee',
      html: '<p>Secret body</p>',
      text: 'Secret body',
    })
  })

  it('sends several recipients, the reply-to, base64 attachments and the idempotency key', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 invoice')
    await sendEmail({
      ...email,
      to: ['boss@acme.example', 'accounts@acme.example'],
      replyTo: 'sam@example.com',
      attachments: [{ filename: 'INV-0010.pdf', content: pdf }],
      idempotencyKey: 'finalize/stmt-1/employer',
    })
    const { init, body } = sent()
    expect(init.headers).toMatchObject({ 'idempotency-key': 'finalize/stmt-1/employer' })
    expect(body.to).toEqual(['boss@acme.example', 'accounts@acme.example'])
    expect(body.reply_to).toBe('sam@example.com')
    expect(body.attachments).toEqual([
      { filename: 'INV-0010.pdf', content: Buffer.from(pdf).toString('base64') },
    ])
    const [attachment] = body.attachments as { content: string }[]
    expect(Buffer.from(attachment?.content as string, 'base64').toString()).toBe('%PDF-1.7 invoice')
  })

  it.each([
    ['RESEND_API_KEY', ''],
    ['EMAIL_FROM', ''],
    ['RESEND_API_KEY', '  '],
    ['EMAIL_FROM', '\n'],
  ])('fails clearly when %s is %j and sends nothing', async (name, value) => {
    vi.stubEnv(name, value)
    const error = await failure(sendEmail(email))
    expect(error.type).toBe('missing_config')
    expect(error.status).toBeUndefined()
    expect(error.message).toBe(
      `${name} is not set. Add it as an Appwrite project variable (environments-and-deploys.md).`,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the settings without stray spaces or newlines', async () => {
    vi.stubEnv('RESEND_API_KEY', ' re_test_key\n')
    vi.stubEnv('EMAIL_FROM', ' Ledgerly <hello@ledgerly.example>\n')
    await sendEmail(email)
    const { init, body } = sent()
    expect(init.headers).toMatchObject({ authorization: 'Bearer re_test_key' })
    expect(body.from).toBe('Ledgerly <hello@ledgerly.example>')
  })

  it("keeps Resend's error name and status but never its message", async () => {
    answer(422, {
      statusCode: 422,
      name: 'validation_error',
      message: 'Invalid `to` field: boss@acme.example',
    })
    const error = await failure(sendEmail(email))
    expect(error).toMatchObject({ name: 'EmailError', status: 422, type: 'validation_error' })
    expect(error.message).toBe('Resend answered 422 validation_error')
  })

  it.each([
    ['a body that is not JSON', 502, '<html>Bad gateway</html>'],
    ['an error name that is not an identifier', 400, { name: 'bad boss@acme.example' }],
    ['no error name', 500, { message: 'oops' }],
  ])('reports %s as unknown', async (_case, status, body) => {
    answer(status, body)
    const error = await failure(sendEmail(email))
    expect(error).toMatchObject({ status, type: 'unknown' })
    expect(error.message).toBe(`Resend answered ${status} unknown`)
  })

  it('never puts the address, subject or body in an error', async () => {
    answer(429, { name: 'rate_limit_exceeded', message: `Too many emails to ${email.to}` })
    const error = await failure(sendEmail(email))
    const shown = `${error.message} ${error.type} ${error.stack}`
    for (const secret of ['boss@acme.example', 'Sam Lee', 'Secret body']) {
      expect(shown).not.toContain(secret)
    }
  })

  it('succeeds without an ID when Resend sends a 2xx without one', async () => {
    answer(200, 'accepted')
    await expect(sendEmail(email)).resolves.toEqual({ id: undefined })
  })

  it.each([
    ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['network', new TypeError('fetch failed')],
    ['network', new Error('getaddrinfo ENOTFOUND api.resend.com')],
  ])('reports a send that never got an answer as %s', async (type, thrown) => {
    fetchMock.mockRejectedValue(thrown)
    const error = await failure(sendEmail(email))
    expect(error).toMatchObject({ type, status: undefined })
    expect(error.message).toBe(`Resend could not be reached: ${type}`)
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
    const error = await failure(sendEmail(email))
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(error.type).toBe('timeout')
  })
})
