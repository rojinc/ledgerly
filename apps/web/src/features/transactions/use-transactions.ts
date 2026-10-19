import type { Category } from '@ledgerly/core/constants/categories'
import type { Groups, Items, Members, Shares, Transactions } from '@ledgerly/core/generated/rows'
import type {
  TransactionInput,
  TransactionView,
  VoidTransactionBody,
} from '@ledgerly/core/schemas/ledger'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

export type HistoryFilters = {
  kind?: Transactions['kind']
  category?: Category
  /** Both included; YYYY-MM-DD in the group's time zone. */
  from?: string
  to?: string
}

/**
 * The group's transactions, newest first, in cursor pages on `transactions.idx_group_date`.
 * Ties on a date go by ID, so the cursor is stable.
 */
export function useHistory(groupId: string, filters: HistoryFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.history(groupId, filters),
    enabled: groupId !== '',
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { rows } = await tablesDB.listRows<HistoryRow & Transactions>({
        databaseId: DATABASE_ID,
        tableId: 'transactions',
        queries: [
          Query.equal('groupId', groupId),
          ...(filters.kind ? [Query.equal('kind', filters.kind)] : []),
          ...(filters.category ? [Query.equal('category', filters.category)] : []),
          ...(filters.from ? [Query.greaterThanEqual('date', filters.from)] : []),
          ...(filters.to ? [Query.lessThanEqual('date', filters.to)] : []),
          // Only what the list shows (data-model.md: inputJson can be large).
          Query.select(HISTORY_COLUMNS),
          Query.orderDesc('date'),
          Query.orderDesc('$id'),
          Query.limit(HISTORY_PAGE),
          ...(pageParam === undefined ? [] : [Query.cursorAfter(pageParam)]),
        ],
      })
      return rows as HistoryRow[]
    },
    getNextPageParam: (last) => (last.length < HISTORY_PAGE ? undefined : last.at(-1)?.$id),
  })
}

/** After a write: the row, its group's balances, history and calendar are out of date. */
function refresh(queryClient: ReturnType<typeof useQueryClient>, view: TransactionView) {
  const { transaction } = view
  queryClient.setQueryData(queryKeys.transaction(transaction.$id), transaction)
  queryClient.setQueryData(queryKeys.transactionShares(transaction.$id), view.shares)
  void queryClient.invalidateQueries({ queryKey: queryKeys.balances(transaction.groupId) })
  void queryClient.invalidateQueries({ queryKey: ['history', transaction.groupId] })
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

/** Whether a transaction has items (`items.idx_transaction_position`): an itemised receipt (#42). */
export function useHasItems(id: string) {
  return useQuery({
    queryKey: queryKeys.transactionItems(id),
    queryFn: async () => {
      const { rows } = await tablesDB.listRows<Items>({
        databaseId: DATABASE_ID,
        tableId: 'items',
        queries: [Query.equal('transactionId', id), Query.limit(1)],
      })
      return rows.length > 0
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
