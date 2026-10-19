import { assertAmountCents } from './amount'

// "Cents" means the currency's smallest unit (glossary.md): 2 decimals for
// AUD, 0 for JPY, 3 for KWD. Intl knows each currency's decimals.
function currencyFormat(currency: string, locale?: string) {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency })
  // Always set for style 'currency'.
  const digits = format.resolvedOptions().maximumFractionDigits as number
  return { format, digits }
}

function decimal(cents: number, digits: number): string {
  const sign = cents < 0 ? '-' : ''
  const units = String(Math.abs(cents)).padStart(digits + 1, '0')
  const whole = units.slice(0, units.length - digits)
  const fraction = digits > 0 ? `.${units.slice(units.length - digits)}` : ''
  return `${sign}${whole}${fraction}`
}

/**
 * Formats cents for display, e.g. `formatMoney(1234, 'AUD', 'en-AU')` → `$12.34`.
 * The amount goes to Intl as an exact decimal string, never a float.
 */
export function formatMoney(cents: number, currency: string, locale?: string): string {
  assertAmountCents(cents)
  return formatNet(cents, currency, locale)
}

/**
 * `formatMoney` for a figure worked out from amounts, such as a net, a balance or a total, which
 * can pass the amount cap (ledger.md#allocation-and-rounding): it only has to be an exact integer.
 */
export function formatNet(cents: number, currency: string, locale?: string): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('A net must be a whole number of cents')
  const { format, digits } = currencyFormat(currency, locale)
  return format.format(decimal(cents, digits) as Intl.StringNumericLiteral)
}

/**
 * Cents as a plain decimal with the currency's digits, for exports (#50):
 * `centsToDecimal(-1230, 'AUD')` → `-12.30`, `(5, 'AUD')` → `0.05`, `(1234, 'JPY')` → `1234`.
 * Built from the integer's digits, never through a float.
 */
export function centsToDecimal(cents: number, currency: string): string {
  assertAmountCents(cents)
  return decimal(cents, digitsOf(currency))
}

/**
 * `centsToDecimal` for a figure worked out from amounts, such as a net, which can pass the amount
 * cap: it only has to be an exact integer.
 */
export function netToDecimal(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('A net must be a whole number of cents')
  return decimal(cents, digitsOf(currency))
}

// An export makes thousands of amounts; a NumberFormat for each is slow.
const DIGITS = new Map<string, number>()

function digitsOf(currency: string): number {
  let digits = DIGITS.get(currency)
  if (digits === undefined) {
    digits = currencyFormat(currency).digits
    DIGITS.set(currency, digits)
  }
  return digits
}

const MONEY_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * Parses a typed amount into cents of `currency`: `parseMoney('12.34', 'AUD')` → `1234`,
 * `parseMoney('1234', 'JPY')` → `1234`. Throws on anything else, including more
 * decimals than the currency has and thousands separators. The message never
 * repeats the input, so it is safe to log.
 */
export function parseMoney(text: string, currency: string): number {
  const { digits } = currencyFormat(currency)
  const match = MONEY_TEXT.exec(text.trim())
  const [, sign, whole, fraction = ''] = match ?? []
  if (!match || fraction.length > digits) {
    throw new RangeError(`Not an amount of ${currency} (up to ${digits} decimals)`)
  }
  // Exact while the result is within MAX_AMOUNT_CENTS; anything bigger throws below.
  const cents = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0'))
  assertAmountCents(cents)
  return sign === '-' ? 0 - cents : cents
}
