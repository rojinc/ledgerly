import { LedgerError } from '../ledger/ledger-error'
import type { BalancesPeople } from '../schemas/ledger'

export type ShareAmounts = { personId: string; givenCents: number; receivedCents: number }

/** A group's `balances` row built fresh from all its shares (data-model.md#balances). */
export function balancesFromShares(shares: readonly ShareAmounts[]): BalancesPeople {
  return applyShares([], [], shares)
}

/**
 * The `balances` row after a write replaces the shares `before` with `after`
 * (ledger.md#balances): each person's net and count of shares lose `before`'s and gain
 * `after`'s, and anyone left with no shares is dropped. Throws INVARIANT_VIOLATION when
 * `people` doesn't fit the shares: a count would go below 0, or someone dropped still has a net.
 */
export function applyShares(
  people: BalancesPeople,
  before: readonly ShareAmounts[],
  after: readonly ShareAmounts[],
): BalancesPeople {
  const totals = new Map(people.map(({ personId, ...total }) => [personId, total]))
  const add = ({ personId, givenCents, receivedCents }: ShareAmounts, sign: 1 | -1) => {
    const total = totals.get(personId) ?? { netCents: 0, shares: 0 }
    totals.set(personId, {
      netCents: total.netCents + sign * (givenCents - receivedCents),
      shares: total.shares + sign,
    })
  }
  for (const share of before) add(share, -1)
  for (const share of after) add(share, 1)
  const result: BalancesPeople = []
  for (const [personId, { netCents, shares }] of totals) {
    if (shares < 0 || (shares === 0 && netCents !== 0)) {
      throw new LedgerError('INVARIANT_VIOLATION', 'The balances row doesn’t fit the shares')
    }
    if (shares > 0) result.push({ personId, netCents, shares })
  }
  return result.sort((a, b) => (a.personId < b.personId ? -1 : 1))
}
