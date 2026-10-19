import type { Transactions } from '@ledgerly/core/generated/rows'
import { formatMoney, parseMoney } from '@ledgerly/core/money/format'
import type { createGroupBodySchema } from '@ledgerly/core/schemas/groups'
import type { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import type { z } from 'zod'
import { centsToText } from '../groups/employer-form'
import { readStored } from '../transactions/presets'

/** The new lend & borrow form's fields, all as typed. */
export type PairValues = { name: string; email: string; phone: string; currency: string }

/** `groups POST /groups` for a pair group: the counterpart is always a placeholder (D-016). */
export function toPairBody(values: PairValues, id: string): z.input<typeof createGroupBodySchema> {
  const name = values.name.trim()
  const email = values.email.trim()
  const phone = values.phone.trim()
  return {
    id,
    type: 'pair',
    name,
    currency: values.currency.trim().toUpperCase(),
    counterpart: {
      displayName: name,
      ...(email === '' ? {} : { email }),
      ...(phone === '' ? {} : { phone }),
    },
  }
}

/** What an entry records (ledger.md#transaction-kinds: `loan` and `payment`). */
export type EntryType = 'lent' | 'borrowed' | 'repaid'

/** The entry form's fields, all as typed. `from` is who repaid, for a repayment. */
export type EntryValues = {
  type: EntryType
  amount: string
  date: string
  description: string
  note: string
  from: 'me' | 'them'
}

/** The two people in a pair group, by person ID. */
export type PairPeople = { me: string; them: string }

/** What a blank description becomes, so the schema's required description is never a chore. */
export const DEFAULT_DESCRIPTION: Record<EntryType, string> = {
  lent: 'Lent',
  borrowed: 'Borrowed',
  repaid: 'Repaid',
}

/** Integer cents, or NaN for text that isn't an amount, so the schema refuses it. */
export function cents(text: string, currency: string): number {
  try {
    return parseMoney(text.trim(), currency)
  } catch {
    return Number.NaN
  }
}

/**
 * `ledger POST /transactions` for an entry. Lent and borrowed are a `loan`: the lender pays, the
 * borrower gets it all. Repaid is a `payment` from the one who repaid to the other, with no payers.
 */
export function toEntryBody(
  values: EntryValues,
  ids: { id: string; groupId: string },
  currency: string,
  { me, them }: PairPeople,
): z.input<typeof transactionInputSchema> {
  const totalCents = cents(values.amount, currency)
  const common = {
    ...ids,
    date: values.date,
    description: values.description.trim() || DEFAULT_DESCRIPTION[values.type],
    totalCents,
    ...(values.note.trim() === '' ? {} : { note: values.note.trim() }),
  }
  if (values.type === 'repaid') {
    const [from, to] = values.from === 'me' ? [me, them] : [them, me]
    return { ...common, kind: 'payment', payment: { fromPersonId: from, toPersonId: to } }
  }
  const [lender, borrower] = values.type === 'lent' ? [me, them] : [them, me]
  return {
    ...common,
    kind: 'loan',
    payers: [{ personId: lender, cents: totalCents }],
    split: { mode: 'equal', personIds: [borrower] },
  }
}

/**
 * The entry form's values for a posted pair entry (#184), or undefined when its stored input
 * matches none of the choices. `toEntryBody()` of the result gives the stored input back.
 */
export function toPairValues(
  row: Pick<Transactions, 'kind' | 'totalCents' | 'date' | 'description' | 'inputJson'>,
  { me, them }: PairPeople,
  currency: string,
): EntryValues | undefined {
  const { payers, split, payment, note } = readStored(row.inputJson)
  let choice: Pick<EntryValues, 'type' | 'from'> | undefined
  if (row.kind === 'payment') {
    if (payment?.fromPersonId === me && payment.toPersonId === them) {
      choice = { type: 'repaid', from: 'me' }
    } else if (payment?.fromPersonId === them && payment.toPersonId === me) {
      choice = { type: 'repaid', from: 'them' }
    }
  } else if (
    row.kind === 'loan' &&
    payers?.length === 1 &&
    payers[0]?.cents === row.totalCents &&
    split?.mode === 'equal' &&
    split.personIds?.length === 1
  ) {
    const lender = payers[0].personId
    const borrower = split.personIds[0]
    if (lender === me && borrower === them) choice = { type: 'lent', from: 'them' }
    else if (lender === them && borrower === me) choice = { type: 'borrowed', from: 'them' }
  }
  if (!choice) return undefined
  return {
    ...choice,
    amount: centsToText(row.totalCents, currency),
    date: row.date,
    description: row.description,
    note: typeof note === 'string' ? note : '',
  }
}

/**
 * The balance from the viewer's side: `net` is their own `netCents` from `/balances`, so above 0
 * the other person owes them.
 */
export function balanceText(net: number, name: string, currency: string): string {
  const amount = formatMoney(Math.abs(net), currency)
  return net > 0
    ? `${name} owes you ${amount}`
    : net < 0
      ? `You owe ${name} ${amount}`
      : 'All square'
}

/** Who repays by default: the one who owes. With nothing owed, the other person. */
export function debtor(net: number): EntryValues['from'] {
  return net < 0 ? 'me' : 'them'
}

/** What the one repaying owes the other, in cents: 0 when they owe nothing. */
export function owedBy(from: EntryValues['from'], net: number): number {
  return Math.max(0, from === 'them' ? net : -net)
}
