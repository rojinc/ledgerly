import { type DateRange, type LocalDate, overlapDays } from '../dates/local-date'
import { allocate } from '../money/allocate'
import type { SplitSpec } from '../schemas/split'
import { invalid } from './ledger-error'

export type LedgerMember = { personId: string; joinedOn: LocalDate; leftOn: LocalDate | null }

export type Part = { personId: string; cents: number }

export type SplitContext = {
  members: readonly LedgerMember[]
  /** The bill's period; needed for `days` splits. */
  period?: DateRange
}

/** Orders by person ID (unique within a list), so leftover cents and output never depend on input order. */
export const byPersonId = (a: { personId: string }, b: { personId: string }) =>
  a.personId < b.personId ? -1 : 1

/** Days in `period` a member was there (ledger.md#days-present). */
function daysPresent(member: LedgerMember, period: DateRange): number {
  return overlapDays(period, { start: member.joinedOn, end: member.leftOn ?? period.end })
}

function byWeights(amountCents: number, people: readonly { personId: string; weight: number }[]) {
  const parts = allocate(
    amountCents,
    people.map((person) => person.weight),
  )
  return people.map((person, i) => ({ personId: person.personId, cents: parts[i] as number }))
}

/** Divides `amountCents` by a split spec (ledger.md#splits). Parts follow the spec's order. */
export function splitAmount(spec: SplitSpec, amountCents: number, ctx: SplitContext): Part[] {
  switch (spec.mode) {
    case 'equal':
      return byWeights(
        amountCents,
        spec.personIds.map((personId) => ({ personId, weight: 1 })),
      )
    case 'percent':
      return byWeights(
        amountCents,
        spec.percents.map((entry) => ({ personId: entry.personId, weight: entry.basisPoints })),
      )
    case 'weights':
      return byWeights(amountCents, spec.weights)
    case 'exact': {
      const sum = spec.amounts.reduce((total, entry) => total + entry.cents, 0)
      if (sum !== amountCents) invalid('Exact amounts must add up to the amount being split')
      return spec.amounts.map((entry) => ({ personId: entry.personId, cents: entry.cents }))
    }
    case 'days': {
      const period = ctx.period ?? invalid('A days split needs the bill period')
      const named = spec.personIds
      const members = named
        ? named.map(
            (personId) =>
              ctx.members.find((member) => member.personId === personId) ??
              invalid('A days split can only name members'),
          )
        : [...ctx.members].sort(byPersonId)
      const present = members
        .map((member) => ({ personId: member.personId, weight: daysPresent(member, period) }))
        .filter((member) => member.weight > 0)
      if (present.length === 0) invalid('Nobody was present during the bill period')
      return byWeights(amountCents, present)
    }
  }
}
