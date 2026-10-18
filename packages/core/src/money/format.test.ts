import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import { formatMoney, parseMoney } from './format'

describe('formatMoney', () => {
  it('formats cents in the currency', () => {
    expect(formatMoney(1234, 'AUD', 'en-AU')).toBe('$12.34')
    expect(formatMoney(5, 'AUD', 'en-AU')).toBe('$0.05')
    expect(formatMoney(0, 'AUD', 'en-AU')).toBe('$0.00')
    expect(formatMoney(-2000, 'AUD', 'en-AU')).toBe('-$20.00')
  })

  it('keeps every cent of large amounts', () => {
    expect(formatMoney(MAX_AMOUNT_CENTS - 1, 'AUD', 'en-AU')).toBe('$99,999,999.99')
  })

  it('uses the currency’s own number of decimals', () => {
    // ICU puts a no-break space after the code; compare with plain spaces.
    expect(formatMoney(1234, 'JPY', 'en-AU').replace(/\s/g, ' ')).toBe('JPY 1,234')
  })
})

describe('parseMoney', () => {
  it.each([
    ['12.34', 1234],
    ['12.3', 1230],
    ['12', 1200],
    ['0.05', 5],
    [' 7.50 ', 750],
    ['-5', -500],
    ['-0.01', -1],
    ['100000000.00', MAX_AMOUNT_CENTS],
  ])('parses %j as %i cents', (text, cents) => {
    expect(parseMoney(text)).toBe(cents)
  })

  it.each(['', 'abc', '12.345', '1,234.00', '.5', '12.', '$12', '1e3', '100000000.01'])(
    'rejects %j',
    (text) => {
      expect(() => parseMoney(text)).toThrow(RangeError)
    },
  )
})
