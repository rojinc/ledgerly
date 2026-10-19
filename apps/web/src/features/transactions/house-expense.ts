import type { Category } from '@ledgerly/core/constants/categories'
import {
  MAX_AMOUNT_CENTS,
  MAX_ITEMS_PER_TRANSACTION,
  MAX_WEIGHT,
} from '@ledgerly/core/constants/limits'
import { isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { buildShares, type Share } from '@ledgerly/core/ledger/build-shares'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { formatMoney, formatNet } from '@ledgerly/core/money/format'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'
import { centsToText } from '../groups/employer-form'
import { amountExample, cents, readStored } from './presets'

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
  /** Itemised (#42): the items replace the amount and the split; `splitBetween` is who's sharing. */
  itemised: boolean
  items: ItemValues[]
}

/** One receipt item, as typed (#42). */
export type ItemValues = {
  name: string
  amount: string
  /** Stores the amount as negative: a discount. */
  discount: boolean
  category: Category | ''
  /** Equally between its people, or by shares. */
  mode: 'equal' | 'weights'
  /** Who's sharing the receipt but not this item: new sharers are in every item by default. */
  excluded: string[]
  /** By shares: each person's shares, as typed. */
  shares: Record<string, string>
}

export const NEW_ITEM: ItemValues = {
  name: '',
  amount: '',
  discount: false,
  category: '',
  mode: 'equal',
  excluded: [],
  shares: {},
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

/** An item's amount in cents: negative for a discount, NaN when it isn't one. */
export function itemCents(item: ItemValues, currency: string): number {
  const amount = cents(item.amount, currency)
  return item.discount ? -Math.abs(amount) : amount
}

/** Who an item is for: everyone sharing the receipt but the ones unticked, in `personId` order. */
export function itemPeople(item: ItemValues, sharing: readonly string[]): string[] {
  return sortedIds(sharing.filter((id) => !item.excluded.includes(id)))
}

/** The receipt's total: the sum of its items, or NaN until every amount reads. */
export function itemsTotal(values: HouseExpenseValues, currency: string): number {
  return values.items.reduce((total, item) => total + itemCents(item, currency), 0)
}

/** `items` for the ledger, in the order shown, each with its own split. */
export function toItems(values: HouseExpenseValues, currency: string) {
  return values.items.map((item) => {
    const people = itemPeople(item, values.splitBetween)
    return {
      name: item.name.trim(),
      amountCents: itemCents(item, currency),
      ...(item.category === '' ? {} : { category: item.category }),
      split:
        item.mode === 'equal'
          ? { mode: 'equal' as const, personIds: people }
          : {
              mode: 'weights' as const,
              weights: people.map((id) => ({
                personId: id,
                weight: parseShares(item.shares[id] ?? ''),
              })),
            },
    }
  })
}

/**
 * `POST /transactions` for a house expense, always with its payers and split (#180 decision 4).
 * Itemised (#42), it has `items` instead of a total and a split; a refund (items summing below
 * 0) has one person refunded the whole (negative) total.
 * People go in `personId` order, as the default split does, so leftover cents land the same
 * way. NaN makes the schema refuse an amount, percentage or share count that isn't one.
 */
export function toHouseExpenseBody(
  values: HouseExpenseValues,
  ids: { id: string; groupId: string },
  currency: string,
): z.input<typeof transactionInputSchema> {
  const common = {
    ...ids,
    kind: 'expense' as const,
    date: values.date,
    description: values.description.trim(),
    ...(values.category === '' ? {} : { category: values.category }),
    ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
  }
  if (values.itemised) {
    const total = itemsTotal(values, currency)
    const refund = total < 0
    return {
      ...common,
      payers: toPayers({ ...values, severalPaid: values.severalPaid && !refund }, currency, total),
      items: toItems(values, currency),
    }
  }
  const totalCents = cents(values.amount, currency)
  return {
    ...common,
    totalCents,
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
  // A sum of typed amounts can pass the cap: it's checked, not formatted, against it.
  const money = (amount: number) => formatNet(amount, currency)
  const totalKnown = Number.isInteger(totalCents) && totalCents > 0
  if (values.severalPaid) {
    const payers = toPayers(values, currency, totalCents)
    for (const payer of payers) {
      if (Number.isNaN(payer.cents)) {
        problems.paid[payer.personId] = `Enter an amount like ${amountExample(currency)}`
      } else if (payer.cents <= 0) {
        problems.paid[payer.personId] = 'Enter an amount above 0, or leave it empty'
      }
    }
    const sum = payers.reduce((total, payer) => total + payer.cents, 0)
    if (payers.length === 0) problems.paidTotal = 'Enter what each person paid.'
    else if (Object.keys(problems.paid).length > 0) {
      // Each amount first.
    } else if (totalKnown && sum !== totalCents) {
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
    else if (value < 0) problems.parts[personId] = 'Enter an amount of 0 or more'
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

/** An item's name, as the schema allows it (functions-api.md#transactioninput). */
const MAX_ITEM_NAME = 120

/** What's wrong with each item, by its position, and with the items together (#42). */
export type ItemProblems = {
  items: Record<
    number,
    { name?: string; amount?: string; people?: string; shares: Record<string, string> }
  >
  total?: string
}

/** Every item checked before sending: its name, amount, people and shares; then the total. */
export function itemProblems(values: HouseExpenseValues, currency: string): ItemProblems {
  const problems: ItemProblems = { items: {} }
  if (values.items.length === 0) problems.total = 'Add at least one item.'
  else if (values.items.length > MAX_ITEMS_PER_TRANSACTION) {
    problems.total = `A receipt can have at most ${MAX_ITEMS_PER_TRANSACTION} items.`
  }
  values.items.forEach((item, index) => {
    const found: ItemProblems['items'][number] = { shares: {} }
    if (item.name.trim() === '') found.name = 'Required'
    else if (item.name.trim().length > MAX_ITEM_NAME) {
      found.name = `At most ${MAX_ITEM_NAME} characters`
    }
    const amount = itemCents(item, currency)
    if (item.amount.trim() === '') found.amount = 'Required'
    else if (Number.isNaN(amount)) found.amount = `Enter an amount like ${amountExample(currency)}`
    else if (amount === 0) found.amount = 'Enter an amount other than 0'
    const people = itemPeople(item, values.splitBetween)
    if (people.length === 0) found.people = 'Tick at least one person for this item.'
    if (item.mode === 'weights') {
      for (const id of people) {
        const text = item.shares[id] ?? ''
        if (text.trim() === '') found.shares[id] = 'Required'
        else if (Number.isNaN(parseShares(text))) {
          found.shares[id] = `Enter a whole number from 1 to ${MAX_WEIGHT}`
        }
      }
    }
    if (found.name || found.amount || found.people || Object.keys(found.shares).length > 0) {
      problems.items[index] = found
    }
  })
  const total = itemsTotal(values, currency)
  if (!problems.total && Object.keys(problems.items).length === 0) {
    if (total === 0) problems.total = 'The items add up to 0.'
    // Each item may be up to the limit; their sum may not.
    else if (Math.abs(total) > MAX_AMOUNT_CENTS) {
      problems.total = `The items add up to more than ${formatMoney(MAX_AMOUNT_CENTS, currency)}.`
    }
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
        items: body.items,
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
    if (error instanceof LedgerError) {
      // I-4, worded for what causes it on a receipt. Core has no code for it, so its message
      // ('Amounts can’t mix signs: …', packages/core/src/ledger/build-shares.ts) is matched.
      if (body.items && /mix signs/.test(error.message)) {
        const total = body.items.reduce((sum, item) => sum + item.amountCents, 0)
        return {
          error:
            total < 0
              ? 'On a refund, an item can’t make anyone’s part go above zero.'
              : 'A discount can’t make anyone’s part go below zero.',
        }
      }
      return { error: error.message }
    }
    throw error
  }
}

/** The split as stored (`transactions.inputJson`), each mode's list by its own name. */
type StoredSplit = {
  mode?: unknown
  personIds?: unknown
  amounts?: unknown
  percents?: unknown
  weights?: unknown
}

/** `[personId, value]` pairs from a stored list, or undefined when it isn't one. */
function pairs(list: unknown, key: 'cents' | 'basisPoints' | 'weight') {
  if (!Array.isArray(list)) return undefined
  const read = list.map((entry: Record<string, unknown> | null) => [entry?.personId, entry?.[key]])
  return read.every(([id, value]) => typeof id === 'string' && Number.isInteger(value))
    ? (read as [string, number][])
    : undefined
}

/** In `personId` order, each once: the order the form sends, so a round trip is exact. */
const inOrder = (ids: readonly string[]) =>
  ids.every((id, i) => i === 0 || (ids[i - 1] as string) < id)

/**
 * The house expense form's values for a posted expense (#202), or undefined when its stored
 * input is one the form can't show (decision 4): a `days` split or none, an empty note, or
 * someone who isn't a member. `toHouseExpenseBody()` of the result gives the stored input back.
 */
export function toHouseExpenseValues(
  row: Pick<
    Transactions,
    'kind' | 'totalCents' | 'date' | 'description' | 'category' | 'inputJson'
  >,
  members: readonly Pick<Members, 'personId'>[],
  currency: string,
): HouseExpenseValues | undefined {
  if (row.kind !== 'expense' || row.totalCents <= 0) return undefined
  const stored = readStored(row.inputJson) as {
    payers?: unknown
    split?: StoredSplit
    note?: unknown
  }
  if (stored.note === '' || (stored.note !== undefined && typeof stored.note !== 'string')) {
    return undefined
  }
  const known = new Set(members.map((member) => member.personId))
  const everyone = (ids: readonly string[]) => ids.every((id) => known.has(id))

  const payers = pairs(stored.payers, 'cents')
  if (!payers || payers.length === 0) return undefined
  const payerIds = payers.map(([id]) => id)
  if (!everyone(payerIds) || !inOrder(payerIds)) return undefined
  const [first] = payers
  const onePayer = payers.length === 1 && first?.[1] === row.totalCents
  // Several people paid: each amount above 0, as the form asks for.
  if (!onePayer && payers.some(([, paid]) => paid <= 0)) return undefined

  const split = stored.split
  let splitMode: SplitMode
  let ids: string[]
  let parts: Record<string, string> = {}
  if (split?.mode === 'equal') {
    if (!Array.isArray(split.personIds) || !split.personIds.every((id) => typeof id === 'string')) {
      return undefined
    }
    splitMode = 'equal'
    ids = split.personIds as string[]
  } else {
    const read =
      split?.mode === 'exact'
        ? pairs(split.amounts, 'cents')?.map(([id, value]) => [id, centsToText(value, currency)])
        : split?.mode === 'percent'
          ? pairs(split.percents, 'basisPoints')?.map(([id, value]) => [
              id,
              percentText(value).replace('%', ''),
            ])
          : split?.mode === 'weights'
            ? pairs(split.weights, 'weight')?.map(([id, value]) => [id, String(value)])
            : undefined
    if (!read) return undefined
    splitMode = split?.mode as SplitMode
    ids = read.map(([id]) => id as string)
    parts = Object.fromEntries(read)
  }
  if (ids.length === 0 || !everyone(ids) || !inOrder(ids)) return undefined

  return {
    amount: centsToText(row.totalCents, currency),
    date: row.date,
    description: row.description,
    category: (row.category ?? '') as Category | '',
    paidBy: first?.[0] ?? '',
    severalPaid: !onePayer,
    paid: onePayer
      ? {}
      : Object.fromEntries(payers.map(([id, paid]) => [id, centsToText(paid, currency)])),
    splitMode,
    splitBetween: ids,
    parts,
    note: typeof stored.note === 'string' ? stored.note : '',
    // Never itemised: an itemised row has no Edit, and the edit form hides the switch. One empty
    // item keeps the values the shape a new expense has.
    itemised: false,
    items: [{ ...NEW_ITEM, excluded: [], shares: {} }],
  }
}
