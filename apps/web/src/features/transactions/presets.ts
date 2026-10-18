import type { Category } from '@ledgerly/core/constants/categories'
import { parseMoney } from '@ledgerly/core/money/format'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'

/** What an employer entry records (ledger.md#employer-presets; user-flows.md#4). */
export type EntryType = 'reimbursable' | 'onTheirCard' | 'personalOnTheirCard' | 'paymentReceived'

export const ENTRY_TYPES: { value: EntryType; label: string; effect: string }[] = [
  {
    value: 'reimbursable',
    label: 'I paid for them (reimbursable)',
    effect: 'They owe you this amount more.',
  },
  {
    value: 'onTheirCard',
    label: 'Bought on their card, for work',
    effect: 'No change to the balance; it’s listed on the invoice.',
  },
  {
    value: 'personalOnTheirCard',
    label: 'Personal, on their card / cash advance',
    effect: 'They owe you this amount less.',
  },
  { value: 'paymentReceived', label: 'Payment received', effect: 'They owe you this amount less.' },
]

/** The entry form's fields, all as typed. */
export type EntryValues = {
  type: EntryType
  amount: string
  date: string
  description: string
  category: Category | ''
  note: string
}

/** The two people in an employer group: the worker it pays (its owner) and the employer. */
export type EmployerPeople = { worker: string; employer: string }

function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/**
 * `POST /transactions` for an employer entry: presets are ordinary expenses (payers and an
 * equal split of one), and a payment received goes from the employer to the worker. NaN makes
 * the schema refuse an amount that isn't one.
 */
export function toEntryBody(
  values: EntryValues,
  ids: { id: string; groupId: string },
  currency: string,
  { worker, employer }: EmployerPeople,
): z.input<typeof transactionInputSchema> {
  const totalCents = cents(values.amount, currency)
  const common = {
    ...ids,
    date: values.date,
    description: values.description.trim(),
    totalCents,
    ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
  }
  if (values.type === 'paymentReceived') {
    return {
      ...common,
      kind: 'payment',
      payment: { fromPersonId: employer, toPersonId: worker },
    }
  }
  // Who paid, and who the purchase was for.
  const [payer, forWhom] =
    values.type === 'reimbursable'
      ? [worker, employer]
      : values.type === 'onTheirCard'
        ? [employer, employer]
        : [employer, worker]
  return {
    ...common,
    kind: 'expense',
    ...(values.category === '' ? {} : { category: values.category }),
    payers: [{ personId: payer, cents: totalCents }],
    split: { mode: 'equal', personIds: [forWhom] },
  }
}
