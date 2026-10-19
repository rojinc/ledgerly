import type { Category } from '@ledgerly/core/constants/categories'
import { MAX_WEIGHT } from '@ledgerly/core/constants/limits'
import { isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { buildShares, type Share } from '@ledgerly/core/ledger/build-shares'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { formatMoney } from '@ledgerly/core/money/format'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'
import { amountExample, cents } from './presets'

/** How an expense is split (ledger.md#splits): the house form's choices (#181). */
export type SplitMode = 'equal' | 'exact' | 'percent' | 'weights'

/** The house expense form's fields, as typed (#180, #181). */
export type HouseExpenseValues = {
  amount: string
  date: string
  description: string
  category: Category | ''
  /** The person who paid it all, unless several did. */
  paidBy: string
  /** Several people paid: what each paid, as typed, by person; empty means they didn't. */
  severalPaid: boolean
  paid: Record<string, string>
  splitMode: SplitMode
  /** The people it's split between, in any order. */
  splitBetween: string[]
  /** For a split that isn't equal: each person's amount, percentage or shares, as typed. */
  parts: Record<string, string>
  note: string
}

/** A percentage with at most 2 decimals, in basis points (`33.33` → 3333), or NaN. No floats. */
export function parsePercent(text: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return Number.NaN
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return basisPoints <= 10_000 ? basisPoints : Number.NaN
}

/** Basis points as a percentage in words: 9999 → `99.99%`, 10000 → `100%`. */
export function percentText(basisPoints: number): string {
  const decimals = String(basisPoints % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return `${Math.floor(basisPoints / 100)}${decimals ? `.${decimals}` : ''}%`
}

/** Shares as a whole number from 1 to MAX_WEIGHT, or NaN. */
export function parseShares(text: string): number {
  if (!/^\d+$/.test(text.trim())) return Number.NaN
  const shares = Number(text.trim())
  return shares >= 1 && shares <= MAX_WEIGHT ? shares : Number.NaN
}

type Dates = Pick<Members, 'joinedOn' | 'leftOn'>

/** Living in the house on `date`: moved in by then, and not moved out before it. */
export function livesThere(member: Dates, date: string): boolean {
  return member.joinedOn <= date && (member.leftOn === null || date <= member.leftOn)
}

/** Who is ticked by default for an expense on `date`: everyone living there then. */
export function defaultTicks(members: readonly (Dates & { personId: string })[], date: string) {
  return members.filter((member) => livesThere(member, date)).map((member) => member.personId)
}

/** Everyone in a list once, in `personId` order. */
const sortedIds = (ids: readonly string[]) => [...new Set(ids)].sort()

/** Who paid, and how much: one payer with the total, or each filled-in amount. */
export function toPayers(values: HouseExpenseValues, currency: string, totalCents: number) {
  if (!values.severalPaid) return [{ personId: values.paidBy, cents: totalCents }]
  const filled = Object.keys(values.paid).filter((id) => (values.paid[id] ?? '').trim() !== '')
  return sortedIds(filled).map((id) => ({
    personId: id,
    cents: cents(values.paid[id] ?? '', currency),
  }))
}

/** The split of the people ticked, in `personId` order, as the chosen mode. */
export function toSplit(values: HouseExpenseValues, currency: string) {
  const ids = sortedIds(values.splitBetween)
  const part = (id: string) => values.parts[id] ?? ''
  switch (values.splitMode) {
    case 'equal':
      return { mode: 'equal' as const, personIds: ids }
    case 'exact':
      return {
        mode: 'exact' as const,
        amounts: ids.map((id) => ({ personId: id, cents: cents(part(id), currency) })),
      }
    case 'percent':
      return {
        mode: 'percent' as const,
        percents: ids.map((id) => ({ personId: id, basisPoints: parsePercent(part(id)) })),
      }
    case 'weights':
      return {
        mode: 'weights' as const,
        weights: ids.map((id) => ({ personId: id, weight: parseShares(part(id)) })),
      }
  }
}

/**
 * `POST /transactions` for a house expense, always with its payers and split (#180 decision 4).
 * People go in `personId` order, as the default split does, so leftover cents land the same
 * way. NaN makes the schema refuse an amount, percentage or share count that isn't one.
 */
export function toHouseExpenseBody(
  values: HouseExpenseValues,
  ids: { id: string; groupId: string },
  currency: string,
): z.input<typeof transactionInputSchema> {
  const totalCents = cents(values.amount, currency)
  return {
    ...ids,
    kind: 'expense',
    date: values.date,
    description: values.description.trim(),
    ...(values.category === '' ? {} : { category: values.category }),
    totalCents,
    ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
    payers: toPayers(values, currency, totalCents),
    split: toSplit(values, currency),
  }
}

/** What's wrong with the payers' amounts and the split's parts, in plain words, by person. */
export type SplitProblems = {
  paid: Record<string, string>
  paidTotal?: string
  parts: Record<string, string>
  partsTotal?: string
}

/**
 * The amounts paid and the split's parts, checked before sending (#181): each one's format, then
 * whether they add up. Sums are only checked once every part reads.
 */
export function splitProblems(
  values: HouseExpenseValues,
  currency: string,
  totalCents: number,
): SplitProblems {
  const problems: SplitProblems = { paid: {}, parts: {} }
  const money = (amount: number) => formatMoney(amount, currency)
  const totalKnown = Number.isInteger(totalCents) && totalCents > 0
  if (values.severalPaid) {
    const payers = toPayers(values, currency, totalCents)
    for (const payer of payers) {
      if (Number.isNaN(payer.cents)) {
        problems.paid[payer.personId] = `Enter an amount like ${amountExample(currency)}`
      }
    }
    const sum = payers.reduce((total, payer) => total + payer.cents, 0)
    if (payers.length === 0) problems.paidTotal = 'Enter what each person paid.'
    else if (totalKnown && Number.isInteger(sum) && sum !== totalCents) {
      problems.paidTotal = `The amounts paid add up to ${money(sum)}, but the total is ${money(totalCents)}.`
    }
  }
  if (values.splitMode === 'equal') return problems
  const invalid = {
    exact: `Enter an amount like ${amountExample(currency)}`,
    percent: 'Enter a percentage like 33.33',
    weights: `Enter a whole number from 1 to ${MAX_WEIGHT}`,
  }[values.splitMode]
  const split = toSplit(values, currency)
  const parts =
    split.mode === 'exact'
      ? split.amounts.map((entry) => [entry.personId, entry.cents] as const)
      : split.mode === 'percent'
        ? split.percents.map((entry) => [entry.personId, entry.basisPoints] as const)
        : split.mode === 'weights'
          ? split.weights.map((entry) => [entry.personId, entry.weight] as const)
          : []
  for (const [personId, value] of parts) {
    if ((values.parts[personId] ?? '').trim() === '') problems.parts[personId] = 'Required'
    else if (Number.isNaN(value)) problems.parts[personId] = invalid
  }
  if (Object.keys(problems.parts).length > 0 || parts.length === 0) return problems
  const sum = parts.reduce((total, [, value]) => total + value, 0)
  if (split.mode === 'exact' && totalKnown && sum !== totalCents) {
    problems.partsTotal = `The amounts add up to ${money(sum)}, but the total is ${money(totalCents)}.`
  } else if (split.mode === 'percent' && sum !== 10_000) {
    problems.partsTotal = `The percentages add up to ${percentText(sum)}, not 100%.`
  }
  return problems
}

/**
 * Each person's part, worked out by core exactly as the ledger function will (the client never
 * divides money), or the ledger's refusal in its own words.
 */
export function previewShares(
  body: ReturnType<typeof toHouseExpenseBody>,
  group: Pick<Groups, 'ownerPersonId'>,
  members: readonly Members[],
  callerPersonId: string,
): { shares: Share[] } | { error: string } {
  if (!isLocalDate(body.date)) return { error: 'Enter a date.' }
  // Members' dates are stored as YYYY-MM-DD.
  const ledgerMembers = members.map((member) => ({
    personId: member.personId,
    joinedOn: member.joinedOn as LocalDate,
    leftOn: member.leftOn as LocalDate | null,
  }))
  try {
    const { shares } = buildShares(
      {
        kind: 'expense',
        date: body.date,
        totalCents: body.totalCents,
        payers: body.payers,
        split: body.split,
      },
      {
        groupType: 'house',
        ownerPersonId: group.ownerPersonId,
        callerPersonId,
        members: ledgerMembers,
      },
    )
    return { shares }
  } catch (error) {
    if (error instanceof LedgerError) return { error: error.message }
    throw error
  }
}
