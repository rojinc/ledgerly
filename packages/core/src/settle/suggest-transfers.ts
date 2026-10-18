import type { Net } from './nets'

export type Transfer = { fromPersonId: string; toPersonId: string; cents: number }

type Open = { personId: string; cents: number }

/** Largest amount first, ties by personId, so the output never depends on input order. */
const largestFirst = (a: Open, b: Open) => b.cents - a.cents || (a.personId < b.personId ? -1 : 1)

/**
 * The transfers that settle one group (ledger.md#settle-up-suggested-transfers):
 * each round the largest debtor pays the largest creditor the smaller of the
 * two amounts. At most n − 1 transfers. Throws unless the nets are whole
 * cents, one per person, adding up to 0.
 */
export function suggestTransfers(nets: readonly Net[]): Transfer[] {
  if (!nets.every((net) => Number.isSafeInteger(net.netCents))) {
    throw new RangeError('nets must be whole cents')
  }
  if (new Set(nets.map((net) => net.personId)).size !== nets.length) {
    throw new RangeError('nets must have one entry per person')
  }
  // BigInt, so a sum near the safe-integer limit can't round to 0.
  if (nets.reduce((sum, net) => sum + BigInt(net.netCents), 0n) !== 0n) {
    throw new RangeError('nets must add up to 0')
  }
  const creditors: Open[] = nets
    .filter((net) => net.netCents > 0)
    .map((net) => ({ personId: net.personId, cents: net.netCents }))
  const debtors: Open[] = nets
    .filter((net) => net.netCents < 0)
    .map((net) => ({ personId: net.personId, cents: -net.netCents }))

  const transfers: Transfer[] = []
  // The sums match, so both lists run out together.
  while (creditors.length > 0) {
    creditors.sort(largestFirst)
    debtors.sort(largestFirst)
    const creditor = creditors[0] as Open
    const debtor = debtors[0] as Open
    const cents = Math.min(creditor.cents, debtor.cents)
    transfers.push({ fromPersonId: debtor.personId, toPersonId: creditor.personId, cents })
    creditor.cents -= cents
    debtor.cents -= cents
    if (creditor.cents === 0) creditors.shift()
    if (debtor.cents === 0) debtors.shift()
  }
  return transfers
}
