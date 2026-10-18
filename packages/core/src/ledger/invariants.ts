import type { TransactionKind } from '../constants/domain'
import type { Share } from './build-shares'
import { LedgerError } from './ledger-error'

function broken(rule: string): never {
  throw new LedgerError('INVARIANT_VIOLATION', `Ledger invariant ${rule} would break`)
}

/**
 * Checks I-1 to I-5 (ledger.md#invariants) before every ledger write. A failure
 * is a bug, never bad input, so it throws INVARIANT_VIOLATION.
 */
export function assertShareInvariants(
  transaction: { kind: TransactionKind; totalCents: number },
  shares: readonly Share[],
  memberPersonIds: readonly string[],
): void {
  const amounts = shares.flatMap((share) => [share.givenCents, share.receivedCents])
  // I-2: whole cents only.
  if (![transaction.totalCents, ...amounts].every(Number.isInteger)) broken('I-2 (integers)')
  // I-1: Σ given = Σ received = total.
  const given = shares.reduce((sum, share) => sum + share.givenCents, 0)
  const received = shares.reduce((sum, share) => sum + share.receivedCents, 0)
  if (given !== transaction.totalCents || received !== transaction.totalCents) {
    broken('I-1 (balanced)')
  }
  // I-3: every person has a member row in the group.
  if (!shares.every((share) => memberPersonIds.includes(share.personId)))
    broken('I-3 (members only)')
  // I-4: one sign per transaction, except adjustments.
  if (transaction.kind !== 'adjustment') {
    const refund = transaction.totalCents < 0
    if (amounts.some((cents) => (refund ? cents > 0 : cents < 0))) broken('I-4 (one sign)')
  }
  // I-5: one share per person.
  if (new Set(shares.map((share) => share.personId)).size !== shares.length) {
    broken('I-5 (one share per person)')
  }
}
