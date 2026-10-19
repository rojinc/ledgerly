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

/** `listAll` for each chunk of 100 `values` of `column`. */
async function listIn<T extends Models.Row>(
  tableId: string,
  column: string,
  values: readonly string[],
): Promise<T[]> {
  const rows: T[] = []
  for (let index = 0; index < values.length; index += PAGE) {
    rows.push(
      ...(await listAll<T>(tableId, [Query.equal(column, values.slice(index, index + PAGE))])),
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
    Query.orderAsc('date'),
  ])
  const shares = await listIn<Shares>(
    'shares',
    'transactionId',
    transactions.map((transaction) => transaction.$id),
  )
  const members = await listAll<Members>('members', [Query.equal('groupId', group.$id)])
  const names = new Map(members.map((member) => [member.personId, member.displayName]))
  return groupCsv(group.currency, transactions, shares, names)
}

/**
 * The user's own shares across `groups` as `my-records.csv` (F-06): their shares on
 * `idx_person_date`, with each share's transaction. A share in a group they can no longer read
 * isn't in `groups`, so it's left out.
 */
export async function myRecordsExport(
  personId: string,
  groups: readonly Groups[],
): Promise<string> {
  const shares = await listAll<Shares>('shares', [
    Query.equal('personId', personId),
    Query.orderAsc('date'),
  ])
  const transactions = new Map(
    (
      await listIn<Transactions>('transactions', '$id', [
        ...new Set(shares.map((share) => share.transactionId)),
      ])
    ).map((transaction) => [transaction.$id, transaction]),
  )
  const byId = new Map(groups.map((group) => [group.$id, group]))
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

/** Saves `csv` as `name` through the browser; nothing is uploaded. */
export function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // After the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
