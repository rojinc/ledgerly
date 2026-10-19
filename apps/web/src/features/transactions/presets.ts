import type { Category } from '@ledgerly/core/constants/categories'
import type { Transactions } from '@ledgerly/core/generated/rows'
import { parseMoney } from '@ledgerly/core/money/format'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'
import { centsToText } from '../groups/employer-form'

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

/** An amount as typed, in cents, or NaN when it isn't one. */
export function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/** An amount as typed in this currency: `40.50`, or `4050` for one without cents. */
export function amountExample(currency: string): string {
  return centsToText(4050, currency)
}

/**
 * The amount field's error in plain words, or undefined. `schemaRefused`: the schema refused the
 * body's `totalCents`.
 */
export function amountError(
  text: string,
  totalCents: number | undefined,
  schemaRefused: boolean,
  currency: string,
): string | undefined {
  if (text.trim() === '') return 'Required'
  if (schemaRefused || Number.isNaN(totalCents)) {
    return `Enter an amount like ${amountExample(currency)}`
  }
  if (typeof totalCents === 'number' && totalCents <= 0) return 'Enter an amount above 0'
  return undefined
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

/** The parts of a stored input (`transactions.inputJson`) an entry's choice comes from. */
type StoredEntry = {
  payers?: { personId: string; cents: number }[]
  split?: { mode?: string; personIds?: string[] }
  payment?: { fromPersonId: string; toPersonId: string }
  note?: string
}

/** The stored input, or an empty one when it can't be read. */
export function readStored(inputJson: string): StoredEntry {
  try {
    const stored = JSON.parse(inputJson) as StoredEntry | null
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}

/**
 * The entry form's values for a posted employer entry (#184), or undefined when its stored input
 * matches none of the choices: then it can't be changed here, since guessing would rewrite who
 * paid. `toEntryBody()` of the result gives the stored input back.
 */
export function toEntryValues(
  row: Pick<
    Transactions,
    'kind' | 'totalCents' | 'date' | 'description' | 'category' | 'inputJson'
  >,
  { worker, employer }: EmployerPeople,
  currency: string,
): EntryValues | undefined {
  const stored = readStored(row.inputJson)
  const type = entryType(row.kind, row.totalCents, stored, { worker, employer })
  // A payment has no category in the form, and the form leaves out an empty note: saving would
  // drop either.
  if (!type || (type === 'paymentReceived' && row.category !== null) || stored.note === '') {
    return undefined
  }
  return {
    type,
    amount: centsToText(row.totalCents, currency),
    date: row.date,
    description: row.description,
    category: (row.category ?? '') as Category | '',
    note: typeof stored.note === 'string' ? stored.note : '',
  }
}

function entryType(
  kind: Transactions['kind'],
  totalCents: number,
  { payers, split, payment }: StoredEntry,
  { worker, employer }: EmployerPeople,
): EntryType | undefined {
  if (kind === 'payment') {
    return payment?.fromPersonId === employer && payment.toPersonId === worker
      ? 'paymentReceived'
      : undefined
  }
  if (kind !== 'expense' || payers?.length !== 1 || payers[0]?.cents !== totalCents)
    return undefined
  if (split?.mode !== 'equal' || split.personIds?.length !== 1) return undefined
  const paidBy = payers[0].personId
  const forWhom = split.personIds[0]
  if (paidBy === worker && forWhom === employer) return 'reimbursable'
  if (paidBy === employer && forWhom === employer) return 'onTheirCard'
  if (paidBy === employer && forWhom === worker) return 'personalOnTheirCard'
  return undefined
}
