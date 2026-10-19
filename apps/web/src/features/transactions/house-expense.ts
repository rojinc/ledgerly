import type { Category } from '@ledgerly/core/constants/categories'
import { isLocalDate, type LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { buildShares, type Share } from '@ledgerly/core/ledger/build-shares'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'
import { cents } from './presets'

/** The house expense form's fields, as typed (#180). */
export type HouseExpenseValues = {
  amount: string
  date: string
  description: string
  category: Category | ''
  /** The person who paid it all. */
  paidBy: string
  /** The people it's split equally between, in any order. */
  splitBetween: string[]
  note: string
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

/**
 * `POST /transactions` for a house expense, always with its payer and split (#180 decision 4).
 * `personIds` go in `personId` order, as the default split does, so leftover cents land the same
 * way. NaN makes the schema refuse an amount that isn't one.
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
    payers: [{ personId: values.paidBy, cents: totalCents }],
    split: { mode: 'equal', personIds: [...new Set(values.splitBetween)].sort() },
  }
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
