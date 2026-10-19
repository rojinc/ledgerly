import type { Schedules, Transactions } from '@ledgerly/core/generated/rows'
import type {
  PostTransactionBody,
  TransactionInput,
  TransactionView,
  VoidTransactionBody,
} from '@ledgerly/core/schemas/ledger'
import type { EndScheduleBody, ScheduleInput } from '@ledgerly/core/schemas/scheduler'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Query } from 'appwrite'
import { callFunction } from '../../lib/api'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { writeErrorMessage } from '../groups/archive-group'
import { ledger } from '../transactions/use-transactions'

// Appwrite's limit for one page.
const PAGE = 100

// Local to this feature: the shared keys file is outside its Scope.
export const billKeys = {
  all: (groupId: string) => ['bills', groupId] as const,
  due: (groupId: string) => ['bills', groupId, 'due'] as const,
  paid: (groupId: string, since: string) => ['bills', groupId, 'paid', since] as const,
  recurring: (groupId: string) => ['bills', groupId, 'recurring'] as const,
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
      ]),
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

/** The group's recurring bills, oldest first, every page (`schedules.idx_groupId`). */
export function useRecurringBills(groupId: string) {
  return useQuery({
    queryKey: billKeys.recurring(groupId),
    enabled: groupId !== '',
    queryFn: async () => {
      const rows: Schedules[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await tablesDB.listRows<Schedules>({
          databaseId: DATABASE_ID,
          tableId: 'schedules',
          queries: [
            Query.equal('groupId', groupId),
            Query.equal('kind', 'bill'),
            Query.orderAsc('startsOn'),
            Query.orderAsc('$id'),
            Query.limit(PAGE),
            ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
          ],
        })
        rows.push(...page.rows)
        if (page.rows.length < PAGE) return rows
        cursor = page.rows.at(-1)?.$id
      }
    },
  })
}

/** Calls the scheduler function; a refusal throws its message in plain words. */
async function scheduler<T>(path: string, body: unknown): Promise<T> {
  const result = await callFunction<T>('scheduler', 'POST', path, body)
  if (!result.ok) throw new Error(writeErrorMessage(result.error))
  return result.data
}

/** After a schedule changes: the lists (its occurrences are due bills) and the calendar. */
function refreshRecurring(queryClient: QueryClient, schedule: Schedules) {
  void queryClient.invalidateQueries({ queryKey: billKeys.all(schedule.groupId) })
  void queryClient.invalidateQueries({ queryKey: ['schedules', schedule.groupId] })
  void queryClient.invalidateQueries({ queryKey: ['calendar'] })
}

/** `scheduler POST /schedules` for a recurring bill. */
export function useCreateRecurringBill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) => scheduler<{ schedule: Schedules }>('/schedules', input),
    onSuccess: ({ schedule }) => refreshRecurring(queryClient, schedule),
  })
}

/** `scheduler POST /schedules/{id}/end`: no more bills after `endsOn`. */
export function useStopRecurringBill(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: EndScheduleBody) =>
      scheduler<{ schedule: Schedules }>(`/schedules/${id}/end`, body),
    onSuccess: ({ schedule }) => refreshRecurring(queryClient, schedule),
  })
}

/** After a write: the bill shows as stored, and the lists, balance, history and calendar reload. */
function refresh(queryClient: QueryClient, view: TransactionView) {
  const { transaction } = view
  queryClient.setQueryData(queryKeys.transaction(transaction.$id), transaction)
  queryClient.setQueryData(queryKeys.transactionShares(transaction.$id), view.shares)
  void queryClient.invalidateQueries({ queryKey: billKeys.all(transaction.groupId) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.balances(transaction.groupId) })
  void queryClient.invalidateQueries({ queryKey: ['history', transaction.groupId] })
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
