// Well inside the 15 s timeout of the HTTP functions, so a stuck request fails as an error.
const TIMEOUT_MS = 10_000
// Provider error codes that are fixed identifiers. Anything else is replaced, so an error can
// never carry text from the response.
const ERROR_CODE = /^[a-z0-9_]{1,64}$/

export type Sms = {
  /** E.164, as `normalizePhone()` returns it: `+61412345678`. */
  to: string
  text: string
  /** One per message, so a retry isn't sent twice where the provider supports it. */
  idempotencyKey?: string
}

/**
 * Every way a send fails. `type` is `missing_config`, `timeout`, `network`, the provider's error
 * code, or `http_error` when the provider answered with an error and no usable code; `status` is
 * the provider's HTTP status, when it answered. The message never holds the number or the text,
 * so it is safe to log.
 */
export class SmsError extends Error {
  override name = 'SmsError'

  constructor(
    message: string,
    readonly type: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** The project variables `sendSms` reads (environments-and-deploys.md). */
type SmsConfig = { apiKey: string; from: string }

/**
 * The provider's HTTP request for one SMS, and where its error responses keep their error code.
 * `sendSms` adds the timeout.
 */
type ProviderRequest = {
  url: string
  init: RequestInit
  errorCode: (body: unknown) => unknown
}

/** Sends one SMS through the provider's HTTP API (D-017), from `SMS_FROM`. Logs nothing. */
export function sendSms(sms: Sms): Promise<void> {
  return sendSmsWith(providerRequest, sms)
}

/**
 * `sendSms` with the provider's part passed in: config first, so a missing variable sends
 * nothing, then the request with a 10 s timeout, and every failure as an `SmsError`. Exported
 * for tests; everything else calls `sendSms`.
 */
export async function sendSmsWith(
  request: (config: SmsConfig, sms: Sms) => ProviderRequest,
  sms: Sms,
): Promise<void> {
  const config = { apiKey: requireEnv('SMS_API_KEY'), from: requireEnv('SMS_FROM') }
  const { url, init, errorCode } = request(config, sms)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (thrown) {
    // The timeout rejects with a TimeoutError; DNS, TLS and dropped connections with others.
    // Either way the SMS may still have gone out, so a retry needs the same idempotencyKey.
    const type = thrown instanceof Error && thrown.name === 'TimeoutError' ? 'timeout' : 'network'
    throw new SmsError(`The SMS provider could not be reached: ${type}`, type)
  }
  if (response.ok) return
  const code = errorCode(await response.json().catch(() => null))
  const type = typeof code === 'string' && ERROR_CODE.test(code) ? code : 'http_error'
  throw new SmsError(`The SMS provider answered ${response.status} ${type}`, type, response.status)
}

function providerRequest(_config: SmsConfig, _sms: Sms): ProviderRequest {
  // The provider's request, once #175 picks it (D-017).
  throw new SmsError('No SMS provider is set up yet (#175).', 'missing_config')
}

function requireEnv(name: 'SMS_API_KEY' | 'SMS_FROM'): string {
  const value = process.env[name]
  if (!value?.trim()) {
    throw new SmsError(
      `${name} is not set. Add it as an Appwrite project variable (environments-and-deploys.md).`,
      'missing_config',
    )
  }
  return value.trim()
}
