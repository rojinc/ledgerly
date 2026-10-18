import { MAX_WEIGHT } from '../constants/limits'
import { assertAmountCents } from './amount'

/**
 * Splits `totalCents` by `weights` so the parts always add up to exactly the
 * total (ledger.md#allocation-and-rounding):
 * 1. everyone gets floor(total × weight / Σweights),
 * 2. leftover cents go one at a time to the largest remainders, ties to
 *    whoever comes first,
 * 3. negative totals are split as positive, then flipped.
 */
export function allocate(totalCents: number, weights: readonly number[]): number[] {
  assertAmountCents(totalCents)
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0 || weight > MAX_WEIGHT) {
      throw new RangeError(`weights must be integers from 0 to ${MAX_WEIGHT}`)
    }
  }
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) throw new RangeError('weights must add up to more than 0')

  // The limits already keep total × weight exact as a number; BigInt makes that
  // obvious here and keeps the remainder comparison exact without relying on it.
  const total = BigInt(Math.abs(totalCents))
  const divisor = BigInt(sum)
  const products = weights.map((weight) => total * BigInt(weight))
  const parts = products.map((product) => Number(product / divisor))
  const remainders = products.map((product) => product % divisor)

  const byRemainder = weights.map((_, i) => i)
  byRemainder.sort((a, b) => {
    const ra = remainders[a] as bigint
    const rb = remainders[b] as bigint
    return rb > ra ? 1 : rb < ra ? -1 : a - b
  })
  const leftover = Number(total) - parts.reduce((a, b) => a + b, 0)
  for (const i of byRemainder.slice(0, leftover)) {
    parts[i] = (parts[i] as number) + 1
  }

  // `0 - part` (not `-part`) so a zero share stays 0, never -0.
  return totalCents < 0 ? parts.map((part) => 0 - part) : parts
}
