import type { StatementSnapshot } from '../schemas/statements'
import { type Net, netsFromShares } from '../settle/nets'
import { suggestTransfers } from '../settle/suggest-transfers'

type Line = StatementSnapshot['lines'][number]

export type SnapshotInput = {
  group: StatementSnapshot['group']
  period: StatementSnapshot['period']
  /** The group's members, for their names. */
  people: readonly { personId: string; name: string }[]
  /** Each person's closing on the previous final statement; empty for the first one. */
  previousClosing: readonly Net[]
  /** The transactions being locked, with their shares (statements.md finalize step 3). */
  lines: readonly Line[]
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

/**
 * The statement snapshot (statements.md#snapshot): each person's opening (the
 * previous closing), what they gave and received in the lines, and their
 * closing. People with no opening and no shares are left out. Divides get the
 * suggested transfers; invoices get the worker's closing as the balance due.
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
    if (name === undefined) throw new Error('Every person in a statement must be a member')
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
    transfers: input.group.type === 'house' ? suggestTransfers(closings) : [],
    generatedAt: input.generatedAt,
  }
  if (input.recipient) snapshot.recipient = input.recipient
  if (input.group.type === 'employer') {
    const issuer = input.issuer ?? invoiceNeeds('an issuer')
    const terms = input.paymentTermsDays ?? invoiceNeeds('payment terms')
    snapshot.issuer = issuer
    const worker = people.find((person) => person.personId === issuer.personId)
    snapshot.invoice = { balanceDueCents: worker?.closingCents ?? 0, paymentTermsDays: terms }
  }
  return snapshot
}

function invoiceNeeds(what: string): never {
  throw new Error(`An invoice needs ${what}`)
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
  if (snapshot.people.reduce((sum, person) => sum + person.closingCents, 0) !== 0) {
    problems.push('balanced')
  }
  const fresh = new Map(freshBalances.map((net) => [net.personId, net.netCents]))
  const ids = new Set([...closing.keys(), ...fresh.keys()])
  if ([...ids].some((personId) => (closing.get(personId) ?? 0) !== (fresh.get(personId) ?? 0))) {
    problems.push('fresh')
  }
  return problems
}
