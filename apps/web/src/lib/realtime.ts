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

// Not live either: `pendingGroups` (features/groups/pending-groups.tsx). Those are groups the user
// was only added to (D-016), whose rows they can't read until they join, so no event comes; the
// list refetches on focus (#48's Out of scope). Nor `firstEntry` (features/onboarding/): Home's
// guide decides once per visit (#52), so someone else's first entry shows on the next one. Nor
// the schedule keys (features/schedules/: `schedules`, `schedule`, `schedulePreview`): no
// channel carries schedules, so they're read on each visit and refreshed after a change (#30).

/** How long after the last event the collected keys are refreshed. */
export const FLUSH_MS = 300

// `activity` has no channel of its own: every activity row is written with a row of one of these
// tables, so each of them refreshes the group's feed (#47).
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
    ['activity', groupId],
  ],
  members: (groupId) => [
    ['member', groupId],
    ['members', groupId],
    ['myRoles'],
    ['activity', groupId],
  ],
  transactions: (groupId, rowId) => [
    ['calendar'],
    ['balances', groupId],
    ['transaction', rowId],
    ['history', groupId],
    // History's All groups (features/transactions' ALL_GROUPS), which lists every group's rows.
    ['history', '*'],
    ['today'],
    // Feature-local keys: the dashboard's shares and the bills lists.
    ['myShares'],
    ['bills', groupId],
    // A statement's "current period so far" preview sits under its group's statements (#420).
    ['statements', groupId],
    ['activity', groupId],
  ],
  // `statement` covers an async finalize's status (#32).
  statements: (groupId, rowId) => [
    ['statements', groupId],
    ['statement', rowId],
    ['activity', groupId],
  ],
}

/** Every prefix an event can produce, refreshed once when the connection comes back. */
export const LIVE_PREFIXES: Prefix[] = [
  ...new Set(Object.values(STALE).flatMap((stale) => stale('', '').map((key) => key[0] ?? ''))),
].map((name) => [name])

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
let mounted = 0
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
    mounted += 1
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
      mounted -= 1
      stopped = true
      reconnectListeners.delete(onReconnect)
      if (timer !== undefined) clearTimeout(timer)
      // Waits for the subscription, so a quick unmount (StrictMode's) never leaves one behind.
      void subscription.then((active) => active?.unsubscribe().catch(() => undefined))
      // Still unmounted once StrictMode's remount is done means signed out: close the socket. That
      // ends the old session's auth on it, and drops a subscription whose connect failed, which
      // unsubscribe can't reach and the SDK would keep retrying.
      setTimeout(() => {
        if (mounted !== 0) return
        // The next sign-in's first open is a first connection, not a reconnect.
        opens = 0
        void realtime.disconnect().catch(() => undefined)
      }, 0)
    }
  }, [queryClient])
}
