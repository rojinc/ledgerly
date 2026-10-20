import type { Category } from '@ledgerly/core/constants/categories'
import type { Groups, Items, Members, Shares, Transactions } from '@ledgerly/core/generated/rows'
import type {
  TransactionInput,
  TransactionView,
  VoidTransactionBody,
} from '@ledgerly/core/schemas/ledger'
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Query } from 'appwrite'
import { callFunction, type ErrorCode, type Method } from '../../lib/api'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { writeErrorMessage } from '../groups/archive-group'
import type { EmployerPeople } from './presets'

// Appwrite's limit for one page.
const PAGE = 100
/** History rows per page. */
export const HISTORY_PAGE = 25
/** The columns a history row shows. */
const HISTORY_COLUMNS = ['$id', 'groupId', 'kind', 'status', 'date', 'description', 'totalCents']
export type HistoryRow = Pick<
  Transactions,
  '$id' | 'groupId' | 'kind' | 'status' | 'date' | 'description' | 'totalCents'
>

/** Calls the ledger function; a refusal throws its message in plain words (#37). */
export async function ledger<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const result = await callFunction<T>('ledger', method, path, body)
  if (!result.ok) throw new LedgerError(result.error.code, writeErrorMessage(result.error))
  return result.data
}

/** A ledger refusal, keeping its code so a page can say more than the message. */
export class LedgerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Every member row of a group, readable by its team, by name. */
export function useMembers(groupId: string) {
  return useQuery({
    queryKey: queryKeys.members(groupId),
    enabled: groupId !== '',
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Members>({
        databaseId: DATABASE_ID,
        tableId: 'members',
        queries: [Query.equal('groupId', groupId), Query.limit(PAGE)],
      })
      return rows
    },
  })
}

/**
 * The worker (the group's owner, whom shifts pay) and the employer (the other member) of an
 * employer group, or undefined until both are known.
 */
export function employerPeople(
  group: Groups,
  members: Members[] | undefined,
): EmployerPeople | undefined {
  const employer = members?.find((member) => member.personId !== group.ownerPersonId)
  return employer ? { worker: group.ownerPersonId, employer: employer.personId } : undefined
}

export function useTransaction(id: string) {
  return useQuery({
    queryKey: queryKeys.transaction(id),
    queryFn: () =>
      tablesDB.getRow<Transactions>({
        databaseId: DATABASE_ID,
        tableId: 'transactions',
        rowId: id,
      }),
  })
}

/** A transaction's shares (`shares.idx_transactionId`): who paid, and who it was for. */
export function useShares(id: string) {
  return useQuery({
    queryKey: queryKeys.transactionShares(id),
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Shares>({
        databaseId: DATABASE_ID,
        tableId: 'shares',
        queries: [Query.equal('transactionId', id), Query.limit(PAGE)],
      })
      return rows
    },
  })
}

/** An itemised transaction's items (`items.idx_transaction_position`), in the order entered. */
export function useItems(id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.transactionItems(id),
    enabled,
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Items>({
        databaseId: DATABASE_ID,
        tableId: 'items',
        queries: [Query.equal('transactionId', id), Query.orderAsc('position'), Query.limit(PAGE)],
      })
      return rows
    },
  })
}

export type HistoryFilters = {
  kind?: Transactions['kind']
  category?: Category
  /** Both included; YYYY-MM-DD in the group's time zone. */
  from?: string
  to?: string
  /** Text the description contains. */
  q?: string
  /** Only the transactions this person has a share in. */
  personId?: string
}

/** `useHistory`'s key for a list of groups (All groups). Never a group's ID: those have no `*`. */
export const ALL_GROUPS = '*'

/** One page of rows, and the next page's cursor: a transaction's ID, or a share's. */
type HistoryPage = { rows: HistoryRow[]; next?: string }

/** The pages as the lists read them: rows only. */
function rowPages(data: InfiniteData<HistoryPage, string | undefined>) {
  return { ...data, pages: data.pages.map((page) => page.rows) }
}

/**
 * The transactions of one group, or of a list of groups (All groups), newest first, in cursor
 * pages on `transactions.idx_group_date`. Ties on a date go by ID, so the cursor is stable.
 * With a person, it pages their shares on `shares.idx_group_person_date` instead, then reads
 * those shares' transactions with the other filters, so a page can come back short or empty.
 */
export function useHistory(group: string | readonly string[], filters: HistoryFilters) {
  // Query.equal takes at most 100 values, so All groups reads the first 100 groups. Read them
  // 100 at a time and merge the pages if anyone joins more.
  const groupIds = typeof group === 'string' ? [group] : group.slice(0, PAGE)
  return useInfiniteQuery({
    // All groups' key names its groups, so joining or leaving one reads the list again.
    queryKey:
      typeof group === 'string'
        ? queryKeys.history(group, filters)
        : queryKeys.history(ALL_GROUPS, { ...filters, groupIds: groupIds.join() }),
    enabled: groupIds.length > 0 && !groupIds.includes(''),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      const filtered = [
        ...(filters.kind ? [Query.equal('kind', filters.kind)] : []),
        ...(filters.category ? [Query.equal('category', filters.category)] : []),
        // `description` has no full-text index: `contains` matches a substring, `search` would fail.
        ...(filters.q ? [Query.contains('description', filters.q)] : []),
      ]
      const dates = [
        ...(filters.from ? [Query.greaterThanEqual('date', filters.from)] : []),
        ...(filters.to ? [Query.lessThanEqual('date', filters.to)] : []),
      ]
      const order = [Query.orderDesc('date'), Query.orderDesc('$id'), Query.limit(HISTORY_PAGE)]
      const cursor = pageParam === undefined ? [] : [Query.cursorAfter(pageParam)]
      const read = async (where: string[], after: string[] = []) => {
        const { rows } = await tablesDB.listRows<HistoryRow & Transactions>({
          databaseId: DATABASE_ID,
          tableId: 'transactions',
          // Only what the list shows (data-model.md: inputJson can be large).
          queries: [...where, Query.select(HISTORY_COLUMNS), ...order, ...after],
        })
        return rows as HistoryRow[]
      }
      if (!filters.personId) {
        const rows = await read([Query.equal('groupId', groupIds), ...filtered, ...dates], cursor)
        return { rows, next: rows.length < HISTORY_PAGE ? undefined : rows.at(-1)?.$id }
      }
      const { rows: shares } = await tablesDB.listRows<Shares>({
        databaseId: DATABASE_ID,
        tableId: 'shares',
        queries: [
          Query.equal('groupId', groupIds),
          Query.equal('personId', filters.personId),
          ...dates,
          Query.select(['$id', 'transactionId']),
          ...order,
          ...cursor,
        ],
      })
      // I-5: one share per person per transaction, so no ID comes twice. Void rows have no
      // shares (I-6), so they don't show here.
      const ids = shares.map((share) => share.transactionId)
      // Appwrite refuses `Query.equal` with an empty list.
      const rows = ids.length === 0 ? [] : await read([Query.equal('$id', ids), ...filtered])
      // A full page of shares may have more after it, however few of its rows the filters kept.
      return { rows, next: shares.length < HISTORY_PAGE ? undefined : shares.at(-1)?.$id }
    },
    getNextPageParam: (last) => last.next,
    select: rowPages,
  })
}

/** After a write: the row, its group's balances, history and calendar are out of date. */
function refresh(queryClient: ReturnType<typeof useQueryClient>, view: TransactionView) {
  const { transaction } = view
  queryClient.setQueryData(queryKeys.transaction(transaction.$id), transaction)
  queryClient.setQueryData(queryKeys.transactionShares(transaction.$id), view.shares)
  queryClient.setQueryData(queryKeys.transactionItems(transaction.$id), view.items)
  void queryClient.invalidateQueries({ queryKey: queryKeys.balances(transaction.groupId) })
  // The group's history (a person's in it too), and All groups', which lists the group's rows.
  void queryClient.invalidateQueries({ queryKey: ['history', transaction.groupId] })
  void queryClient.invalidateQueries({ queryKey: ['history', ALL_GROUPS] })
  void queryClient.invalidateQueries({ queryKey: ['calendar'] })
}

/** `POST /transactions` */
export function useCreateTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TransactionInput) => ledger<TransactionView>('POST', '/transactions', body),
    onSuccess: (view) => refresh(queryClient, view),
  })
}

/** Refusals that mean the row, its group or the caller's role changed meanwhile. */
export const CHANGED_MEANWHILE: readonly ErrorCode[] = ['LOCKED', 'ARCHIVED', 'FORBIDDEN']

/**
 * `PATCH /transactions/{id}` (#184). After a `CHANGED_MEANWHILE` refusal (a final statement, an
 * archive, a new role), read the row, the group and the members again, so the page shows them
 * as they are now.
 */
export function useUpdateTransaction(id: string, groupId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TransactionInput) =>
      ledger<TransactionView>('PATCH', `/transactions/${id}`, body),
    onSuccess: (view) => refresh(queryClient, view),
    onError: (error) => {
      if (error instanceof LedgerError && CHANGED_MEANWHILE.includes(error.code)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.transaction(id), exact: true })
        void queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId) })
        // The caller's own row (`useMyMember`) and everyone's.
        void queryClient.invalidateQueries({ queryKey: ['member', groupId] })
        void queryClient.invalidateQueries({ queryKey: queryKeys.members(groupId) })
      }
    },
  })
}

/** `POST /transactions/{id}/void`, shown as void at once and put back if it fails. */
export function useVoidTransaction(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VoidTransactionBody) =>
      ledger<TransactionView>('POST', `/transactions/${id}/void`, body),
    onMutate: async (body) => {
      const key = queryKeys.transaction(id)
      // Only this row: the shares query under the same prefix keeps loading.
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const before = queryClient.getQueryData<Transactions>(key)
      if (before)
        queryClient.setQueryData(key, { ...before, status: 'void', voidReason: body.reason })
      return { rollback: () => queryClient.setQueryData(key, before), groupId: before?.groupId }
    },
    onError: (error, _body, context) => {
      context?.rollback()
      // Locked by a statement, or the group archived, meanwhile: show the page as it is now.
      if (error instanceof LedgerError && ['LOCKED', 'ARCHIVED'].includes(error.code)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.transaction(id) })
        if (context?.groupId) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.group(context.groupId) })
        }
      }
    },
    onSuccess: (view) => refresh(queryClient, view),
  })
}
