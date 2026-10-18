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
})
