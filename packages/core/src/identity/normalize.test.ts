import { describe, expect, it } from 'vitest'
import { identityKey, normalizeEmail, normalizePhone } from './normalize'

describe('normalizeEmail', () => {
  it('trims and lowercases, keeping dots and +tags', () => {
    expect(normalizeEmail(' Sam@Example.com ')).toBe('sam@example.com')
    expect(normalizeEmail('Sam.Lee+bills@Example.COM')).toBe('sam.lee+bills@example.com')
  })

  it.each(['', 'sam', 'sam@', '@example.com', 'sam @example.com'])('rejects %j', (raw) => {
    expect(() => normalizeEmail(raw)).toThrow(new RangeError('Not an email address'))
  })
})

describe('normalizePhone', () => {
  it('formats a national number in the default country as E.164', () => {
    expect(normalizePhone('0412 345 678', 'AU')).toBe('+61412345678')
    expect(normalizePhone('(02) 9999 0000', 'AU')).toBe('+61299990000')
  })

  it('accepts a holiday region as the default country', () => {
    expect(normalizePhone('0412 345 678', 'AU-NSW')).toBe('+61412345678')
  })

  it('keeps the country of an international number, whatever the default', () => {
    expect(normalizePhone('+61 412 345 678', 'AU')).toBe('+61412345678')
    expect(normalizePhone('+61 412 345 678', 'NZ')).toBe('+61412345678')
    expect(normalizePhone('+61412345678')).toBe('+61412345678')
    expect(normalizePhone('+1 202 555 0143', 'AU')).toBe('+12025550143')
  })

  it.each([
    ['too short', '0412', 'AU'],
    ['too long', '0412 345 678 999', 'AU'],
    ['not a number', 'call me', 'AU'],
    ['empty', '', 'AU'],
    ['national without a default country', '0412 345 678', undefined],
    ['an unknown default country', '0412 345 678', 'XX'],
    ['the wrong length for the default country', '0412 345 678', 'NZ'],
    ['an extension', '0412 345 678 ext 5', 'AU'],
  ])('rejects %s', (_, raw, country) => {
    expect(() => normalizePhone(raw, country)).toThrow(new RangeError('Not a valid phone number'))
  })
})

describe('identityKey', () => {
  it('prefixes the type, so one value always gives one key', () => {
    expect(identityKey('email', 'sam@example.com')).toBe('email:sam@example.com')
    expect(identityKey('phone', '+61412345678')).toBe('phone:+61412345678')
  })

  it('gives the same key for any spelling of the same email', () => {
    expect(identityKey('email', ' Sam@Example.com ')).toBe(identityKey('email', 'sam@example.com'))
  })

  it('rejects values that are not an email or an E.164 number', () => {
    expect(() => identityKey('email', 'sam')).toThrow(RangeError)
    expect(() => identityKey('phone', '0412 345 678')).toThrow(RangeError)
  })
})
