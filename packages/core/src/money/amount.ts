import { MAX_AMOUNT_CENTS } from '../constants/limits'

/** Throws unless `cents` is an integer no bigger than MAX_AMOUNT_CENTS in size (ledger.md#allocation-and-rounding). */
export function assertAmountCents(cents: number): void {
  if (!Number.isInteger(cents) || Math.abs(cents) > MAX_AMOUNT_CENTS) {
    throw new RangeError(`Amounts must be whole cents of at most ${MAX_AMOUNT_CENTS} in size`)
  }
}
