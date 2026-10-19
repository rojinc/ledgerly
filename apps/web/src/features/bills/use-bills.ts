import type { Transactions } from '@ledgerly/core/generated/rows'
import type {
  PostTransactionBody,
  TransactionInput,
  TransactionView,
  VoidTransactionBody,
} from '@ledgerly/core/schemas/ledger'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { ledger } from '../transactions/use-transactions'

// Appwrite's limit for one page.
const PAGE = 100

// Local to this feature: the shared keys file is outside its Scope.
export const billKeys = {
  all: (groupId: string) => ['bills', groupId] as const,
  due: (groupId: string) => ['bills', groupId, 'due'] as const,
  paid: (groupId: string, since: string) => ['bills', groupId, 'paid', since] as const,
}

async function listAll(queries: string[]): Promise<Transactions[]> {
  const rows: Transactions[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await tablesDB.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: 'transactions',
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

/**
 * The group's bills waiting to be paid, soonest due first, every page
 * (`transactions.idx_group_status_date`). A due bill is dated on its due date.
 */
export function useDueBills(groupId: string) {
  return useQuery({
    queryKey: billKeys.due(groupId),
    enabled: groupId !== '',
    queryFn: () =>
      listAll([
        Query.equal('groupId', groupId),
        Query.equal('status', 'due'),
        Query.equal('kind', 'bill'),
        Query.orderAsc('date'),
        Query.orderAsc('$id'),
      ]).then((rows) =>
        // By due date itself, which a due bill is dated on, so this only guards that rule.
        rows.sort((a, b) => (a.dueOn ?? a.date).localeCompare(b.dueOn ?? b.date)),
      ),
  })
}

/** The group's bills paid on or after `since`, latest first (`idx_group_status_date`). */
export function usePaidBills(groupId: string, since: string) {
  return useQuery({
    queryKey: billKeys.paid(groupId, since),
    enabled: groupId !== '',
    queryFn: () =>
      listAll([
        Query.equal('groupId', groupId),
        Query.equal('status', 'posted'),
        Query.equal('kind', 'bill'),
        Query.greaterThanEqual('date', since),
        Query.orderDesc('date'),
        Query.orderDesc('$id'),
      ]),
  })
}

/** After a write: the bill shows as stored, and the lists, balance, history and calendar reload. */
function refresh(queryClient: QueryClient, view: TransactionView) {
  const { transaction } = view
  queryClient.setQueryData(queryKeys.transaction(transaction.$id), transaction)
  queryClient.setQueryData(queryKeys.transactionShares(transaction.$id), view.shares)
  markStale(queryClient, transaction.groupId)
}

/** The group's bill lists, balance, history and the calendar, after a bill was written. */
export function markStale(queryClient: QueryClient, groupId: string) {
  void queryClient.invalidateQueries({ queryKey: billKeys.all(groupId) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.balances(groupId) })
  void queryClient.invalidateQueries({ queryKey: ['history', groupId] })
  void queryClient.invalidateQueries({ queryKey: ['calendar'] })
}

/** `POST /transactions` (new) or `PATCH /transactions/{id}`. */
export function useSaveBill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body, isNew }: { body: TransactionInput; isNew: boolean }) =>
      isNew
        ? ledger<TransactionView>('POST', '/transactions', body)
        : ledger<TransactionView>('PATCH', `/transactions/${body.id}`, body),
    onSuccess: (view) => refresh(queryClient, view),
    // A change refused because the bill was paid or skipped meanwhile: show it as it is now.
    onError: (_error, { body, isNew }) => {
      if (!isNew) void queryClient.invalidateQueries({ queryKey: queryKeys.transaction(body.id) })
    },
  })
}

/** `POST /transactions/{id}/post` on the day it was paid. */
export function useMarkPaid(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PostTransactionBody) =>
      ledger<TransactionView>('POST', `/transactions/${id}/post`, body),
    onSuccess: (view) => refresh(queryClient, view),
    // Paid meanwhile, say on another device: show it as it is now.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.transaction(id) }),
  })
}

/** `POST /transactions/{id}/void`: skips a bill, with a reason. */
export function useSkipBill(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VoidTransactionBody) =>
      ledger<TransactionView>('POST', `/transactions/${id}/void`, body),
    onSuccess: (view) => refresh(queryClient, view),
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.transaction(id) }),
  })
}
