import { LedgerError } from '../ledger/ledger-error'
import type { StatementSnapshot } from '../schemas/statements'
import { type Net, netsFromShares } from '../settle/nets'
import { suggestTransfers } from '../settle/suggest-transfers'

type Line = StatementSnapshot['lines'][number]

export type SnapshotInput = {
  group: StatementSnapshot['group']
  period: StatementSnapshot['period']
  /** Every member row of the group, whatever its status, for names. */
  people: readonly { personId: string; name: string }[]
  /** Each person's closing on the previous final statement; empty for the first one. */
  previousClosing: readonly Net[]
  /** The transactions being locked, with their shares (statements.md finalize step 3). */
  lines: readonly Line[]
  /** Invoices (employer groups) only; ignored for divides. */
  issuer?: StatementSnapshot['issuer']
  recipient?: StatementSnapshot['recipient']
  paymentTermsDays?: number
  generatedAt: string
}

/** What finalize step 5 found wrong; empty means the snapshot can be locked. */
export type SnapshotProblem = 'closing' | 'balanced' | 'fresh'

// Dates are fixed-width, so date + ID orders by date, then ID.
const lineKey = (line: Line) => line.date + line.transactionId
const byDateThenId = (a: Line, b: Line) => (lineKey(a) < lineKey(b) ? -1 : 1)

// BigInt, so a sum near the safe-integer limit can't round to 0.
const addsUpToZero = (cents: readonly number[]) =>
  cents.reduce((sum, c) => sum + BigInt(c), 0n) === 0n

/** Wrong input from the calling function is a bug, never the user's fault. */
function bug(message: string): never {
  throw new LedgerError('INVARIANT_VIOLATION', message)
}

/**
 * The statement snapshot (statements.md#snapshot): each person's opening (the
 * previous closing), what they gave and received in the lines, and their
 * closing. People with no opening and no shares are left out. Divides get the
 * suggested transfers (none if the closings don't add up to 0, so
 * `checkSnapshot` reports it); invoices get the worker's closing as the
 * balance due.
 */
export function buildStatementSnapshot(input: SnapshotInput): StatementSnapshot {
  const names = new Map(input.people.map((person) => [person.personId, person.name]))
  const opening = new Map(input.previousClosing.map((net) => [net.personId, net.netCents]))
  const moved = new Map<string, { givenCents: number; receivedCents: number }>()
  for (const share of input.lines.flatMap((line) => line.shares)) {
    const totals = moved.get(share.personId) ?? { givenCents: 0, receivedCents: 0 }
    totals.givenCents += share.givenCents
    totals.receivedCents += share.receivedCents
    moved.set(share.personId, totals)
  }

  const personIds = [...new Set([...opening.keys(), ...moved.keys()])]
    .filter((personId) => opening.get(personId) || moved.has(personId))
    .sort()
  const people = personIds.map((personId) => {
    const name = names.get(personId)
    if (name === undefined) bug('Every person in a statement must be a member')
    const openingCents = opening.get(personId) ?? 0
    const { givenCents, receivedCents } = moved.get(personId) ?? { givenCents: 0, receivedCents: 0 }
    const closingCents = openingCents + givenCents - receivedCents
    return { personId, name, openingCents, givenCents, receivedCents, closingCents }
  })
  const closings = people.map((person) => ({
    personId: person.personId,
    netCents: person.closingCents,
  }))

  const snapshot: StatementSnapshot = {
    version: 1,
    group: input.group,
    period: input.period,
    people,
    lines: [...input.lines].sort(byDateThenId),
    transfers:
      input.group.type === 'house' && addsUpToZero(closings.map((net) => net.netCents))
        ? suggestTransfers(closings)
        : [],
    generatedAt: input.generatedAt,
  }
  if (input.group.type === 'employer') {
    const issuer = input.issuer ?? bug('An invoice needs an issuer')
    snapshot.recipient = input.recipient ?? bug('An invoice needs a recipient')
    const terms = input.paymentTermsDays ?? bug('An invoice needs payment terms')
    // A wrong issuer ID would otherwise make a silent $0 invoice.
    if (!names.has(issuer.personId)) bug('The issuer must be a member')
    if (snapshot.recipient.personId === issuer.personId) bug('The issuer can’t bill themselves')
    snapshot.issuer = issuer
    const worker = people.find((person) => person.personId === issuer.personId)
    snapshot.invoice = { balanceDueCents: worker?.closingCents ?? 0, paymentTermsDays: terms }
  }
  return snapshot
}

/**
 * Statements core rule 2 after a person merge (identity-and-invites.md#merging-two-persons): a
 * closing whose person has no member row in the group counts for the person they were merged
 * into, following `mergedInto` to the first person who has one, and is added to that person's
 * own closing. A closing that can't be followed that far stays as it is, so the snapshot
 * reports it.
 */
export function mergedClosings(
  closings: readonly Net[],
  inGroup: ReadonlySet<string>,
  mergedInto: ReadonlyMap<string, string | null>,
): Net[] {
  const totals = new Map<string, number>()
  for (const { personId, netCents } of closings) {
    const owner = ownerInGroup(personId, inGroup, mergedInto)
    totals.set(owner, (totals.get(owner) ?? 0) + netCents)
  }
  return [...totals].map(([personId, netCents]) => ({ personId, netCents }))
}

type ShareAmounts = { personId: string; givenCents: number; receivedCents: number }

/**
 * Rule 2 for shares a merge hasn't moved yet: each share counts for the person found as in
 * `mergedClosings`, and two shares that then name the same person are combined (I-5), so a
 * snapshot taken between merge batches still adds up.
 */
export function mergedShares(
  shares: readonly ShareAmounts[],
  inGroup: ReadonlySet<string>,
  mergedInto: ReadonlyMap<string, string | null>,
): ShareAmounts[] {
  const byOwner = new Map<string, ShareAmounts>()
  for (const { personId, givenCents, receivedCents } of shares) {
    const owner = ownerInGroup(personId, inGroup, mergedInto)
    const total = byOwner.get(owner)
    byOwner.set(owner, {
      personId: owner,
      givenCents: (total?.givenCents ?? 0) + givenCents,
      receivedCents: (total?.receivedCents ?? 0) + receivedCents,
    })
  }
  return [...byOwner.values()]
}

function ownerInGroup(
  personId: string,
  inGroup: ReadonlySet<string>,
  mergedInto: ReadonlyMap<string, string | null>,
): string {
  const seen = new Set<string>()
  let current = personId
  while (!inGroup.has(current)) {
    const next = mergedInto.get(current)
    // Not merged, or a loop: leave the closing where it is.
    if (!next || seen.has(next)) return personId
    seen.add(current)
    current = next
  }
  return current
}

/**
 * Finalize step 5 (statements.md#2-finalize): each closing is the opening plus
 * that person's nets over the lines, the closings add up to 0, and they equal
 * `freshBalances`, a fresh sum of every locked share in the group.
 */
export function checkSnapshot(
  snapshot: StatementSnapshot,
  freshBalances: readonly Net[],
): SnapshotProblem[] {
  const problems: SnapshotProblem[] = []
  const nets = new Map(
    netsFromShares(snapshot.lines.flatMap((line) => line.shares)).map((net) => [
      net.personId,
      net.netCents,
    ]),
  )
  const closing = new Map(snapshot.people.map((person) => [person.personId, person.closingCents]))
  const everyoneListed = [...nets.keys()].every((personId) => closing.has(personId))
  const closingsAddUp = snapshot.people.every(
    (person) => person.closingCents === person.openingCents + (nets.get(person.personId) ?? 0),
  )
  if (!everyoneListed || !closingsAddUp) problems.push('closing')
  if (!addsUpToZero(snapshot.people.map((person) => person.closingCents))) {
    problems.push('balanced')
  }
  const fresh = new Map(freshBalances.map((net) => [net.personId, net.netCents]))
  const ids = new Set([...closing.keys(), ...fresh.keys()])
  if ([...ids].some((personId) => (closing.get(personId) ?? 0) !== (fresh.get(personId) ?? 0))) {
    problems.push('fresh')
  }
  return problems
}
