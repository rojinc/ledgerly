import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS, MAX_WEIGHT } from '../constants/limits'
import { allocate } from './allocate'

// Small seeded generator, so a failing random case is the same on every run.
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('allocate', () => {
  it('splits the ledger doc example', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333])
  })

  it('gives leftover cents to the largest remainders first', () => {
    // 100 × 1/3 = 33.33…, 100 × 2/3 = 66.66…: the 2/3 share has the larger remainder.
    expect(allocate(100, [1, 2])).toEqual([33, 67])
    expect(allocate(27000, [92, 92, 61])).toEqual([10139, 10139, 6722])
  })

  it('breaks ties in spec order', () => {
    expect(allocate(2, [1, 1, 1])).toEqual([1, 1, 0])
    expect(allocate(1, [5, 5])).toEqual([1, 0])
  })

  it('splits negative totals as positive and flips the sign', () => {
    expect(allocate(-1000, [1, 1, 1])).toEqual([-334, -333, -333])
    expect(allocate(-200, [1, 1, 1])).toEqual([-67, -67, -66])
  })

  it('never returns -0', () => {
    const parts = allocate(-1, [1, 1])
    expect(parts).toEqual([-1, 0])
    expect(Object.is(parts[1], 0)).toBe(true)
  })

  it('handles a zero total and zero weights', () => {
    expect(allocate(0, [1, 2])).toEqual([0, 0])
    expect(allocate(500, [0, 1])).toEqual([0, 500])
  })

  it('accepts the limits', () => {
    expect(allocate(MAX_AMOUNT_CENTS, [MAX_WEIGHT, 1])).toEqual([9_999_000_100, 999_900])
    expect(allocate(-MAX_AMOUNT_CENTS, [1])).toEqual([-MAX_AMOUNT_CENTS])
  })

  it.each([
    ['an empty weight list', 100, []],
    ['weights that add up to 0', 100, [0, 0]],
    ['a negative weight', 100, [2, -1]],
    ['a fractional weight', 100, [1.5, 1]],
    ['a weight over the limit', 100, [MAX_WEIGHT + 1]],
    ['a fractional total', 10.5, [1]],
    ['a total over the limit', MAX_AMOUNT_CENTS + 1, [1]],
    ['a total under the negative limit', -MAX_AMOUNT_CENTS - 1, [1]],
  ])('rejects %s', (_, total, weights) => {
    expect(() => allocate(total, weights)).toThrow(RangeError)
  })

  it('always sums to the total and never differs by 1 cent or more from the exact share', () => {
    const random = seededRandom(20261018)
    const int = (max: number) => Math.floor(random() * (max + 1))
    for (let run = 0; run < 5000; run++) {
      // Mix everyday amounts with amounts near the limits, and allow zero weights.
      const big = run % 2 === 0
      const size = big ? int(MAX_AMOUNT_CENTS) : int(2_000_000)
      const total = random() < 0.5 ? 0 - size : size
      const count = 1 + int(14)
      const weights = Array.from({ length: count }, () => (big ? int(MAX_WEIGHT) : int(100)))
      if (!weights.some((weight) => weight > 0)) weights[0] = 1
      const parts = allocate(total, weights)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      const sum = weights.reduce((a, b) => a + b, 0)
      parts.forEach((part, i) => {
        expect(Math.abs(part - (total * (weights[i] as number)) / sum)).toBeLessThan(1)
        // I-4: one sign per transaction.
        expect(total >= 0 ? part >= 0 : part <= 0).toBe(true)
      })
    }
  })
})
