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
import { type Models, Query } from 'appwrite'
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

/**
 * A group's records dated `start` to `end` (both included) as CSV (F-72): its transactions on
 * `idx_group_date`, their shares on `idx_transactionId`, and the members' names in the group.
 * Only reads what the caller's team membership already lets them read; nothing is written.
 */
export async function groupExport(
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

/** `profile.csv`: the stored business details, if they read, with the rest of the profile. */
export function profileExport({
  businessJson,
  ...input
}: Omit<ProfileExport, 'business'> & { businessJson: string | null }): string {
  let business: ProfileExport['business'] = null
  try {
    const parsed = businessDetailsSchema.safeParse(JSON.parse(businessJson ?? 'null'))
    business = parsed.success ? parsed.data : null
  } catch {
    business = null
  }
  return profileCsv({ ...input, business })
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
