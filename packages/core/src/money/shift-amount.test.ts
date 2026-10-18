import { describe, expect, it } from 'vitest'
import { shiftAmountCents } from './shift-amount'

describe('shiftAmountCents', () => {
  it('works out the ledger doc example: 5 h at $25', () => {
    expect(shiftAmountCents(300, 2500)).toBe(12500)
  })

  it('rounds half a cent up and less than half down', () => {
    expect(shiftAmountCents(1, 30)).toBe(1) // 0.5 cent
    expect(shiftAmountCents(1, 29)).toBe(0) // 0.48 cent
    expect(shiftAmountCents(50, 2533)).toBe(2111) // 2110.83 cents
  })

  it('returns 0, not -0, for a zero shift', () => {
    expect(Object.is(shiftAmountCents(0, 2500), 0)).toBe(true)
  })

  it.each([
    [1.5, 2500],
    [-1, 2500],
    [60, 25.5],
    [60, -1],
    [Number.NaN, 2500],
    [1e9, 1e9], // far over MAX_AMOUNT_CENTS
  ])('rejects %d minutes at %d cents an hour', (minutes, rateCents) => {
    expect(() => shiftAmountCents(minutes, rateCents)).toThrow(RangeError)
  })
})
