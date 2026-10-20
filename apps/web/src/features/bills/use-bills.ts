import type { LocalDate } from '@ledgerly/core/dates/local-date'
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
import { callFunction, type Method } from '../../lib/api'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { writeErrorMessage } from '../groups/archive-group'
import { LedgerError, ledger } from '../transactions/use-transactions'

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
            // A house's recurring expenses too (#403).
            Query.equal('kind', ['bill', 'expense']),
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
async function scheduler<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const result = await callFunction<T>('scheduler', method, path, body)
  if (!result.ok) throw new LedgerError(result.error.code, writeErrorMessage(result.error))
  return result.data
}

/** After a schedule changes: the lists (its occurrences are due bills) and the calendar. */
function refreshRecurring(queryClient: QueryClient, groupId: string) {
  void queryClient.invalidateQueries({ queryKey: billKeys.all(groupId) })
  void queryClient.invalidateQueries({ queryKey: ['schedules', groupId] })
  void queryClient.invalidateQueries({ queryKey: ['history', groupId] })
  void queryClient.invalidateQueries({ queryKey: ['calendar'] })
}

/** `scheduler POST /schedules` for a recurring bill. */
export function useCreateRecurringBill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) =>
      scheduler<{ schedule: Schedules }>('POST', '/schedules', input),
    onSuccess: ({ schedule }) => refreshRecurring(queryClient, schedule.groupId),
  })
}

/**
 * Stops a recurring bill from `today`: `POST /schedules/{id}/end` with today as its end date.
 * One that hasn't started can't end before its start (the scheduler refuses that), so it's
 * removed with `DELETE /schedules/{id}`. If its first bill was already paid early, the scheduler
 * refuses the delete (a schedule with posted bills is ended, not deleted): it then ends on its
 * first date, keeping that paid bill.
 */
export function useStopRecurringBill(schedule: Schedules) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (today: LocalDate): Promise<Schedules | undefined> => {
      let endsOn = today
      if (today < schedule.startsOn) {
        try {
          await scheduler<object>('DELETE', `/schedules/${schedule.$id}`)
          return undefined
        } catch (error) {
          // DELETE takes no body, so its only VALIDATION_FAILED is "has posted transactions".
          if (!(error instanceof LedgerError && error.code === 'VALIDATION_FAILED')) throw error
          endsOn = schedule.startsOn as LocalDate
        }
      }
      const body: EndScheduleBody = { endsOn }
      const { schedule: stopped } = await scheduler<{ schedule: Schedules }>(
        'POST',
        `/schedules/${schedule.$id}/end`,
        body,
      )
      return stopped
    },
    onSuccess: (stopped) => {
      // Shown as it is now at once, so Stop doesn't come back until the list reloads.
      queryClient.setQueryData<Schedules[]>(billKeys.recurring(schedule.groupId), (rows) =>
        rows?.flatMap((row) => (row.$id !== schedule.$id ? [row] : stopped ? [stopped] : [])),
      )
      refreshRecurring(queryClient, schedule.groupId)
    },
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
