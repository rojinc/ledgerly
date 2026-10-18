import type { GroupType, TransactionKind } from '../constants/domain'
import type { LocalDate } from '../dates/local-date'
import { shiftAmountCents } from '../money/shift-amount'
import type { TransactionTemplate } from '../schemas/ledger'
import type { SplitSpec } from '../schemas/split'
import { invalid } from './ledger-error'
import { type LedgerMember, type Part, type SplitContext, splitAmount } from './split-amount'

/** One person's part in a posted transaction (ledger.md#concepts-in-one-minute). */
export type Share = { personId: string; givenCents: number; receivedCents: number }

export type LedgerContext = {
  groupType: GroupType
  /** The group's owner: the worker in an employer group, "you" in a personal group. */
  ownerPersonId: string
  /** Who is posting; pays everything when the input names no payers. */
  callerPersonId: string
  members: readonly LedgerMember[]
  /** House groups: the split a bill gets when it names none. */
  defaultBillSplit?: 'days' | 'equal'
}

export type ShareInput = TransactionTemplate & { kind: TransactionKind; date: LocalDate }

// ledger.md#transaction-kinds, "Allowed in".
const KINDS_BY_GROUP: Record<GroupType, readonly TransactionKind[]> = {
  employer: ['shift', 'expense', 'payment', 'adjustment'],
  house: ['expense', 'bill', 'payment', 'loan', 'adjustment'],
  personal: ['expense', 'bill', 'income', 'adjustment'],
  pair: ['expense', 'bill', 'payment', 'loan', 'adjustment'],
}

const sumOf = (parts: readonly Part[]) => parts.reduce((total, part) => total + part.cents, 0)

function presentOn(date: LocalDate, members: readonly LedgerMember[]): string[] {
  return members
    .filter(
      (member) => member.joinedOn <= date && (member.leftOn === null || date <= member.leftOn),
    )
    .map((member) => member.personId)
}

/** The split used when the input names none (ledger.md#default-split). */
function defaultSplit(input: ShareInput, payers: readonly Part[], ctx: LedgerContext): SplitSpec {
  if (input.kind === 'bill' && ctx.groupType === 'house' && ctx.defaultBillSplit !== 'equal') {
    return { mode: 'days' }
  }
  const present = presentOn(input.date, ctx.members)
  // A loan goes to the borrowers: everyone present except whoever lent the money.
  const personIds =
    input.kind === 'loan'
      ? present.filter((personId) => !payers.some((payer) => payer.personId === personId))
      : present
  if (personIds.length === 0) invalid('Nobody to split this between; give a split')
  return { mode: 'equal', personIds }
}

/**
 * Turns a transaction into shares (ledger.md#building-shares). Pure: the same
 * input and context always give the same shares, sorted by personId, with no
 * all-zero shares. Throws LedgerError('VALIDATION_FAILED') for input that breaks
 * a ledger rule.
 */
export function buildShares(input: ShareInput, ctx: LedgerContext): Share[] {
  if (!KINDS_BY_GROUP[ctx.groupType].includes(input.kind)) {
    invalid(`A ${ctx.groupType} group can't have a ${input.kind}`)
  }
  const usesPayers = input.kind === 'expense' || input.kind === 'bill' || input.kind === 'loan'
  if (!usesPayers && input.payers !== undefined) invalid(`A ${input.kind} has no payers`)

  const given: Part[] = []
  const received: Part[] = []
  const totalOr = (computed: number) => {
    if (input.totalCents !== undefined && input.totalCents !== computed) {
      invalid('totalCents doesn’t match the amounts')
    }
    return computed
  }
  const required = <T>(value: T | undefined, what: string): T =>
    value ?? invalid(`A ${input.kind} needs ${what}`)

  switch (input.kind) {
    case 'shift': {
      const shift = required(input.shift, 'minutes and a rate')
      const employers = ctx.members.filter((member) => member.personId !== ctx.ownerPersonId)
      if (employers.length !== 1) invalid('An employer group must have exactly one employer')
      const total = totalOr(shiftAmountCents(shift.minutes, shift.rateCents))
      given.push({ personId: ctx.ownerPersonId, cents: total })
      received.push({ personId: (employers[0] as LedgerMember).personId, cents: total })
      break
    }
    case 'payment': {
      const payment = required(input.payment, 'who paid whom')
      const total = required(input.totalCents, 'totalCents')
      given.push({ personId: payment.fromPersonId, cents: total })
      received.push({ personId: payment.toPersonId, cents: total })
      break
    }
    case 'income': {
      const total = required(input.totalCents, 'totalCents')
      given.push({ personId: ctx.ownerPersonId, cents: total })
      received.push({ personId: ctx.ownerPersonId, cents: total })
      break
    }
    case 'adjustment': {
      const { shares } = required(input.adjustment, 'shares')
      for (const share of shares) {
        given.push({ personId: share.personId, cents: share.givenCents })
        received.push({ personId: share.personId, cents: share.receivedCents })
      }
      if (sumOf(given) !== sumOf(received)) invalid('Adjustment shares must balance')
      totalOr(sumOf(given))
      break
    }
    default: {
      // expense, bill, loan: payers give, the split (or the items) receive.
      const total = input.items
        ? totalOr(input.items.reduce((sum, item) => sum + item.amountCents, 0))
        : required(input.totalCents, 'totalCents')
      const payers = input.payers?.map((payer) => ({
        personId: payer.personId,
        cents: payer.cents,
      }))
      given.push(...(payers ?? [{ personId: ctx.callerPersonId, cents: total }]))
      if (sumOf(given) !== total) invalid('Payers must add up to the total')

      const { periodStart, periodEnd } = input.bill ?? {}
      const splitCtx: SplitContext = {
        members: ctx.members,
        // The schema has already checked these are real dates.
        period:
          periodStart && periodEnd
            ? { start: periodStart as LocalDate, end: periodEnd as LocalDate }
            : undefined,
      }
      if (input.items) {
        for (const item of input.items) {
          received.push(...splitAmount(item.split, item.amountCents, splitCtx))
        }
      } else {
        const split = input.split ?? defaultSplit(input, given, ctx)
        received.push(...splitAmount(split, total, splitCtx))
      }
    }
  }

  const byPerson = new Map<string, Share>()
  const shareOf = (personId: string) => {
    const share = byPerson.get(personId) ?? { personId, givenCents: 0, receivedCents: 0 }
    byPerson.set(personId, share)
    return share
  }
  for (const part of given) shareOf(part.personId).givenCents += part.cents
  for (const part of received) shareOf(part.personId).receivedCents += part.cents

  const shares = [...byPerson.values()]
    .filter((share) => share.givenCents !== 0 || share.receivedCents !== 0)
    .sort((a, b) => (a.personId < b.personId ? -1 : 1))

  // I-4 as an input rule: a discount or a payer can't push anyone past zero.
  if (input.kind !== 'adjustment') {
    const total = sumOf(given)
    const amounts = shares.flatMap((share) => [share.givenCents, share.receivedCents])
    if (amounts.some((cents) => (total < 0 ? cents > 0 : cents < 0))) {
      invalid('Amounts can’t mix signs: nobody can end up below zero (or above it, for a refund)')
    }
  }
  return shares
}
