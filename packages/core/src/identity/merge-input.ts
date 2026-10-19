import type { TransactionKind } from '../constants/domain'
import { MAX_WEIGHT } from '../constants/limits'
import type { LocalDate } from '../dates/local-date'
import {
  buildShares,
  type LedgerContext,
  type Share,
  type ShareInput,
} from '../ledger/build-shares'
import { byPersonId, type Part, type SplitContext, splitAmount } from '../ledger/split-amount'
import { allocate } from '../money/allocate'
import { everyPersonId, type TransactionTemplate } from '../schemas/ledger'
import type { SplitSpec } from '../schemas/split'

// identity-and-invites.md#merging-two-persons, step 3: when placeholder P is merged into U, P
// becomes U inside the stored inputs that name people. Where U is already listed, the entries
// add up, so U's part is P's and U's together (an equal split's leftover cent may fall
// differently once it's posted).

/** P (`from`) is being merged into U (`into`). */
export type Merge = { from: string; into: string }

/**
 * The entries with P's renamed to U. Where both are listed, the two become one entry, at the
 * first of their two places, holding `add(first, second)`.
 */
function mergeEntries<T extends { personId: string }>(
  entries: readonly T[],
  { from, into }: Merge,
  add: (a: T, b: T) => T,
): T[] {
  const result: T[] = []
  let merged: number | undefined
  for (const entry of entries) {
    if (entry.personId !== from && entry.personId !== into) {
      result.push(entry)
    } else if (merged === undefined) {
      merged = result.length
      result.push({ ...entry, personId: into })
    } else {
      result[merged] = { ...add(result[merged] as T, entry), personId: into }
    }
  }
  return result
}

/** `personIds` with P renamed to U, listed once. */
function mergeIds(personIds: readonly string[], { from, into }: Merge): string[] {
  const renamed = personIds.map((personId) => (personId === from ? into : personId))
  return renamed.filter((personId, index) => personId !== into || renamed.indexOf(into) === index)
}

/**
 * A split with P renamed to U. Where both are listed, their parts add up: `exact` cents,
 * `percent` basis points and `weights`. An `equal` split with both becomes `weights`, U 2 and
 * everyone else 1. A `days` split lists U once, since presence
 * comes from U's kept member row.
 *
 * Weights that would add up past `MAX_WEIGHT` become `exact` when `amountCents`, the amount being
 * split, is given (lead, #39 Q1): each keeps the part `allocate()` gave them, P's and U's added.
 */
export function mergeSplit(split: SplitSpec, merge: Merge, amountCents?: number): SplitSpec {
  switch (split.mode) {
    case 'equal': {
      const both = split.personIds.includes(merge.from) && split.personIds.includes(merge.into)
      if (!both) return { mode: 'equal', personIds: mergeIds(split.personIds, merge) }
      return {
        mode: 'weights',
        weights: mergeIds(split.personIds, merge).map((personId) => ({
          personId,
          weight: personId === merge.into ? 2 : 1,
        })),
      }
    }
    case 'days':
      return split.personIds ? { mode: 'days', personIds: mergeIds(split.personIds, merge) } : split
    case 'exact':
      return {
        mode: 'exact',
        amounts: mergeEntries(split.amounts, merge, (a, b) => ({ ...a, cents: a.cents + b.cents })),
      }
    case 'percent':
      return {
        mode: 'percent',
        percents: mergeEntries(split.percents, merge, (a, b) => ({
          ...a,
          basisPoints: a.basisPoints + b.basisPoints,
        })),
      }
    case 'weights': {
      const weights = mergeEntries(split.weights, merge, (a, b) => ({
        ...a,
        weight: a.weight + b.weight,
      }))
      if (amountCents === undefined || weights.every((entry) => entry.weight <= MAX_WEIGHT)) {
        return { mode: 'weights', weights }
      }
      const parts = allocate(
        amountCents,
        split.weights.map((entry) => entry.weight),
      )
      return {
        mode: 'exact',
        amounts: mergeEntries(
          split.weights.map((entry, i) => ({
            personId: entry.personId,
            cents: parts[i] as number,
          })),
          merge,
          (a, b) => ({ ...a, cents: a.cents + b.cents }),
        ),
      }
    }
  }
}

/** The parts of a stored input or a schedule template that name people. */
type Named = Pick<
  TransactionTemplate,
  'totalCents' | 'payers' | 'split' | 'items' | 'payment' | 'adjustment'
>

// The kinds with a split, or a default one when they name none (ledger.md#default-split).
const DEFAULT_SPLIT_KINDS: readonly TransactionKind[] = ['expense', 'bill', 'loan']

/**
 * A posted transaction, for `mergeInput` to check that an edit after the merge keeps every net:
 * its date and total, its shares (P's still on P), its group as step 2 left it, and who pays
 * where the input names no payers (whoever posted it, as an edit has it).
 */
export type Posted = {
  date: LocalDate
  totalCents: number
  shares: readonly Pick<Share, 'personId' | 'receivedCents'>[]
  ctx: LedgerContext
  payer: string
}

const addCents = (a: Part, b: Part) => ({ ...a, cents: a.cents + b.cents })

/** What each person received, P's added to U's, by personId: the parts an edit must keep. */
function mergedParts(posted: Posted, merge: Merge): Part[] {
  const parts = posted.shares
    .filter((share) => share.receivedCents !== 0)
    .map((share) => ({ personId: share.personId, cents: share.receivedCents }))
  return mergeEntries(parts, merge, addCents).sort(byPersonId)
}

/** Whether two lists give everyone the same part, whatever their order; a 0 is no part. */
function sameParts(a: readonly Part[], b: readonly Part[]): boolean {
  const key = (parts: readonly Part[]) =>
    parts
      .filter((part) => part.cents !== 0)
      .map((part) => `${part.personId} ${part.cents}`)
      .sort()
      .join()
  return key(a) === key(b)
}

/** Whether `input`, planned again as an edit would plan it, gives exactly `parts`. */
function plansTo(input: Named, kind: TransactionKind, posted: Posted, parts: readonly Part[]) {
  try {
    const { shares } = buildShares(
      { ...input, kind, date: posted.date, totalCents: posted.totalCents } as ShareInput,
      { ...posted.ctx, callerPersonId: posted.payer },
    )
    return sameParts(
      shares.map((share) => ({ personId: share.personId, cents: share.receivedCents })),
      parts,
    )
  } catch {
    return false
  }
}

/**
 * An item's split in a posted transaction, with P renamed to U (lead, #242). Item splits are
 * explicit, so where the renamed split wouldn't give the item's parts again (P's and U's added
 * up: an `equal` or `weights` split's leftover cent can fall elsewhere once two entries are one),
 * it's written out as `exact` from those parts. One that can't be planned now (a `days` split
 * naming P, whose member row step 2 removed) is renamed only.
 */
export function mergePostedSplit(
  split: SplitSpec,
  merge: Merge,
  amountCents: number,
  ctx: SplitContext,
): SplitSpec {
  const renamed = mergeSplit(split, merge, amountCents)
  let parts: Part[]
  try {
    parts = mergeEntries(splitAmount(split, amountCents, ctx), merge, addCents)
  } catch {
    return renamed
  }
  // Renamed, it names only members, and weights past MAX_WEIGHT are already exact.
  return sameParts(splitAmount(renamed, amountCents, ctx), parts)
    ? renamed
    : { mode: 'exact', amounts: parts }
}

/**
 * A transaction's stored input, or a schedule's template, with P renamed to U. `voided` is true
 * for a payment or loan whose two sides would both be U: the merge voids it instead.
 *
 * `posted` is given for a posted transaction without items (lead, #39 Q2). If the renamed input,
 * planned again, wouldn't give each person their part (P's and U's added up), an edit after the
 * merge would move money between people: a default split would count U once, a `days` split
 * would count the days of U's kept member row, a loan's default would leave out a U who lent, a
 * leftover cent would fall elsewhere. So the split is written out:
 * - with no split, as an `equal` split of those who had a part merges (`weights`, U at 2, or U in
 *   P's place for a loan), if that plans the same parts;
 * - otherwise as `exact`, from the parts. An edit that changes the total then picks the split
 *   again.
 * A loan that becomes U to U is voided.
 */
export function mergeInput<T extends Named>(
  input: T,
  kind: TransactionKind,
  merge: Merge,
  posted?: Posted,
  // A stored input keeps its total on the row; a template has its own.
  totalCents = input.totalCents,
): { input: T; voided: boolean } {
  const result: T = { ...input }
  if (input.payers) {
    result.payers = mergeEntries(input.payers, merge, (a, b) => ({
      ...a,
      cents: a.cents + b.cents,
    }))
  }
  if (input.split) result.split = mergeSplit(input.split, merge, totalCents)
  // Only a row that is P's: its input names P, or P has a share in it (lead, #242).
  if (
    posted &&
    !input.items &&
    DEFAULT_SPLIT_KINDS.includes(kind) &&
    (everyPersonId(input).includes(merge.from) ||
      posted.shares.some((share) => share.personId === merge.from))
  ) {
    writeOut(result, kind, merge, posted)
  }
  if (input.items) {
    result.items = input.items.map((item) => ({
      ...item,
      split: mergeSplit(item.split, merge, item.amountCents),
    }))
  }
  if (input.payment) {
    const rename = (personId: string) => (personId === merge.from ? merge.into : personId)
    result.payment = {
      fromPersonId: rename(input.payment.fromPersonId),
      toPersonId: rename(input.payment.toPersonId),
    }
  }
  if (input.adjustment) {
    result.adjustment = {
      ...input.adjustment,
      shares: mergeEntries(input.adjustment.shares, merge, (a, b) => ({
        ...a,
        givenCents: a.givenCents + b.givenCents,
        receivedCents: a.receivedCents + b.receivedCents,
      })),
    }
  }
  const lender = input.payers?.length ? undefined : posted?.payer
  return { input: result, voided: fromItselfToItself(result, kind, merge.into, lender) }
}

/** Writes `input`'s split out where the renamed input wouldn't plan the parts again. */
function writeOut(input: Named, kind: TransactionKind, merge: Merge, posted: Posted) {
  const parts = mergedParts(posted, merge)
  if (parts.length === 0 || plansTo(input, kind, posted, parts)) return
  if (!input.split) {
    // As the default lists them: by personId (ledger.md#default-split).
    const personIds = posted.shares
      .filter((share) => share.receivedCents !== 0)
      .map((share) => share.personId)
      .sort((a, b) => (a < b ? -1 : 1))
    input.split = mergeSplit({ mode: 'equal', personIds }, merge)
    if (plansTo(input, kind, posted, parts)) return
  }
  input.split = { mode: 'exact', amounts: parts }
}

/**
 * A payment or loan from U to U, which moves no money between two people any more. Only the
 * people an input names count, so a loan counts only with its split stated (with no split,
 * everyone but the lender borrows, ledger.md#default-split) and a lender known: its payers, or,
 * with none, `lender`, whoever posted it. An unposted loan without payers is lent by whoever
 * posts it, so it never counts.
 */
function fromItselfToItself(
  input: Named,
  kind: TransactionKind,
  into: string,
  lender: string | undefined,
): boolean {
  if (kind === 'payment') {
    return input.payment?.fromPersonId === into && input.payment.toPersonId === into
  }
  const lenders = input.payers?.length
    ? input.payers.map((payer) => payer.personId)
    : lender === undefined
      ? []
      : [lender]
  if (kind !== 'loan' || lenders.length === 0 || !input.split) return false
  return [...lenders, ...everyPersonId(input)].every((personId) => personId === into)
}
