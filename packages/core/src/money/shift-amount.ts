import { assertAmountCents } from './amount'

/** Pay for a shift: minutes × hourly rate, rounded to the cent, half a cent up (ledger.md#allocation-and-rounding). */
export function shiftAmountCents(minutes: number, rateCents: number): number {
  if (!Number.isInteger(minutes) || minutes < 0 || !Number.isInteger(rateCents) || rateCents < 0) {
    throw new RangeError('Shift minutes and rate must be whole numbers, 0 or more')
  }
  const cents = Math.round((minutes * rateCents) / 60)
  assertAmountCents(cents)
  return cents
}
