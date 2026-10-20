import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { MAX_AMOUNT_CENTS } from '../constants/limits'
import {
  categorySchema,
  centsSchema,
  currencySchema,
  descriptionSchema,
  displayNameSchema,
  emailSchema,
  emptyBodySchema,
  idSchema,
  localDateSchema,
  oneLine,
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

describe('oneLine', () => {
  it.each([
    ['a line feed', 'Rent\nOctober'],
    ['a carriage return', 'Rent\rOctober'],
    ['CR LF', 'Rent\r\nOctober'],
    ['a tab', 'Rent\tOctober'],
    ['a vertical tab and a form feed', 'Rent\v\fOctober'],
    ['a next line', 'Rent\u0085October'],
    ['the line and paragraph separators', 'Rent\u2028\u2029October'],
    ['no-break spaces', 'Rent\u00a0\u202fOctober'],
    ['a run of spaces', 'Rent   October'],
  ])('folds %s into one space', (_, text) => expect(oneLine(text)).toBe('Rent October'))

  it.each([
    ['NUL', '\u0000'],
    ['DEL', '\u007f'],
    ['the last C1 control', '\u009f'],
    ['the Arabic letter mark', '\u061c'],
    ['the left-to-right and right-to-left marks', '\u200e\u200f'],
    ['embeddings and overrides', '\u202a\u202b\u202c\u202d\u202e'],
    ['isolates', '\u2066\u2067\u2068\u2069'],
  ])('removes %s', (_, hidden) => expect(oneLine(`Gas${hidden}Bill`)).toBe('GasBill'))

  it('removes a control between spaces without leaving two', () => {
    expect(oneLine('Gas \u0000 bill')).toBe('Gas bill')
  })

  it('keeps an emoji sequence whole, and trims', () => {
    expect(oneLine(' \u202e\n👩\u200d💻 Laptop\t')).toBe('👩\u200d💻 Laptop')
  })

  it('leaves its own result as it is', () => {
    const once = oneLine(' a\u0000\n\u202e b\u00a0\tc ')
    expect(oneLine(once)).toBe(once)
  })
})

describe('descriptionSchema and displayNameSchema', () => {
  it('fold a description to one line before checking its length', () => {
    const folded = descriptionSchema.parse(`${'x\n'.repeat(99)}x`)
    expect(folded).toHaveLength(199)
    expect(folded).not.toContain('\n')
    expect(accepts(descriptionSchema, ' \u202e\u0000\n\t')).toBe(false)
    expect(accepts(descriptionSchema, `${'x'.repeat(200)}\u202e`)).toBe(true)
  })

  it('fit their columns', () => {
    expect(accepts(descriptionSchema, 'x'.repeat(200))).toBe(true)
    expect(accepts(descriptionSchema, 'x'.repeat(201))).toBe(false)
    expect(accepts(displayNameSchema, 'x'.repeat(100))).toBe(true)
    expect(accepts(displayNameSchema, 'x'.repeat(101))).toBe(false)
    expect(accepts(displayNameSchema, ' ')).toBe(false)
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

  it.each(['Mars/Base', '', 'Australia/Sydney ', '+10:00', 'australia/sydney', 'Australia/sydney'])(
    'rejects %j',
    (timeZone) => expect(accepts(timezoneSchema, timeZone)).toBe(false),
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
