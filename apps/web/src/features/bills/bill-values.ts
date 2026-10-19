import { CATEGORIES, type Category } from '@ledgerly/core/constants/categories'
import { endOfMonth, parseLocalDate } from '@ledgerly/core/dates/local-date'
import { parseMoney } from '@ledgerly/core/money/format'
import {
  type TransactionTemplate,
  type transactionInputSchema,
  transactionTemplateSchema,
} from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'

/** The bill form's fields, all as typed. */
export type BillValues = {
  description: string
  category: Category | ''
  amount: string
  dueOn: string
  /** Already paid: then it's stored posted, on `paidOn`. */
  paid: boolean
  paidOn: string
}

function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/**
 * `POST /transactions` and `PATCH /transactions/{id}` for a personal bill (functions-api.md#ledger).
 * A due bill is dated on its due date, as the scheduler dates them (scheduling.md); a paid one on
 * the day it was paid.
 */
export function toBillBody(
  values: BillValues,
  ids: { id: string; groupId: string },
  currency: string,
  kept: StoredExtras = {},
): z.input<typeof transactionInputSchema> {
  return {
    ...ids,
    kind: 'bill',
    description: values.description.trim(),
    ...(values.category ? { category: values.category } : {}),
    totalCents: cents(values.amount, currency),
    ...(kept.split ? { split: kept.split } : {}),
    ...(kept.note ? { note: kept.note } : {}),
    ...(values.paid
      ? { date: values.paidOn, bill: { status: 'paid' as const } }
      : {
          date: values.dueOn,
          bill: { status: 'due' as const, dueOn: values.dueOn, ...kept.period },
        }),
  }
}

/** What a stored bill keeps that the form doesn't show, so a PATCH doesn't drop it. */
export type StoredExtras = {
  /** Who paid: without it, an edit would make the editor the payer (#44). */
  payers?: TransactionTemplate['payers']
  split?: TransactionTemplate['split']
  note?: string
  period?: { periodStart?: string; periodEnd?: string }
}

/**
 * The payers, split, note and billing period from a bill's `inputJson`, which the ledger stores
 * without the bill's status, due date or category (those are columns). Anything unreadable is left
 * out.
 */
export function storedExtras(inputJson: string): StoredExtras {
  try {
    const stored = JSON.parse(inputJson) as {
      payers?: unknown
      split?: unknown
      note?: unknown
      bill?: { periodStart?: unknown; periodEnd?: unknown }
    } | null
    const payers = transactionTemplateSchema.shape.payers.safeParse(stored?.payers)
    const split = transactionTemplateSchema.shape.split.safeParse(stored?.split)
    const { periodStart, periodEnd } = stored?.bill ?? {}
    return {
      ...(payers.success && payers.data ? { payers: payers.data } : {}),
      ...(split.success && split.data ? { split: split.data } : {}),
      ...(typeof stored?.note === 'string' && stored.note !== '' ? { note: stored.note } : {}),
      ...(typeof periodStart === 'string' && typeof periodEnd === 'string'
        ? { period: { periodStart, periodEnd } }
        : {}),
    }
  } catch {
    return {}
  }
}

/** The form's values for a stored due bill, from its columns. */
export function toBillValues(
  row: { description: string; date: string; dueOn: string | null; category: string | null },
  amountText: string,
): BillValues {
  return {
    description: row.description,
    category: CATEGORIES.find((category) => category === row.category) ?? '',
    amount: amountText,
    dueOn: row.dueOn ?? row.date,
    paid: false,
    paidOn: '',
  }
}

/** Due before today, in the group's time zone. */
export function isOverdue(dueOn: string, today: string): boolean {
  return dueOn < today
}

/** The same day `months` months earlier, or that month's last day if it's shorter. */
export function monthsBefore(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const total = year * 12 + (month - 1) - months
  const first = `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`
  const last = endOfMonth(parseLocalDate(first))
  return Number(last.slice(8)) < day ? last : `${first.slice(0, 8)}${String(day).padStart(2, '0')}`
}
