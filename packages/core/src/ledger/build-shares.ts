import type { GroupType, TransactionKind } from '../constants/domain'
import { MAX_AMOUNT_CENTS, MAX_PEOPLE_PER_TRANSACTION } from '../constants/limits'
import type { DateRange, LocalDate } from '../dates/local-date'
import { shiftAmountCents } from '../money/shift-amount'
import type { TransactionTemplate } from '../schemas/ledger'
import type { SplitSpec } from '../schemas/split'
import { invalid, LedgerError } from './ledger-error'
import { byPersonId, daysPresent, type LedgerMember, type Part, splitAmount } from './split-amount'

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

const capped = (cents: number) =>
  Math.abs(cents) > MAX_AMOUNT_CENTS ? invalid('An amount is over the maximum') : cents

function billPeriod(input: ShareInput): DateRange | undefined {
  const { periodStart, periodEnd } = input.bill ?? {}
  return periodStart && periodEnd ? { start: periodStart, end: periodEnd } : undefined
}

/** The split used when the input names none (ledger.md#default-split). */
function defaultSplit(input: ShareInput, payers: readonly Part[], ctx: LedgerContext): SplitSpec {
  if (ctx.groupType === 'employer') invalid('An employer expense needs a split (pick a preset)')
  const period = input.kind === 'bill' && ctx.groupType === 'house' ? billPeriod(input) : undefined
  if (period && ctx.defaultBillSplit !== 'equal') return { mode: 'days' }
  // Only houses have real move-in and move-out dates; elsewhere joinedOn is just
  // the day someone was added, and back-dated entries are normal. A house bill
  // with a period goes to whoever lived there during it, not on the paid date.
  const date = input.date
  const included = (member: LedgerMember) => {
    if (period) return daysPresent(member, period) > 0
    if (ctx.groupType !== 'house') return true
    return member.joinedOn <= date && (member.leftOn === null || date <= member.leftOn)
  }
  const personIds = [...ctx.members]
    .sort(byPersonId)
    .filter(included)
    .map((member) => member.personId)
    // A loan goes to the borrowers: everyone except whoever lent the money.
    .filter((personId) => input.kind !== 'loan' || !payers.some((p) => p.personId === personId))
  if (personIds.length === 0) invalid('Nobody to split this between; give a split')
  return { mode: 'equal', personIds }
}

function shiftTotal(minutes: number, rateCents: number): number {
  try {
    return shiftAmountCents(minutes, rateCents)
  } catch {
    return invalid(
      'This shift’s minutes or rate aren’t valid, or it comes to more than the maximum',
    )
  }
}

/**
 * Turns a transaction into its total and shares (ledger.md#building-shares).
 * Pure: the same input and context always give the same result, with shares
 * sorted by personId and no all-zero shares. Throws
 * LedgerError('VALIDATION_FAILED') for input that breaks a ledger rule.
 */
export function buildShares(
  input: ShareInput,
  ctx: LedgerContext,
): { totalCents: number; shares: Share[] } {
  const { kind } = input
  if (!KINDS_BY_GROUP[ctx.groupType].includes(kind)) {
    invalid(`${ctx.groupType} groups can't have ${kind} transactions`)
  }
  const usesPayers = kind === 'expense' || kind === 'bill' || kind === 'loan'
  if (!usesPayers && input.payers !== undefined) invalid(`This ${kind} can't have payers`)
  if (input.items !== undefined && input.split !== undefined) {
    invalid('Give either items or a split, not both')
  }

  const given: Part[] = []
  const received: Part[] = []
  const totalOr = (computed: number) => {
    if (input.totalCents !== undefined && input.totalCents !== computed) {
      invalid('totalCents doesn’t match the amounts')
    }
    return computed
  }
  const required = <T>(value: T | undefined, what: string): T =>
    value ?? invalid(`This ${kind} needs ${what}`)
  let total: number

  switch (kind) {
    case 'shift': {
      const shift = required(input.shift, 'minutes and a rate')
      const employers = ctx.members.filter((member) => member.personId !== ctx.ownerPersonId)
      if (employers.length !== 1) {
        // functions-api.md: employer groups always have exactly two members.
        throw new LedgerError('INVARIANT_VIOLATION', 'Employer group without exactly one employer')
      }
      if (input.totalCents !== undefined) invalid('A shift’s total comes from its minutes and rate')
      total = shiftTotal(shift.minutes, shift.rateCents)
      given.push({ personId: ctx.ownerPersonId, cents: total })
      received.push({ personId: (employers[0] as LedgerMember).personId, cents: total })
      break
    }
    case 'payment': {
      const payment = required(input.payment, 'who paid whom')
      total = required(input.totalCents, 'totalCents')
      given.push({ personId: payment.fromPersonId, cents: total })
      received.push({ personId: payment.toPersonId, cents: total })
      break
    }
    case 'income': {
      total = required(input.totalCents, 'totalCents')
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
      total = totalOr(sumOf(given))
      break
    }
    default: {
      // expense, bill, loan: payers give, the split (or the items) receive.
      // Capped before splitting, so allocate() never sees an amount it refuses.
      for (const item of input.items ?? []) capped(item.amountCents)
      total = capped(
        input.items
          ? totalOr(input.items.reduce((sum, item) => sum + item.amountCents, 0))
          : required(input.totalCents, 'totalCents'),
      )
      const payers = input.payers?.map((payer) => ({
        personId: payer.personId,
        cents: payer.cents,
      }))
      given.push(...(payers ?? [{ personId: ctx.callerPersonId, cents: total }]))
      if (sumOf(given) !== total) invalid('Payers must add up to the total')

      const splitCtx = { members: ctx.members, period: billPeriod(input) }
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

  capped(total)
  if (total === 0) total = 0 // -0 (from JSON) becomes 0, as allocate() does
  if (total < 0 && kind !== 'expense' && kind !== 'bill' && kind !== 'adjustment') {
    invalid('Only expenses and bills can be refunds (a negative total)')
  }
  // I-3 as an input rule.
  const memberIds = new Set(ctx.members.map((member) => member.personId))
  if ([...given, ...received].some((part) => !memberIds.has(part.personId))) {
    invalid('Only members of the group can be in a transaction')
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
    .sort(byPersonId)
  if (shares.length > MAX_PEOPLE_PER_TRANSACTION) {
    invalid(`At most ${MAX_PEOPLE_PER_TRANSACTION} people per transaction`)
  }

  // I-4 as an input rule: a discount or a payer can't push anyone past zero.
  if (kind !== 'adjustment') {
    const amounts = shares.flatMap((share) => [share.givenCents, share.receivedCents])
    if (amounts.some((cents) => (total < 0 ? cents > 0 : cents < 0))) {
      invalid('Amounts can’t mix signs: nobody can end up below zero (or above it, for a refund)')
    }
  }
  return { totalCents: total, shares }
}
