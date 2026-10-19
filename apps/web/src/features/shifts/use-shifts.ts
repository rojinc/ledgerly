import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import type {
  StartTimerBody,
  StopTimerBody,
  TransactionInput,
  TransactionView,
  VoidTransactionBody,
} from '@ledgerly/core/schemas/ledger'
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Query } from 'appwrite'
import { useEffect, useState } from 'react'
import { DATABASE_ID, tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'
import { LedgerError, ledger } from '../transactions/use-transactions'

// Appwrite's limit for one page and for the values of one Query.equal.
const PAGE = 100

/**
 * The caller's role in each of `groups`, from their own member rows (permissions.md): who may
 * add shifts (admin, member) and start the timer (admin). The function checks again.
 */
export function useMyRoles(groups: Groups[] | undefined, personId: string) {
  const ids = (groups ?? []).map((group) => group.$id)
  return useQuery({
    queryKey: queryKeys.myRoles(personId, ids),
    enabled: groups !== undefined && personId !== '',
    // A changed group list keeps the roles on screen while the new ones load.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const roles = new Map<string, Members['role']>()
      for (let index = 0; index < ids.length; index += PAGE) {
        const { rows } = await tablesDB.listRows<Members>({
          databaseId: DATABASE_ID,
          tableId: 'members',
          queries: [
            Query.equal('groupId', ids.slice(index, index + PAGE)),
            Query.equal('personId', personId),
            Query.limit(PAGE),
          ],
        })
        for (const row of rows) if (row.status !== 'placeholder') roles.set(row.groupId, row.role)
      }
      return roles
    },
  })
}

export type Today = {
  /** Shifts dated today in each group's own time zone, by date then ID. */
  shifts: Transactions[]
  /** The caller's running timer, whatever day it started on (scheduling.md#timer-shifts). */
  running: Transactions | undefined
}

/**
 * Each group's local date today, by group ID. Worked out again every minute, so the screen
 * moves on to the next day at each group's local midnight.
 */
export function useTodayDates(groups: Groups[] | undefined): Map<string, LocalDate> {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return new Map(
    (groups ?? []).map((group) => [group.$id, localToday(group.timezone, new Date(now))]),
  )
}

/** The `useToday` key for `groups` on `dates`. */
export function todayKey(userId: string, groups: Groups[] | undefined, dates: Map<string, string>) {
  const ids = (groups ?? []).map((group) => group.$id)
  return queryKeys.today(
    userId,
    ids,
    ids.map((id) => dates.get(id) ?? ''),
  )
}

/** Today's shifts in `groups` on `today`'s dates (from `useTodayDates`) and the person's running timer. */
export function useToday(
  groups: Groups[] | undefined,
  personId: string,
  today: Map<string, LocalDate>,
) {
  const userId = useCurrentUser().data?.$id ?? ''
  const ids = (groups ?? []).map((group) => group.$id)
  return useQuery({
    queryKey: todayKey(userId, groups, today),
    enabled: groups !== undefined && personId !== '',
    // A changed group list, or a new day, keeps the last one on screen while it loads.
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Today> => {
      // A timer left running in an archived group doesn't count (scheduling.md#timer-shifts).
      const open = new Set((groups ?? []).filter((group) => !group.archivedAt).map((g) => g.$id))
      const dates = [...today.values()].sort()
      const shifts: Transactions[] = []
      let running: Transactions | undefined
      for (let index = 0; index < ids.length; index += PAGE) {
        const chunk = ids.slice(index, index + PAGE)
        // idx_group_date: the days that are "today" somewhere in these groups.
        shifts.push(
          ...(
            await listAll([
              Query.equal('groupId', chunk),
              Query.greaterThanEqual('date', dates[0] as string),
              Query.lessThanEqual('date', dates.at(-1) as string),
              Query.equal('kind', 'shift'),
            ])
          ).filter((row) => row.date === today.get(row.groupId)),
        )
        // idx_group_status_date: running timers, which may have started on an earlier day.
        const openChunk = chunk.filter((id) => open.has(id))
        if (openChunk.length > 0) {
          running ??= (
            await listAll([Query.equal('groupId', openChunk), Query.equal('status', 'running')])
          ).find((row) => row.createdBy === personId)
        }
      }
      return {
        shifts: shifts.sort((a, b) => a.date.localeCompare(b.date) || a.$id.localeCompare(b.$id)),
        running,
      }
    },
  })
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
        Query.orderAsc('date'),
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
 * After any shift write: the shift and its shares show the stored state, and the group's balance,
 * history, today and the calendar are out of date (as in use-transactions).
 */
function refresh(queryClient: QueryClient, view: TransactionView) {
  const { transaction } = view
  queryClient.setQueryData(queryKeys.transaction(transaction.$id), transaction)
  queryClient.setQueryData(queryKeys.transactionShares(transaction.$id), view.shares)
  markStale(queryClient, transaction.groupId)
}

/** The group's balance and history, today and the calendar, after a shift was written. */
export function markStale(queryClient: QueryClient, groupId: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.balances(groupId) })
  void queryClient.invalidateQueries({ queryKey: ['history', groupId] })
  void queryClient.invalidateQueries({ queryKey: ['today'] })
  void queryClient.invalidateQueries({ queryKey: ['calendar'] })
}

/** Locked by a statement, or the group archived, meanwhile: reload so the page turns read-only. */
function reloadIfClosed(queryClient: QueryClient, error: Error, id: string, groupId?: string) {
  if (!(error instanceof LedgerError && ['LOCKED', 'ARCHIVED'].includes(error.code))) return
  void queryClient.invalidateQueries({ queryKey: queryKeys.transaction(id) })
  if (groupId) void queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId) })
}

/**
 * Shows `patch` on the cached transaction at once, and puts the old row back if the write fails
 * (conventions.md#react: optimistic updates).
 */
async function optimistic(queryClient: QueryClient, id: string, patch: Partial<Transactions>) {
  const key = queryKeys.transaction(id)
  // A refetch already on its way would land on top of this and show the old state.
  await queryClient.cancelQueries({ queryKey: key, exact: true })
  const before = queryClient.getQueryData<Transactions>(key)
  if (before) queryClient.setQueryData(key, { ...before, ...patch })
  return { rollback: () => queryClient.setQueryData(key, before), groupId: before?.groupId }
}

/** `POST /transactions` (new) or `PATCH /transactions/{id}`. */
export function useSaveShift() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body, isNew }: { body: TransactionInput; isNew: boolean }) =>
      isNew
        ? ledger<TransactionView>('POST', '/transactions', body)
        : ledger<TransactionView>('PATCH', `/transactions/${body.id}`, body),
    onError: (error, { body }) => reloadIfClosed(queryClient, error, body.id, body.groupId),
    onSuccess: (view) => refresh(queryClient, view),
  })
}

/** `POST /transactions/{id}/void` */
export function useVoidShift(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: VoidTransactionBody) =>
      ledger<TransactionView>('POST', `/transactions/${id}/void`, body),
    onMutate: (body) => optimistic(queryClient, id, { status: 'void', voidReason: body.reason }),
    onError: (error, _body, context) => {
      context?.rollback()
      reloadIfClosed(queryClient, error, id, context?.groupId)
    },
    onSuccess: (view) => refresh(queryClient, view),
  })
}

/** `POST /transactions/{id}/post`: confirms a scheduled shift as it is. */
export function useConfirmShift(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => ledger<TransactionView>('POST', `/transactions/${id}/post`, {}),
    onMutate: () => optimistic(queryClient, id, { status: 'posted' }),
    onError: (error, _body, context) => {
      context?.rollback()
      reloadIfClosed(queryClient, error, id, context?.groupId)
    },
    onSuccess: (view) => refresh(queryClient, view),
  })
}

/** `POST /timer/start`, shown as running at once. */
export function useStartTimer(todayKey: readonly unknown[]) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: StartTimerBody) => ledger<TransactionView>('POST', '/timer/start', body),
    onMutate: async (body) => {
      // A refetch already on its way would land on top of this and show the old state. While
      // Today shows the last key's data (a new day or group list), there's nothing to swap: the
      // timer shows once the write's refresh loads it.
      await queryClient.cancelQueries({ queryKey: ['today'] })
      const before = queryClient.getQueryData<Today>(todayKey)
      if (before) {
        const pending = {
          $id: body.id,
          groupId: body.groupId,
          kind: 'shift',
          status: 'running',
          description: body.description ?? 'Shift',
          startedAt: new Date().toISOString(),
          totalCents: 0,
        } as Transactions
        queryClient.setQueryData<Today>(todayKey, { ...before, running: pending })
      }
      return () => queryClient.setQueryData(todayKey, before)
    },
    onError: (_error, _body, rollback) => {
      rollback?.()
      // A CONFLICT names a timer already running, maybe started on another device: show it.
      void queryClient.invalidateQueries({ queryKey: ['today'] })
    },
    onSuccess: (view) => refresh(queryClient, view),
  })
}

/** `POST /timer/stop`, shown as stopped at once. */
export function useStopTimer(todayKey: readonly unknown[]) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: StopTimerBody) => ledger<TransactionView>('POST', '/timer/stop', body),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['today'] })
      const before = queryClient.getQueryData<Today>(todayKey)
      if (before) queryClient.setQueryData<Today>(todayKey, { ...before, running: undefined })
      return () => queryClient.setQueryData(todayKey, before)
    },
    onError: (_error, _body, rollback) => {
      rollback?.()
      // "Not running any more": show the timer as it is now.
      void queryClient.invalidateQueries({ queryKey: ['today'] })
    },
    onSuccess: (view) => refresh(queryClient, view),
  })
}
