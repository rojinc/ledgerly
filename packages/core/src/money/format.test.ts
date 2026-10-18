import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import { formatMoney, parseMoney } from './format'

// ICU puts a no-break space between a currency code and the number.
const plain = (text: string) => text.replace(/\s/g, ' ')

describe('formatMoney', () => {
  it('formats cents in the currency', () => {
    expect(formatMoney(1234, 'AUD', 'en-AU')).toBe('$12.34')
    expect(formatMoney(5, 'AUD', 'en-AU')).toBe('$0.05')
    expect(formatMoney(0, 'AUD', 'en-AU')).toBe('$0.00')
    expect(formatMoney(-0, 'AUD', 'en-AU')).toBe('$0.00')
    expect(formatMoney(-2000, 'AUD', 'en-AU')).toBe('-$20.00')
  })

  it('keeps every cent of large amounts', () => {
    expect(formatMoney(MAX_AMOUNT_CENTS - 1, 'AUD', 'en-AU')).toBe('$99,999,999.99')
  })

  it('uses the currency’s own number of decimals', () => {
    expect(plain(formatMoney(1234, 'JPY', 'en-AU'))).toBe('JPY 1,234')
    expect(plain(formatMoney(1234, 'KWD', 'en-AU'))).toBe('KWD 1.234')
  })

  it.each([12.5, Number.NaN, MAX_AMOUNT_CENTS + 1])('rejects %d', (cents) => {
    expect(() => formatMoney(cents, 'AUD', 'en-AU')).toThrow(RangeError)
  })
})

describe('parseMoney', () => {
  it.each([
    ['12.34', 1234],
    ['12.3', 1230],
    ['12', 1200],
    ['0.05', 5],
    ['007', 700],
    [' 7.50 ', 750],
    ['-5', -500],
    ['-0.01', -1],
    ['100000000.00', MAX_AMOUNT_CENTS],
  ])('parses %j as %i AUD cents', (text, cents) => {
    expect(parseMoney(text, 'AUD')).toBe(cents)
  })

  it('never returns -0', () => {
    expect(Object.is(parseMoney('-0', 'AUD'), 0)).toBe(true)
  })

  it('uses the currency’s own number of decimals', () => {
    expect(parseMoney('1234', 'JPY')).toBe(1234)
    expect(() => parseMoney('12.5', 'JPY')).toThrow(RangeError)
    expect(parseMoney('1.234', 'KWD')).toBe(1234)
  })

  it('round-trips with formatMoney', () => {
    for (const [text, currency] of [
      ['12.34', 'AUD'],
      ['1234', 'JPY'],
      ['1.234', 'KWD'],
    ] as const) {
      const shown = formatMoney(parseMoney(text, currency), currency, 'en-AU')
      expect(shown.replace(/[^\d.]/g, '')).toBe(text)
    }
  })

  it.each(['', 'abc', '12.345', '1,234.00', '.5', '12.', '$12', '1e3', '+5', '100000000.01'])(
    'rejects %j',
    (text) => {
      expect(() => parseMoney(text, 'AUD')).toThrow(RangeError)
    },
  )

  it('does not repeat the input in its error message', () => {
    expect(() => parseMoney('secret note 12', 'AUD')).toThrow(/^Not an amount of AUD/)
    expect(() => parseMoney('secret note 12', 'AUD')).not.toThrow(/secret/)
  })
})
