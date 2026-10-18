import type { Category } from '@ledgerly/core/constants/categories'
import type { Groups, Members, Shares, Transactions } from '@ledgerly/core/generated/rows'
import type { TransactionInput, VoidTransactionBody } from '@ledgerly/core/schemas/ledger'
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

/** What the ledger function returns for a write (functions-api.md#ledger). */
export type TransactionView = { transaction: Transactions; shares: Shares[] }

// Local to this feature: the shared keys file is outside its Scope. The shapes match the
// ['transaction', id] and ['balances', groupId] keys used elsewhere, so invalidation lines up.
export const transactionKeys = {
  transaction: (id: string) => ['transaction', id] as const,
  shares: (id: string) => ['transaction', id, 'shares'] as const,
  members: (groupId: string) => ['members', groupId] as const,
  history: (groupId: string, filters: HistoryFilters) => ['history', groupId, filters] as const,
}

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
    queryKey: transactionKeys.members(groupId),
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
    queryKey: transactionKeys.transaction(id),
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
    queryKey: transactionKeys.shares(id),
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
    queryKey: transactionKeys.history(groupId, filters),
    enabled: groupId !== '',
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { rows } = await tablesDB.listRows<Transactions>({
        databaseId: DATABASE_ID,
        tableId: 'transactions',
        queries: [
          Query.equal('groupId', groupId),
          ...(filters.kind ? [Query.equal('kind', filters.kind)] : []),
          ...(filters.category ? [Query.equal('category', filters.category)] : []),
          ...(filters.from ? [Query.greaterThanEqual('date', filters.from)] : []),
          ...(filters.to ? [Query.lessThanEqual('date', filters.to)] : []),
          Query.orderDesc('date'),
          Query.orderDesc('$id'),
          Query.limit(HISTORY_PAGE),
          ...(pageParam === undefined ? [] : [Query.cursorAfter(pageParam)]),
        ],
      })
      return rows
    },
    getNextPageParam: (last) => (last.length < HISTORY_PAGE ? undefined : last.at(-1)?.$id),
  })
}

/** After a write: the row, its group's balances, history and calendar are out of date. */
function refresh(queryClient: ReturnType<typeof useQueryClient>, view: TransactionView) {
  const { transaction } = view
  queryClient.setQueryData(transactionKeys.transaction(transaction.$id), transaction)
  queryClient.setQueryData(transactionKeys.shares(transaction.$id), view.shares)
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

/** `POST /transactions/{id}/void`, shown as void at once and put back if it fails. */
export function useVoidTransaction(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VoidTransactionBody) =>
      ledger<TransactionView>('POST', `/transactions/${id}/void`, body),
    onMutate: async (body) => {
      const key = transactionKeys.transaction(id)
      await queryClient.cancelQueries({ queryKey: key })
      const before = queryClient.getQueryData<Transactions>(key)
      if (before)
        queryClient.setQueryData(key, { ...before, status: 'void', voidReason: body.reason })
      return () => queryClient.setQueryData(key, before)
    },
    onError: (_error, _body, rollback) => rollback?.(),
    onSuccess: (view) => refresh(queryClient, view),
  })
}
