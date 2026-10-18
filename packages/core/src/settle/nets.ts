export type Net = { personId: string; netCents: number }

/**
 * Each person's balance in one group: Σ (given − received) over their shares
 * (ledger.md#balances). Sorted by personId; people whose shares cancel out
 * are kept with 0.
 */
export function netsFromShares(
  shares: readonly { personId: string; givenCents: number; receivedCents: number }[],
): Net[] {
  const nets = new Map<string, number>()
  for (const share of shares) {
    nets.set(
      share.personId,
      (nets.get(share.personId) ?? 0) + share.givenCents - share.receivedCents,
    )
  }
  return [...nets]
    .map(([personId, netCents]) => ({ personId, netCents }))
    .sort((a, b) => (a.personId < b.personId ? -1 : 1))
}
