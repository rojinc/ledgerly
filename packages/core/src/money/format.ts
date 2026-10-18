import { MAX_AMOUNT_CENTS } from '../constants/limits'

/**
 * Formats cents for display, e.g. `formatMoney(1234, 'AUD', 'en-AU')` → `$12.34`.
 * The amount goes to Intl as an exact decimal string, never a float.
 */
export function formatMoney(cents: number, currency: string, locale?: string): string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency })
  // Always set for style 'currency' (2 for AUD, 0 for JPY).
  const digits = format.resolvedOptions().maximumFractionDigits as number
  const sign = cents < 0 ? '-' : ''
  const units = String(Math.abs(cents)).padStart(digits + 1, '0')
  const whole = units.slice(0, units.length - digits)
  const fraction = digits > 0 ? `.${units.slice(units.length - digits)}` : ''
  return format.format(`${sign}${whole}${fraction}` as Intl.StringNumericLiteral)
}

const MONEY_TEXT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/

/**
 * Parses a typed amount into cents: `'12.34'` → `1234`, `'-5'` → `-500`.
 * Throws on anything else, including more than 2 decimals and thousands separators.
 */
export function parseMoney(text: string): number {
  const match = MONEY_TEXT.exec(text.trim())
  if (!match) throw new RangeError(`Not an amount of money: "${text}"`)
  const [, sign, whole, fraction = ''] = match
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (cents > MAX_AMOUNT_CENTS) throw new RangeError(`Amount is over the limit: "${text}"`)
  return sign === '-' ? 0 - cents : cents
}
