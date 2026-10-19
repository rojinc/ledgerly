import type { TransactionKind } from '../constants/domain'
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
 */
export function mergeSplit(split: SplitSpec, merge: Merge): SplitSpec {
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
    case 'weights':
      return {
        mode: 'weights',
        weights: mergeEntries(split.weights, merge, (a, b) => ({
          ...a,
          weight: a.weight + b.weight,
        })),
      }
  }
}

/** The parts of a stored input or a schedule template that name people. */
type Named = Pick<TransactionTemplate, 'payers' | 'split' | 'items' | 'payment' | 'adjustment'>

// The kinds that get a default split when they name none (ledger.md#default-split).
const DEFAULT_SPLIT_KINDS: readonly TransactionKind[] = ['expense', 'bill', 'loan']

/**
 * A transaction's stored input, or a schedule's template, with P renamed to U. `voided` is true
 * for a payment or loan whose two sides would both be U: the merge voids it instead.
 *
 * `splitPeople`, for a posted row that names no split and has no items, lists who its default
 * split gave a part (its shares with something received). Where both P and U had one, the split is
 * written out as an `equal` split of those people would merge: `weights`, U 2 and everyone else 1.
 * The default would now count U once, so a later edit would move money between other people. A
 * row where only one of them had a part keeps the default.
 */
export function mergeInput<T extends Named>(
  input: T,
  kind: TransactionKind,
  merge: Merge,
  splitPeople: readonly string[] = [],
): { input: T; voided: boolean } {
  const result: T = { ...input }
  if (input.payers) {
    result.payers = mergeEntries(input.payers, merge, (a, b) => ({
      ...a,
      cents: a.cents + b.cents,
    }))
  }
  if (input.split) {
    result.split = mergeSplit(input.split, merge)
  } else if (
    !input.items &&
    DEFAULT_SPLIT_KINDS.includes(kind) &&
    splitPeople.includes(merge.from) &&
    splitPeople.includes(merge.into)
  ) {
    // As the default lists them: by personId (ledger.md#default-split).
    const personIds = [...new Set(splitPeople)].sort((a, b) => (a < b ? -1 : 1))
    result.split = mergeSplit({ mode: 'equal', personIds }, merge)
  }
  if (input.items) {
    result.items = input.items.map((item) => ({ ...item, split: mergeSplit(item.split, merge) }))
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
  return { input: result, voided: fromItselfToItself(result, kind, merge.into) }
}

/**
 * A payment or loan from U to U, which moves no money between two people any more. Only the
 * people an input names count, so a loan counts only with its payers and its split both stated:
 * with no split, everyone but the lender borrows (ledger.md#default-split), and with no payers,
 * whoever posts it lends.
 */
function fromItselfToItself(input: Named, kind: TransactionKind, into: string): boolean {
  if (kind === 'payment') {
    return input.payment?.fromPersonId === into && input.payment.toPersonId === into
  }
  if (kind !== 'loan' || !input.payers?.length || !input.split) return false
  return everyPersonId(input).every((personId) => personId === into)
}
