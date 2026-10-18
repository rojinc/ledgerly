import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import {
  categorySchema,
  centsSchema,
  currencySchema,
  emailSchema,
  emptyBodySchema,
  idSchema,
  localDateSchema,
  peopleList,
  phoneSchema,
  rateCentsSchema,
  regionSchema,
  text,
  timezoneSchema,
} from './common'

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success

describe('idSchema', () => {
  it.each(['a', '66f1c2a0b3d4e5f60718', '66f1c2a0b3d4e5f60718_20261029', 'x'.repeat(36)])(
    'accepts %j',
    (id) => expect(accepts(idSchema, id)).toBe(true),
  )

  it.each(['', '_abc', '.abc', 'a b', 'a/b', 'x'.repeat(37)])('rejects %j', (id) =>
    expect(accepts(idSchema, id)).toBe(false),
  )
})

describe('localDateSchema', () => {
  it.each(['2026-10-29', '2028-02-29', '2026-12-31', '0050-01-01'])('accepts %s', (date) =>
    expect(accepts(localDateSchema, date)).toBe(true),
  )

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-1-1',
    '2026-10-29T00:00',
    ' 2026-10-29',
    '',
  ])('rejects %j', (date) => expect(accepts(localDateSchema, date)).toBe(false))
})

describe('categorySchema', () => {
  it('accepts the categories in constants', () => {
    expect(accepts(categorySchema, 'groceries')).toBe(true)
    expect(accepts(categorySchema, 'Groceries')).toBe(false)
    expect(accepts(categorySchema, 'pets')).toBe(false)
  })
})

describe('centsSchema', () => {
  it.each([0, 1234, -1234, MAX_AMOUNT_CENTS, -MAX_AMOUNT_CENTS])('accepts %d', (cents) =>
    expect(accepts(centsSchema, cents)).toBe(true),
  )

  it.each([MAX_AMOUNT_CENTS + 1, -MAX_AMOUNT_CENTS - 1, 12.5, Number.NaN, '1234'])(
    'rejects %j',
    (cents) => expect(accepts(centsSchema, cents)).toBe(false),
  )
})

describe('rateCentsSchema', () => {
  it('accepts zero and up, never negative', () => {
    expect(accepts(rateCentsSchema, 0)).toBe(true)
    expect(accepts(rateCentsSchema, 2500)).toBe(true)
    expect(accepts(rateCentsSchema, -1)).toBe(false)
  })
})

describe('text', () => {
  it('trims, then checks the length', () => {
    expect(text(1, 3).parse('  abc  ')).toBe('abc')
    expect(accepts(text(1, 3), '   ')).toBe(false)
    expect(accepts(text(1, 3), 'abcd')).toBe(false)
  })
})

describe('emailSchema', () => {
  it('accepts an email and trims it, keeping its case', () => {
    expect(emailSchema.parse(' Sam@Example.com ')).toBe('Sam@Example.com')
  })

  it.each(['sam', 'sam@', '@example.com', `${'a'.repeat(250)}@example.com`])(
    'rejects %j',
    (email) => expect(accepts(emailSchema, email)).toBe(false),
  )
})

describe('phoneSchema', () => {
  it.each(['0412 345 678', '+61 (412) 345-678', '0412.345.678'])('accepts %j', (phone) =>
    expect(accepts(phoneSchema, phone)).toBe(true),
  )

  it.each(['', 'call me', '0412+345', '1'.repeat(33)])('rejects %j', (phone) =>
    expect(accepts(phoneSchema, phone)).toBe(false),
  )
})

describe('timezoneSchema', () => {
  it.each(['Australia/Sydney', 'UTC', 'America/Los_Angeles'])('accepts %s', (timeZone) =>
    expect(accepts(timezoneSchema, timeZone)).toBe(true),
  )

  it.each(['Mars/Base', '', 'Australia/Sydney '])('rejects %j', (timeZone) =>
    expect(accepts(timezoneSchema, timeZone)).toBe(false),
  )
})

describe('regionSchema', () => {
  it.each(['AU-NSW', 'AU-VIC', 'NZ', 'GB-ENG'])('accepts %s', (region) =>
    expect(accepts(regionSchema, region)).toBe(true),
  )

  it.each(['au-nsw', 'AUS', 'AU-', 'AU-ABCD'])('rejects %s', (region) =>
    expect(accepts(regionSchema, region)).toBe(false),
  )
})

describe('currencySchema', () => {
  it('accepts three capital letters', () => {
    expect(accepts(currencySchema, 'AUD')).toBe(true)
    expect(accepts(currencySchema, 'aud')).toBe(false)
    expect(accepts(currencySchema, 'AU')).toBe(false)
  })
})

describe('emptyBodySchema', () => {
  it('accepts only an empty object', () => {
    expect(accepts(emptyBodySchema, {})).toBe(true)
    expect(accepts(emptyBodySchema, { groupId: 'g1' })).toBe(false)
  })
})

describe('peopleList', () => {
  const people = peopleList(idSchema, (id) => id)
  const named = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`)

  it('accepts 1 to 15 different people', () => {
    expect(accepts(people, named(1))).toBe(true)
    expect(accepts(people, named(15))).toBe(true)
  })

  it('rejects an empty list, more than 15 people and the same person twice', () => {
    expect(accepts(people, [])).toBe(false)
    expect(accepts(people, named(16))).toBe(false)
    expect(() => people.parse(['alice', 'bob', 'alice'])).toThrow(
      'Each person can appear only once',
    )
  })
})
