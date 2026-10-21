import type { LocalDate } from '@ledgerly/core/dates/local-date'
import {
  groupCsv,
  type MyRecord,
  myRecordsCsv,
  type ProfileExport,
  profileCsv,
} from '@ledgerly/core/export/csv'
import type { Groups, Members, Shares, Transactions } from '@ledgerly/core/generated/rows'
import { businessDetailsSchema } from '@ledgerly/core/schemas/identity'
import { AppwriteException, type Models, Query } from 'appwrite'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'

// Appwrite's limit for one page and for the values of one Query.equal.
const PAGE = 100

// Only the columns the files need.
const TRANSACTION_COLUMNS = [
  '$id',
  'groupId',
  'date',
  'status',
  'kind',
  'description',
  'category',
  'totalCents',
]
const SHARE_COLUMNS = ['$id', 'transactionId', 'personId', 'groupId', 'givenCents', 'receivedCents']
const MEMBER_COLUMNS = ['$id', 'groupId', 'personId', 'displayName']

// Whole reads before giving up, whatever made each one start again, as balances.ts does.
const TRIES = 3

/**
 * `read`'s answer, or undefined when a write between pages deleted the row a cursor points at:
 * reading again from the start fixes that. Any other error, a lost group included, is thrown.
 */
async function unlessCursorLost<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof AppwriteException && error.type === 'general_cursor_not_found') {
      return undefined
    }
    throw error
  }
}

/** Every row `queries` match, in cursor pages of 100 (scaling.md#appwrite-limits-we-design-around). */
async function listAll<T extends Models.Row>(tableId: string, queries: string[]): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await tablesDB.listRows<T>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        ...queries,
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
    })
    rows.push(...page.rows)
    if (page.rows.length < PAGE) return rows
    cursor = page.rows.at(-1)?.$id
  }
}

/** `listAll` of `columns` for each chunk of 100 `values` of `column`. */
async function listIn<T extends Models.Row>(
  tableId: string,
  column: string,
  values: readonly string[],
  columns: string[],
): Promise<T[]> {
  const rows: T[] = []
  for (let index = 0; index < values.length; index += PAGE) {
    rows.push(
      ...(await listAll<T>(tableId, [
        Query.equal(column, values.slice(index, index + PAGE)),
        Query.select(columns),
      ])),
    )
  }
  return rows
}

async function groupRev(groupId: string): Promise<string | null> {
  const row = await tablesDB.getRow<Groups>({
    databaseId: DATABASE_ID,
    tableId: 'groups',
    rowId: groupId,
    queries: [Query.select(['$id', 'rev'])],
  })
  return row.rev
}

/**
 * A group's records dated `start` to `end` (both included) as CSV (F-72): its transactions on
 * `idx_group_date`, their shares on `idx_transactionId`, and the members' names in the group.
 * Every ledger write changes the group's `rev` (ledger.md#concurrency), so the pages are one
 * consistent read when `rev` is the same before and after. A changed `rev` or a lost cursor reads
 * again, up to 3 reads in all. Only reads what the caller's team membership already lets them read.
 */
export async function groupExport(
  group: Pick<Groups, '$id' | 'currency'>,
  start: LocalDate,
  end: LocalDate,
): Promise<string> {
  for (let tries = 0; tries < TRIES; tries++) {
    const before = await groupRev(group.$id)
    const csv = await unlessCursorLost(() => readGroup(group, start, end))
    if (csv !== undefined && before === (await groupRev(group.$id))) return csv
  }
  throw new Error('The group kept changing while it was read')
}

/**
 * The dates of a group's first and last transactions, on `idx_group_date`, or null when it has
 * none: a delete screen's Export link offers them, so nothing is left out before the delete (#535).
 */
export async function groupDates(groupId: string): Promise<{ first: string; last: string } | null> {
  const [first, last] = await Promise.all(
    [Query.orderAsc('date'), Query.orderDesc('date')].map(async (order) => {
      const { rows } = await tablesDB.listRows<Transactions>({
        databaseId: DATABASE_ID,
        tableId: 'transactions',
        queries: [
          Query.equal('groupId', groupId),
          Query.select(['$id', 'date']),
          order,
          Query.limit(1),
        ],
      })
      return rows[0]?.date
    }),
  )
  return first && last ? { first, last } : null
}

async function readGroup(
  group: Pick<Groups, '$id' | 'currency'>,
  start: LocalDate,
  end: LocalDate,
): Promise<string> {
  const transactions = await listAll<Transactions>('transactions', [
    Query.equal('groupId', group.$id),
    Query.greaterThanEqual('date', start),
    Query.lessThanEqual('date', end),
    Query.select(TRANSACTION_COLUMNS),
    Query.orderAsc('date'),
  ])
  const shares = await listIn<Shares>(
    'shares',
    'transactionId',
    transactions.map((transaction) => transaction.$id),
    SHARE_COLUMNS,
  )
  const members = await listAll<Members>('members', [
    Query.equal('groupId', group.$id),
    Query.select(MEMBER_COLUMNS),
  ])
  const names = new Map(members.map((member) => [member.personId, member.displayName]))
  return groupCsv(group.currency, transactions, shares, names)
}

/**
 * The user's own shares across `groups` as `my-records.csv` (F-06): their shares on
 * `idx_person_date`, with each share's transaction. A share in a group they can no longer read
 * isn't in `groups`, so it's left out. A pair group is named by its other member, as the app
 * shows it (#145): its own `name` is its creator's label, which may be the user.
 */
export async function myRecordsExport(
  personId: string,
  groups: readonly Groups[],
): Promise<string> {
  // Shares span groups, so there's no one `rev` to check: only a lost cursor reads again.
  for (let tries = 0; tries < TRIES; tries++) {
    const csv = await unlessCursorLost(() => readMyRecords(personId, groups))
    if (csv !== undefined) return csv
  }
  throw new Error('Your shares kept changing while they were read')
}

async function readMyRecords(personId: string, groups: readonly Groups[]): Promise<string> {
  const shares = await listAll<Shares>('shares', [
    Query.equal('personId', personId),
    Query.select(SHARE_COLUMNS),
    Query.orderAsc('date'),
  ])
  const transactions = new Map(
    (
      await listIn<Transactions>(
        'transactions',
        '$id',
        [...new Set(shares.map((share) => share.transactionId))],
        TRANSACTION_COLUMNS,
      )
    ).map((transaction) => [transaction.$id, transaction]),
  )
  const used = new Set(shares.map((share) => share.groupId))
  const pairs = groups.filter((group) => group.type === 'pair' && used.has(group.$id))
  const others = new Map(
    (
      await listIn<Members>(
        'members',
        'groupId',
        pairs.map((group) => group.$id),
        MEMBER_COLUMNS,
      )
    )
      .filter((member) => member.personId !== personId)
      .map((member) => [member.groupId, member.displayName]),
  )
  const byId = new Map(
    groups.map((group) => [group.$id, { ...group, name: others.get(group.$id) ?? group.name }]),
  )
  const records: MyRecord[] = []
  for (const share of shares) {
    const group = byId.get(share.groupId)
    const transaction = transactions.get(share.transactionId)
    if (group && transaction) records.push({ group, transaction, share })
  }
  return myRecordsCsv(records)
}

// The business details' fields and the bank's, from the schema, so a field added there is
// exported too. Taking one out of the schema stops its stored value being exported: that's a
// contract change (AGENTS.md), so say so there.
const BUSINESS_FIELDS = Object.keys(businessDetailsSchema.shape).filter((key) => key !== 'bank')
const BANK_FIELDS = Object.keys(businessDetailsSchema.shape.bank.unwrap().shape)

/** Each of `fields` that `value` holds as text. */
function texts(value: unknown, fields: string[]): Record<string, string> {
  // A field of a string or a number is undefined too.
  const object = (value ?? {}) as Record<string, unknown>
  return Object.fromEntries(
    fields.flatMap((field) => {
      const text = object[field]
      return typeof text === 'string' ? [[field, text]] : []
    }),
  )
}

/**
 * `profile.csv`: the stored business details with the rest of the profile. They're read field by
 * field, keeping only text, so a value that a later schema would refuse doesn't drop every other
 * one (#535).
 */
export function profileExport({
  businessJson,
  ...input
}: Omit<ProfileExport, 'business'> & { businessJson: string | null }): string {
  let stored: unknown = null
  try {
    stored = JSON.parse(businessJson ?? 'null')
  } catch {
    stored = null
  }
  const bank = (stored as { bank?: unknown } | null)?.bank
  return profileCsv({
    ...input,
    business: { ...texts(stored, BUSINESS_FIELDS), bank: texts(bank, BANK_FIELDS) },
  })
}

/** A link target for `csv`, in the browser only: nothing is uploaded. Revoke it when done. */
export function fileUrl(csv: string): string {
  return URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
}

// Long enough for any browser to have read the file: some cancel a download whose URL goes.
const KEEP_URL_MS = 60_000

/** Saves `csv` as `name` through the browser; nothing is uploaded. */
export function download(name: string, csv: string) {
  const url = fileUrl(csv)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS)
}
