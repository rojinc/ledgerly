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
  /** Resend sends one email per key within 24 hours, so a retried send isn't delivered twice. */
  idempotencyKey?: string
}

/**
 * A send that failed. `type` is `missing_config` or Resend's error name, `status` its HTTP
 * status. The message never holds addresses, subjects or bodies, so it is safe to log.
 */
export class EmailError extends Error {
  override name = 'EmailError'

  constructor(
    message: string,
    readonly type: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * Sends one email through Resend's HTTP API (D-011), from `EMAIL_FROM`. Logs nothing.
 * Returns Resend's email ID, which is safe to log.
 */
export async function sendEmail(email: Email): Promise<{ id?: string }> {
  const apiKey = requireEnv('RESEND_API_KEY')
  const from = requireEnv('EMAIL_FROM')
  const response = await fetch(RESEND_URL, {
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown } | null
  if (!response.ok) {
    const type =
      typeof body?.name === 'string' && ERROR_NAME.test(body.name) ? body.name : 'unknown'
    throw new EmailError(`Resend answered ${response.status} ${type}`, type, response.status)
  }
  return { id: typeof body?.id === 'string' ? body.id : undefined }
}

function requireEnv(name: 'RESEND_API_KEY' | 'EMAIL_FROM'): string {
  const value = process.env[name]
  if (!value) {
    throw new EmailError(
      `${name} is not set. Add it as an Appwrite project variable (environments-and-deploys.md).`,
      'missing_config',
    )
  }
  return value
}
