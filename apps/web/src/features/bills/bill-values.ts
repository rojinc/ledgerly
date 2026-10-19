import type { Category } from '@ledgerly/core/constants/categories'
import { endOfMonth, parseLocalDate } from '@ledgerly/core/dates/local-date'
import { parseMoney } from '@ledgerly/core/money/format'
import type { TransactionTemplate, transactionInputSchema } from '@ledgerly/core/schemas/ledger'
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
): z.input<typeof transactionInputSchema> {
  return {
    ...ids,
    kind: 'bill',
    description: values.description.trim(),
    ...(values.category ? { category: values.category } : {}),
    totalCents: cents(values.amount, currency),
    ...(values.paid
      ? { date: values.paidOn, bill: { status: 'paid' as const } }
      : { date: values.dueOn, bill: { status: 'due' as const, dueOn: values.dueOn } }),
  }
}

/** The form's values for a stored due bill. */
export function toBillValues(
  row: { description: string; date: string; dueOn: string | null },
  stored: TransactionTemplate,
  amountText: string,
): BillValues {
  return {
    description: row.description,
    category: stored.category ?? '',
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
