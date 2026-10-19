import { CATEGORIES, type Category } from '@ledgerly/core/constants/categories'
import { MAX_PEOPLE_PER_TRANSACTION, MAX_WEIGHT } from '@ledgerly/core/constants/limits'
import {
  compareDates,
  daysBetween,
  isLocalDate,
  type LocalDate,
} from '@ledgerly/core/dates/local-date'
import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { buildShares } from '@ledgerly/core/ledger/build-shares'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { daysPresent, type LedgerMember } from '@ledgerly/core/ledger/split-amount'
import type { GroupSettings } from '@ledgerly/core/schemas/groups'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'
import { cents } from '../transactions/presets'
import type { StoredExtras } from './bill-values'

/**
 * How a house bill is split (ledger.md#days-present, #default-split): everyone by days present,
 * some people by days present, or, in a house whose default is `equal`, everyone present equally.
 * `kept`: a stored split this form can't show (exact amounts, say), sent back as it is.
 */
export type SplitChoice = 'days' | 'someDays' | 'equal' | 'kept'

/** The house bill form's fields, as typed (#44). */
export type HouseBillValues = {
  description: string
  category: Category | ''
  amount: string
  periodStart: string
  periodEnd: string
  dueOn: string
  /** Already paid: then it's stored posted, on `paidOn`, paid by `paidBy`. */
  paid: boolean
  paidOn: string
  paidBy: string
  split: SplitChoice
  /** The people a `someDays` split names, in any order. */
  splitPeople: string[]
}

type Body = z.input<typeof transactionInputSchema>

/** The house's default for bills that name no split (data-model.md#groups). */
export function defaultBillSplit(group: Pick<Groups, 'settingsJson'>): 'days' | 'equal' {
  try {
    const settings = JSON.parse(group.settingsJson) as GroupSettings
    return settings.type === 'house' ? settings.defaultBillSplit : 'days'
  } catch {
    return 'days'
  }
}

/**
 * `POST /transactions` and `PATCH /transactions/{id}` for a house bill. A due bill is dated on its
 * due date, as schedule occurrences are; a paid one on the day it was paid, with who paid it all.
 * "Everyone present, equally" names no split, so the ledger's default split applies.
 */
export function toHouseBillBody(
  values: HouseBillValues,
  ids: { id: string; groupId: string },
  currency: string,
  kept: StoredExtras = {},
): Body {
  const totalCents = cents(values.amount, currency)
  const period = { periodStart: values.periodStart, periodEnd: values.periodEnd }
  const payers = keptPayers(kept.payers, totalCents)
  return {
    ...ids,
    kind: 'bill',
    description: values.description.trim(),
    ...(values.category ? { category: values.category } : {}),
    totalCents,
    ...(kept.note ? { note: kept.note } : {}),
    ...(values.split === 'days' ? { split: { mode: 'days' as const } } : {}),
    ...(values.split === 'someDays'
      ? { split: { mode: 'days' as const, personIds: [...new Set(values.splitPeople)].sort() } }
      : {}),
    ...(values.split === 'kept' && kept.split ? { split: kept.split } : {}),
    ...(values.paid
      ? {
          date: values.paidOn,
          bill: { status: 'paid' as const, ...period },
          payers: [{ personId: values.paidBy, cents: totalCents }],
        }
      : {
          date: values.dueOn,
          bill: { status: 'due' as const, dueOn: values.dueOn, ...period },
          // An edit sends back who paid, so the ledger never makes the editor the payer.
          ...(payers ? { payers } : {}),
        }),
  }
}

/**
 * The stored payers for a new total: one payer pays it all, whatever it now is. Several are sent
 * as stored, and refused by the preview unless they still add up (the form can't show them).
 */
function keptPayers(payers: StoredExtras['payers'], totalCents: number) {
  const [only] = payers ?? []
  return payers?.length === 1 && only ? [{ personId: only.personId, cents: totalCents }] : payers
}

/** One person's line in the preview: their days in the period, and their part of the bill. */
export type PreviewLine = { personId: string; days: number; shareCents: number }

export const NOBODY_PRESENT =
  'Nobody lived here during this period. Check the dates, or the move-in dates on the house page.'

/**
 * Each person's days in the period, from core `daysPresent()`, and their part, from core
 * `buildShares()`, exactly as the ledger function will work it out (the client never divides
 * money or counts days). Or why the bill can't be split, in plain words. Undefined until the
 * amount and both period dates are there to work with.
 */
export function previewHouseBill(
  body: Body,
  group: Pick<Groups, 'ownerPersonId' | 'settingsJson'>,
  members: readonly Members[],
  callerPersonId: string,
): { lines: PreviewLine[] } | { error: string } | undefined {
  const { periodStart, periodEnd } = body.bill ?? {}
  const totalCents = body.totalCents
  if (!isLocalDate(periodStart) || !isLocalDate(periodEnd) || !isLocalDate(body.date)) return
  if (typeof totalCents !== 'number' || !Number.isInteger(totalCents) || totalCents <= 0) return
  if (compareDates(periodEnd, periodStart) < 0) {
    return { error: 'The period can’t end before it starts.' }
  }
  const paid = (body.payers ?? []).reduce((sum, payer) => sum + payer.cents, 0)
  if (body.payers && paid !== totalCents) {
    return {
      error:
        'Several people paid this bill, so its amount can’t change here. Skip it and add it again.',
    }
  }
  // Day counts are allocate() weights (ledger.md#days-present).
  if (daysBetween(periodStart, periodEnd) >= MAX_WEIGHT) {
    return { error: `A bill’s period can be at most ${MAX_WEIGHT} days.` }
  }
  // Members' dates are stored as YYYY-MM-DD.
  const ledgerMembers: LedgerMember[] = members.map((member) => ({
    personId: member.personId,
    joinedOn: member.joinedOn as LocalDate,
    leftOn: member.leftOn as LocalDate | null,
  }))
  const named = body.split?.mode === 'days' ? body.split.personIds : undefined
  if (named?.length === 0) return { error: 'Tick at least one person to split it between.' }
  const sharing = named
    ? ledgerMembers.filter((member) => named.includes(member.personId))
    : ledgerMembers
  const period = { start: periodStart, end: periodEnd }
  const days = new Map(sharing.map((member) => [member.personId, daysPresent(member, period)]))
  const present = [...days].filter(([, count]) => count > 0).map(([personId]) => personId)
  if (present.length === 0) return { error: NOBODY_PRESENT }
  const people = new Set([...present, ...(body.payers ?? []).map((payer) => payer.personId)])
  if (people.size > MAX_PEOPLE_PER_TRANSACTION) {
    return { error: `At most ${MAX_PEOPLE_PER_TRANSACTION} people can be in one bill.` }
  }
  try {
    const { shares } = buildShares(
      {
        kind: 'bill',
        date: body.date,
        totalCents,
        ...(body.payers ? { payers: body.payers } : {}),
        ...(body.split ? { split: body.split } : {}),
        bill: { status: 'paid', periodStart, periodEnd },
      },
      {
        groupType: 'house',
        ownerPersonId: group.ownerPersonId,
        callerPersonId,
        members: ledgerMembers,
        defaultBillSplit: defaultBillSplit(group),
      },
    )
    const parts = new Map(shares.map((share) => [share.personId, share.receivedCents]))
    // In the members' order, which the form sorts by name.
    return {
      lines: sharing.map((member) => ({
        personId: member.personId,
        days: days.get(member.personId) ?? 0,
        shareCents: parts.get(member.personId) ?? 0,
      })),
    }
  } catch (error) {
    if (error instanceof LedgerError) return { error: error.message }
    throw error
  }
}

/** The form's values for a new house bill: due today, everyone by the house's default split. */
export function newHouseBillValues(
  today: string,
  personId: string,
  split: 'days' | 'equal',
): HouseBillValues {
  return {
    description: '',
    category: '',
    amount: '',
    periodStart: '',
    periodEnd: '',
    dueOn: today,
    paid: false,
    paidOn: today,
    paidBy: personId,
    split,
    splitPeople: [],
  }
}

/**
 * The form's values for a stored due house bill, from its columns and stored input. A bill that
 * names no split has the house's default.
 */
export function toHouseBillValues(
  row: { description: string; date: string; dueOn: string | null; category: string | null },
  amountText: string,
  kept: StoredExtras,
  personId: string,
  houseDefault: 'days' | 'equal',
): HouseBillValues {
  const named = kept.split?.mode === 'days' ? kept.split.personIds : undefined
  const split: SplitChoice = !kept.split
    ? houseDefault
    : kept.split.mode !== 'days'
      ? 'kept'
      : named
        ? 'someDays'
        : 'days'
  return {
    description: row.description,
    category: CATEGORIES.find((category) => category === row.category) ?? '',
    amount: amountText,
    periodStart: kept.period?.periodStart ?? '',
    periodEnd: kept.period?.periodEnd ?? '',
    dueOn: row.dueOn ?? row.date,
    paid: false,
    paidOn: '',
    paidBy: personId,
    split,
    splitPeople: named ?? [],
  }
}
