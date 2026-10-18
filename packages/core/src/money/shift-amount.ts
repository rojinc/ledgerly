/** Pay for a shift: minutes × hourly rate, rounded to the cent, half a cent up (ledger.md#allocation-and-rounding). */
export function shiftAmountCents(minutes: number, rateCents: number): number {
  return Math.round((minutes * rateCents) / 60)
}
