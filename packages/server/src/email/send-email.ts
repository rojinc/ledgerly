const RESEND_URL = 'https://api.resend.com/emails'
// Well inside the 15 s timeout of the HTTP functions, so a stuck request fails as an error.
const TIMEOUT_MS = 10_000
// Resend's error names are fixed identifiers such as `validation_error`. Anything else is
// replaced, so an error can never carry text from the response.
const ERROR_NAME = /^[a-z_]{1,64}$/

export type Attachment = { filename: string; content: Uint8Array }

export type Email = {
  to: string | string[]
  subject: string
  html: string
  text: string
  replyTo?: string
  attachments?: Attachment[]
  /** One per email: Resend sends one email per key within 24 hours, so a retry isn't delivered twice. */
  idempotencyKey?: string
}

/**
 * Every way a send fails. `type` is `missing_config`, `timeout`, `network` or Resend's error
 * name; `status` is Resend's HTTP status, when it answered, and `retryAfterMs` its `retry-after`
 * header, when it sent one (a 429). The message never holds addresses, subjects or bodies, so it
 * is safe to log.
 */
export class EmailError extends Error {
  override name = 'EmailError'

  constructor(
    message: string,
    readonly type: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/**
 * Whether Resend refused this email for good (#469): a `validation_error` with 400 or 422 is
 * about the request itself, such as a bad address, so no retry of it would send. With 401 or 403
 * the same type is a fault in our key or sending domain, which every send meets until it's fixed,
 * so a later run should try again.
 */
export function refusedForGood(error: unknown): boolean {
  return (
    error instanceof EmailError &&
    error.type === 'validation_error' &&
    (error.status === 400 || error.status === 422)
  )
}

/**
 * Sends one email through Resend's HTTP API (D-011), from `EMAIL_FROM`. Logs nothing.
 * Returns Resend's email ID, which is safe to log. `timeoutMs` shortens the 10 s timeout, for a
 * run with less time left; it never lengthens it.
 */
export async function sendEmail(
  email: Email,
  { timeoutMs = TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ id?: string }> {
  const apiKey = requireEnv('RESEND_API_KEY')
  const from = requireEnv('EMAIL_FROM')
  const request: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(email.idempotencyKey ? { 'idempotency-key': email.idempotencyKey } : {}),
    },
    // JSON.stringify leaves out the optional fields that are undefined.
    body: JSON.stringify({
      from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      reply_to: email.replyTo,
      attachments: email.attachments?.map(({ filename, content }) => ({
        filename,
        content: Buffer.from(content).toString('base64'),
      })),
    }),
    // A whole number of ms, never below 0: AbortSignal.timeout throws a RangeError otherwise.
    signal: AbortSignal.timeout(Math.max(0, Math.floor(Math.min(timeoutMs, TIMEOUT_MS)))),
  }
  let response: Response
  try {
    response = await fetch(RESEND_URL, request)
  } catch (thrown) {
    // The timeout rejects with a TimeoutError; DNS, TLS and dropped connections with others.
    // Either way the email may still have gone out, so a retry needs the same idempotencyKey.
    const type = thrown instanceof Error && thrown.name === 'TimeoutError' ? 'timeout' : 'network'
    throw new EmailError(`Resend could not be reached: ${type}`, type)
  }
  const body = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown } | null
  if (!response.ok) {
    const type =
      typeof body?.name === 'string' && ERROR_NAME.test(body.name) ? body.name : 'unknown'
    // Whole seconds, as Resend sends it; anything else is left out.
    const retryAfter = response.headers.get('retry-after')?.trim() ?? ''
    throw new EmailError(
      `Resend answered ${response.status} ${type}`,
      type,
      response.status,
      /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined,
    )
  }
  return { id: typeof body?.id === 'string' ? body.id : undefined }
}

function requireEnv(name: 'RESEND_API_KEY' | 'EMAIL_FROM'): string {
  const value = process.env[name]
  if (!value?.trim()) {
    throw new EmailError(
      `${name} is not set. Add it as an Appwrite project variable (environments-and-deploys.md).`,
      'missing_config',
    )
  }
  return value.trim()
}
