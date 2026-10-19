import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { Channel, type RealtimeResponseEvent } from 'appwrite'
import { useEffect } from 'react'
import { DATABASE_ID, realtime } from './appwrite'

/** Query key prefixes: invalidating one refetches every query under it that's on screen. */
type Prefix = readonly string[]

/** The tables the app reads that other people change (#48). */
export const LIVE_TABLES = ['groups', 'members', 'transactions', 'statements'] as const
type LiveTable = (typeof LIVE_TABLES)[number]

/**
 * Keys that never go stale from someone else's change: the user's own rows, changed only by
 * their own requests, which already update the cache.
 */
export const NOT_LIVE = ['currentUser', 'bootstrap', 'profile', 'person'] as const

/** How long after the last event the collected keys are refreshed. */
export const FLUSH_MS = 300

const STALE: Record<LiveTable, (groupId: string, rowId: string) => Prefix[]> = {
  // Every write of shares also sets the group's `rev` (ledger.md#concurrency), so this covers
  // share changes no transaction row shows, such as a merge's.
  groups: (groupId) => [
    ['group', groupId],
    ['groups'],
    ['balances', groupId],
    ['history', groupId],
    ['transaction'],
    ['myShares'],
  ],
  members: (groupId) => [['member', groupId], ['members', groupId], ['myRoles']],
  transactions: (groupId, rowId) => [
    ['calendar'],
    ['balances', groupId],
    ['transaction', rowId],
    ['history', groupId],
    ['today'],
    // Feature-local keys: the dashboard's shares and the bills lists.
    ['myShares'],
    ['bills', groupId],
  ],
  // `statement` covers an async finalize's status (#32).
  statements: (groupId, rowId) => [
    ['statements', groupId],
    ['statement', rowId],
  ],
}

/** Every prefix an event can produce, refreshed once when the connection comes back. */
export const LIVE_PREFIXES: Prefix[] = [
  ['group'],
  ['groups'],
  ['balances'],
  ['history'],
  ['transaction'],
  ['myShares'],
  ['member'],
  ['members'],
  ['myRoles'],
  ['calendar'],
  ['today'],
  ['bills'],
  ['statements'],
  ['statement'],
]

function isLiveTable(table: unknown): table is LiveTable {
  return (LIVE_TABLES as readonly unknown[]).includes(table)
}

/**
 * The query key prefixes one Realtime row event makes stale. Events from other tables, without
 * a group, or that aren't events at all give none.
 */
export function staleKeys(event: unknown): Prefix[] {
  const payload = (event as { payload?: unknown } | null)?.payload as
    | { $tableId?: unknown; $id?: unknown; groupId?: unknown }
    | null
    | undefined
  const table = payload?.$tableId
  if (!isLiveTable(table)) return []
  const rowId = payload?.$id
  const groupId = table === 'groups' ? rowId : payload?.groupId
  if (typeof groupId !== 'string' || groupId === '' || typeof rowId !== 'string') return []
  return STALE[table](groupId, rowId)
}

// The SDK keeps every onOpen callback for good, so one is registered for the app, and it tells
// whichever sync is mounted. The first open is the first connection; later ones are reconnects.
const reconnectListeners = new Set<() => void>()
let opens = 0
realtime.onOpen(() => {
  opens += 1
  if (opens > 1) for (const listener of reconnectListeners) listener()
})

function refresh(queryClient: QueryClient, prefixes: Prefix[]) {
  const seen = new Set<string>()
  for (const queryKey of prefixes) {
    const id = JSON.stringify(queryKey)
    if (seen.has(id)) continue
    seen.add(id)
    void queryClient.invalidateQueries({ queryKey })
  }
}

/**
 * Keeps what's on screen up to date with other people's changes: one Realtime subscription to
 * the live tables' rows while signed in (#48). Appwrite sends only rows the user can read.
 * Events are collected and refreshed together, after a pending write, so a burst (a finalize's
 * locks) refetches once and never overwrites an optimistic update.
 */
export function useRealtimeSync() {
  const queryClient = useQueryClient()
  useEffect(() => {
    let stopped = false
    let pending: Prefix[] = []
    let timer: ReturnType<typeof setTimeout> | undefined

    const flush = () => {
      timer = undefined
      if (stopped) return
      // A write is on its way: refresh once it's done, so it isn't overwritten half way.
      if (queryClient.isMutating() > 0) {
        timer = setTimeout(flush, FLUSH_MS)
        return
      }
      const prefixes = pending
      pending = []
      refresh(queryClient, prefixes)
    }
    const collect = (prefixes: Prefix[]) => {
      if (prefixes.length === 0) return
      pending.push(...prefixes)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(flush, FLUSH_MS)
    }
    const onEvent = (event: RealtimeResponseEvent<unknown>) => collect(staleKeys(event))
    // Events sent while the connection was down are lost: refresh everything live once.
    const onReconnect = () => collect(LIVE_PREFIXES)
    reconnectListeners.add(onReconnect)

    const subscription = realtime
      .subscribe(
        LIVE_TABLES.map((table) => Channel.tablesdb(DATABASE_ID).table(table).row()),
        onEvent,
      )
      .catch(() => undefined)

    return () => {
      stopped = true
      reconnectListeners.delete(onReconnect)
      if (timer !== undefined) clearTimeout(timer)
      // Waits for the subscription, so a quick unmount (StrictMode's) never leaves one behind.
      void subscription.then((active) => active?.unsubscribe().catch(() => undefined))
    }
  }, [queryClient])
}
