import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type Err, envelopeSchema, errorCodeSchema, errSchema, type Ok, okSchema } from './envelope'

describe('errorCodeSchema', () => {
  it('accepts the documented codes only', () => {
    expect(errorCodeSchema.parse('VALIDATION_FAILED')).toBe('VALIDATION_FAILED')
    expect(errorCodeSchema.safeParse('TEAPOT').success).toBe(false)
  })
})

describe('errSchema', () => {
  it('accepts an error with or without details', () => {
    const err: Err = {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Check the amount', details: [{ path: ['x'] }] },
    }
    expect(errSchema.parse(err)).toEqual(err)
    expect(
      errSchema.safeParse({ ok: false, error: { code: 'NOT_FOUND', message: '' } }).success,
    ).toBe(true)
  })

  it('rejects an unknown code or a missing message', () => {
    expect(errSchema.safeParse({ ok: false, error: { code: 'OOPS', message: 'x' } }).success).toBe(
      false,
    )
    expect(errSchema.safeParse({ ok: false, error: { code: 'INTERNAL' } }).success).toBe(false)
  })
})

describe('envelopeSchema', () => {
  const balances = envelopeSchema(z.strictObject({ netCents: z.int() }))

  it('accepts data of the given shape or an error', () => {
    const ok: Ok<{ netCents: number }> = { ok: true, data: { netCents: 1200 } }
    expect(balances.parse(ok)).toEqual(ok)
    expect(okSchema(z.int()).parse({ ok: true, data: 3 })).toEqual({ ok: true, data: 3 })
    expect(
      balances.safeParse({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a member' } })
        .success,
    ).toBe(true)
  })

  it('rejects data of another shape or a mixed envelope', () => {
    expect(balances.safeParse({ ok: true, data: { netCents: 'x' } }).success).toBe(false)
    expect(
      balances.safeParse({ ok: true, error: { code: 'INTERNAL', message: 'x' } }).success,
    ).toBe(false)
    expect(balances.safeParse({ data: { netCents: 1 } }).success).toBe(false)
  })
})
