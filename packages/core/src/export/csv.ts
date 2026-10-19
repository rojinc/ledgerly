import type { Groups, Profiles, Shares, Transactions } from '../generated/rows'
import { centsToDecimal } from '../money/format'
import type { BusinessDetails } from '../schemas/identity'

// The data export (#50, security-and-privacy.md#data-export): built in the browser from rows the
// user can already read.

/** A cell: text as typed, or an amount, which is never treated as a formula. */
type Cell = string | { money: string }

// A spreadsheet runs a cell starting with one of these as a formula, full-width forms included,
// and some importers trim leading spaces first.
const FORMULA = /^[\s\u00a0\u3000]*[=+\-@\uff1d\uff0b\uff0d\uff20]|^[\t\r\n]/
// RFC 4180: these make a field need quotes.
const SPECIAL = /[",\r\n]/

function field(cell: Cell): string {
  const text = typeof cell === 'string' ? (FORMULA.test(cell) ? `'${cell}` : cell) : cell.money
  return SPECIAL.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * RFC 4180 CSV with a UTF-8 byte order mark and CRLF line ends. A text cell that could start a
 * formula gets a leading `'`; an amount never does.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return `﻿${[header, ...rows].map((row) => `${row.map(field).join(',')}\r\n`).join('')}`
}

function amounts(currency: string, total: number, given: number, received: number): Cell[] {
  return [
    { money: centsToDecimal(total, currency) },
    { money: centsToDecimal(given, currency) },
    { money: centsToDecimal(received, currency) },
    // Positive is owed to them (ledger.md#balances).
    { money: centsToDecimal(given - received, currency) },
  ]
}

type ExportTransaction = Pick<
  Transactions,
  '$id' | 'date' | 'status' | 'kind' | 'description' | 'category' | 'totalCents'
>

/**
 * One group's records (F-72): a row per share, and one with empty person columns for each
 * transaction without shares. `names` is each person's display name in the group.
 */
export function groupCsv(
  currency: string,
  transactions: readonly ExportTransaction[],
  shares: readonly Pick<Shares, 'transactionId' | 'personId' | 'givenCents' | 'receivedCents'>[],
  names: ReadonlyMap<string, string>,
): string {
  const byTransaction = new Map<string, (typeof shares)[number][]>()
  for (const share of shares) {
    byTransaction.set(share.transactionId, [
      ...(byTransaction.get(share.transactionId) ?? []),
      share,
    ])
  }
  const rows: Cell[][] = []
  for (const transaction of transactions) {
    const { date, status, kind, description, category, totalCents } = transaction
    const start = [date, status, kind, description, category ?? '', currency]
    const parts = byTransaction.get(transaction.$id) ?? []
    if (parts.length === 0) {
      rows.push([...start, { money: centsToDecimal(totalCents, currency) }, '', '', '', ''])
    }
    for (const share of parts) {
      const [total, given, received, net] = amounts(
        currency,
        totalCents,
        share.givenCents,
        share.receivedCents,
      ) as [Cell, Cell, Cell, Cell]
      rows.push([...start, total, names.get(share.personId) ?? '', given, received, net])
    }
  }
  return toCsv(
    [
      'date',
      'status',
      'kind',
      'description',
      'category',
      'currency',
      'total',
      'person',
      'given',
      'received',
      'net',
    ],
    rows,
  )
}

/** One of the user's own shares, with its transaction and group. */
export type MyRecord = {
  group: Pick<Groups, 'name' | 'type' | 'currency'>
  transaction: Omit<ExportTransaction, '$id' | 'status'>
  share: Pick<Shares, 'givenCents' | 'receivedCents'>
}

/** The user's own shares across their groups (F-06), as `my-records.csv`. */
export function myRecordsCsv(records: readonly MyRecord[]): string {
  return toCsv(
    [
      'group',
      'groupType',
      'date',
      'kind',
      'description',
      'category',
      'currency',
      'total',
      'given',
      'received',
      'net',
    ],
    records.map(({ group, transaction, share }) => [
      group.name,
      group.type,
      transaction.date,
      transaction.kind,
      transaction.description,
      transaction.category ?? '',
      group.currency,
      ...amounts(group.currency, transaction.totalCents, share.givenCents, share.receivedCents),
    ]),
  )
}

/** What `profile.csv` holds: only the user's own details, never anyone else's contact details. */
export type ProfileExport = {
  name: string
  /** The account's own email and phone, if it has them. */
  email: string | null
  phone: string | null
  profile: Pick<
    Profiles,
    | 'timezone'
    | 'region'
    | 'currency'
    | 'invoicePrefix'
    | 'lastInvoiceNumber'
    | 'summaryFrequency'
    | 'hoursCapMinutes'
    | 'hoursCapPeriod'
    | 'hoursCapStartsOn'
  >
  business: BusinessDetails | null
}

/** The user's profile (F-06) as `field,value` rows; empty fields are left out. */
export function profileCsv({ name, email, phone, profile, business }: ProfileExport): string {
  const { bank, ...details } = business ?? {}
  const fields: [string, string | number | null | undefined][] = [
    ['name', name],
    ['email', email],
    ['phone', phone],
    ['timezone', profile.timezone],
    ['region', profile.region],
    ['currency', profile.currency],
    ['invoicePrefix', profile.invoicePrefix],
    ['lastInvoiceNumber', profile.lastInvoiceNumber],
    ['summaryFrequency', profile.summaryFrequency],
    ['hoursCapMinutes', profile.hoursCapMinutes],
    ['hoursCapPeriod', profile.hoursCapPeriod],
    ['hoursCapStartsOn', profile.hoursCapStartsOn],
    ...Object.entries(details).map(([key, value]): [string, string] => [`business.${key}`, value]),
    ['business.bank.accountName', bank?.accountName],
    ['business.bank.bsb', bank?.bsb],
    ['business.bank.accountNumber', bank?.accountNumber],
  ]
  return toCsv(
    ['field', 'value'],
    fields
      .filter((entry): entry is [string, string | number] => entry[1] != null && entry[1] !== '')
      .map(([key, value]) => [key, String(value)]),
  )
}
