import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from './query-keys'

const fake = vi.hoisted(() => {
  const opens: (() => void)[] = []
  return {
    opens,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
})

vi.mock('./appwrite', () => ({
  DATABASE_ID: 'main',
  realtime: {
    onOpen: (callback: () => void) => fake.opens.push(callback),
    subscribe: fake.subscribe,
    disconnect: fake.disconnect,
  },
}))

const { FLUSH_MS, LIVE_PREFIXES, NOT_LIVE, staleKeys, useRealtimeSync } = await import('./realtime')

// Real Realtime row events captured on dev (scratchpad dev48.mjs), with made-up IDs and names.
// `transactions.delete` and the statements ones can't be caused from a client, so they're built
// from the captured shape (statements' columns from generated/rows.ts).
const EVENTS = {
  'groups.create': {
    events: [
      'tablesdb.main.tables.groups.rows.group1.create',
      'databases.main.collections.groups.documents.group1.create',
      'databases.main.tables.groups.rows.group1.create',
    ],
    channels: [
      'documents',
      'databases.main.collections.groups.documents',
      'databases.main.collections.groups.documents.group1',
    ],
    payload: {
      type: 'house',
      name: 'Flat',
      ownerPersonId: 'person1',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      statementCycle: 'none',
      cycleAnchor: null,
      nextCloseAt: null,
      settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"days"}',
      archivedAt: null,
      rev: null,
      $sequence: '1',
      $id: 'group1',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'groups',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'groups.update': {
    events: [
      'tablesdb.main.tables.groups.rows.group1.update',
      'databases.main.collections.groups.documents.group1.update',
      'databases.main.tables.groups.rows.group1.update',
    ],
    channels: [
      'documents',
      'databases.main.collections.groups.documents',
      'databases.main.collections.groups.documents.group1',
    ],
    payload: {
      type: 'house',
      name: 'Flat',
      ownerPersonId: 'person1',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      statementCycle: 'none',
      cycleAnchor: null,
      nextCloseAt: null,
      settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"days"}',
      archivedAt: null,
      rev: null,
      $sequence: '1',
      $id: 'group1',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'groups',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'members.create': {
    events: [
      'tablesdb.main.tables.members.rows.member1.create',
      'databases.main.collections.members.documents.member1.create',
      'databases.main.tables.members.rows.member1.create',
    ],
    channels: [
      'documents',
      'databases.main.collections.members.documents',
      'databases.main.collections.members.documents.member1',
    ],
    payload: {
      groupId: 'group1',
      personId: 'person1',
      displayName: 'Sam',
      role: 'admin',
      status: 'active',
      joinedOn: '2026-10-19',
      leftOn: null,
      rev: null,
      $sequence: '1',
      $id: 'member1',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'members',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'members.update': {
    events: [
      'tablesdb.main.tables.members.rows.member2.update',
      'databases.main.collections.members.documents.member2.update',
      'databases.main.tables.members.rows.member2.update',
    ],
    channels: [
      'documents',
      'databases.main.collections.members.documents',
      'databases.main.collections.members.documents.member2',
    ],
    payload: {
      groupId: 'group1',
      personId: 'person1',
      displayName: 'Sam',
      role: 'member',
      status: 'placeholder',
      joinedOn: '2026-10-19',
      leftOn: null,
      rev: null,
      $sequence: '1',
      $id: 'member2',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'members',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'members.delete': {
    events: [
      'tablesdb.main.tables.members.rows.member3.delete',
      'databases.main.collections.members.documents.member3.delete',
      'databases.main.tables.members.rows.member3.delete',
    ],
    channels: [
      'documents',
      'databases.main.collections.members.documents',
      'databases.main.collections.members.documents.member3',
    ],
    payload: {
      groupId: 'group1',
      personId: 'person1',
      displayName: 'Sam',
      role: 'member',
      status: 'placeholder',
      joinedOn: '2026-10-19',
      leftOn: null,
      rev: null,
      $sequence: '1',
      $id: 'member3',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'members',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'transactions.create': {
    events: [
      'tablesdb.main.tables.transactions.rows.tx1.create',
      'databases.main.collections.transactions.documents.tx1.create',
      'databases.main.tables.transactions.rows.tx1.create',
    ],
    channels: [
      'documents',
      'databases.main.collections.transactions.documents',
      'databases.main.collections.transactions.documents.tx1',
    ],
    payload: {
      groupId: 'group1',
      kind: 'expense',
      status: 'posted',
      date: '2026-10-19',
      description: 'Groceries',
      category: null,
      totalCents: 4000,
      inputJson:
        '{"payers": [{"personId": "person1", "cents": 4000}], "split": {"mode": "equal", "personIds": ["person1"]}}',
      dueOn: null,
      scheduleId: null,
      overridden: false,
      statementId: null,
      receiptFileIds: [],
      startedAt: null,
      remindedAt: null,
      voidReason: null,
      createdBy: 'person1',
      updatedBy: 'person1',
      $sequence: '1',
      $id: 'tx1',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'transactions',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'transactions.update': {
    events: [
      'tablesdb.main.tables.transactions.rows.tx1.update',
      'databases.main.collections.transactions.documents.tx1.update',
      'databases.main.tables.transactions.rows.tx1.update',
    ],
    channels: [
      'documents',
      'databases.main.collections.transactions.documents',
      'databases.main.collections.transactions.documents.tx1',
    ],
    payload: {
      groupId: 'group1',
      kind: 'expense',
      status: 'void',
      date: '2026-10-19',
      description: 'Groceries',
      category: null,
      totalCents: 4000,
      inputJson:
        '{"payers": [{"personId": "person1", "cents": 4000}], "split": {"mode": "equal", "personIds": ["person1"]}}',
      dueOn: null,
      scheduleId: null,
      overridden: false,
      statementId: null,
      receiptFileIds: [],
      startedAt: null,
      remindedAt: null,
      voidReason: 'Test',
      createdBy: 'person1',
      updatedBy: 'person1',
      $sequence: '1',
      $id: 'tx1',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'transactions',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'transactions.delete': {
    events: [
      'tablesdb.main.tables.transactions.rows.tx1.delete',
      'databases.main.collections.transactions.documents.tx1.delete',
      'databases.main.tables.transactions.rows.tx1.delete',
    ],
    channels: [
      'documents',
      'databases.main.collections.transactions.documents',
      'databases.main.collections.transactions.documents.tx1',
    ],
    payload: {
      groupId: 'group1',
      kind: 'expense',
      status: 'void',
      date: '2026-10-19',
      description: 'Groceries',
      category: null,
      totalCents: 4000,
      inputJson:
        '{"payers": [{"personId": "person1", "cents": 4000}], "split": {"mode": "equal", "personIds": ["person1"]}}',
      dueOn: null,
      scheduleId: null,
      overridden: false,
      statementId: null,
      receiptFileIds: [],
      startedAt: null,
      remindedAt: null,
      voidReason: 'Test',
      createdBy: 'person1',
      updatedBy: 'person1',
      $sequence: '1',
      $id: 'tx1',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      $databaseId: 'main',
      $tableId: 'transactions',
    },
    timestamp: '2026-10-19 03:30:00.000',
  },
  'statements.create': {
    events: [
      'tablesdb.main.tables.statements.rows.statement1.create',
      'databases.main.collections.statements.documents.statement1.create',
      'databases.main.tables.statements.rows.statement1.create',
    ],
    channels: [
      'documents',
      'databases.main.collections.statements.documents',
      'databases.main.collections.statements.documents.statement1',
    ],
    timestamp: '2026-10-19 03:30:00.000',
    payload: {
      $id: 'statement1',
      $sequence: '1',
      $tableId: 'statements',
      $databaseId: 'main',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      groupId: 'group1',
      type: 'invoice',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      status: 'draft',
      number: null,
      displayNumber: null,
      issuedOn: null,
      dueOn: null,
      sentAt: null,
      pdfFileId: null,
      snapshotJson: '{}',
      finalizedBy: null,
    },
  },
  'statements.update': {
    events: [
      'tablesdb.main.tables.statements.rows.statement1.update',
      'databases.main.collections.statements.documents.statement1.update',
      'databases.main.tables.statements.rows.statement1.update',
    ],
    channels: [
      'documents',
      'databases.main.collections.statements.documents',
      'databases.main.collections.statements.documents.statement1',
    ],
    timestamp: '2026-10-19 03:30:00.000',
    payload: {
      $id: 'statement1',
      $sequence: '1',
      $tableId: 'statements',
      $databaseId: 'main',
      $createdAt: '2026-10-19T03:30:00.000+00:00',
      $updatedAt: '2026-10-19T03:30:00.000+00:00',
      $permissions: ['read("team:group1")'],
      groupId: 'group1',
      type: 'invoice',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      status: 'finalizing',
      number: null,
      displayNumber: null,
      issuedOn: null,
      dueOn: null,
      sentAt: null,
      pdfFileId: null,
      snapshotJson: '{}',
      finalizedBy: null,
    },
  },
} as const

type Name = keyof typeof EVENTS

describe('staleKeys', () => {
  it.each<[Name, unknown[][]]>([
    [
      'groups.create',
      [
        ['group', 'group1'],
        ['groups'],
        ['balances', 'group1'],
        ['history', 'group1'],
        ['transaction'],
        ['myShares'],
      ],
    ],
    [
      'groups.update',
      [
        ['group', 'group1'],
        ['groups'],
        ['balances', 'group1'],
        ['history', 'group1'],
        ['transaction'],
        ['myShares'],
      ],
    ],
    ['members.create', [['member', 'group1'], ['members', 'group1'], ['myRoles']]],
    ['members.update', [['member', 'group1'], ['members', 'group1'], ['myRoles']]],
    ['members.delete', [['member', 'group1'], ['members', 'group1'], ['myRoles']]],
    ...(['create', 'update', 'delete'] as const).map((action): [Name, unknown[][]] => [
      `transactions.${action}`,
      [
        ['calendar'],
        ['balances', 'group1'],
        ['transaction', 'tx1'],
        ['history', 'group1'],
        ['today'],
        ['myShares'],
        ['bills', 'group1'],
      ],
    ]),
    [
      'statements.create',
      [
        ['statements', 'group1'],
        ['statement', 'statement1'],
      ],
    ],
    [
      'statements.update',
      [
        ['statements', 'group1'],
        ['statement', 'statement1'],
      ],
    ],
  ])('maps %s', (name, keys) => {
    expect(staleKeys(EVENTS[name])).toEqual(keys)
  })

  it('ignores other tables, rows without a group, and anything that isn’t an event', () => {
    const transaction = EVENTS['transactions.create']
    expect(
      staleKeys({ ...transaction, payload: { ...transaction.payload, $tableId: 'shares' } }),
    ).toEqual([])
    expect(staleKeys({ ...transaction, payload: { ...transaction.payload, groupId: '' } })).toEqual(
      [],
    )
    expect(staleKeys({ ...transaction, payload: { ...transaction.payload, groupId: 7 } })).toEqual(
      [],
    )
    expect(staleKeys({ ...transaction, payload: { ...transaction.payload, $id: null } })).toEqual(
      [],
    )
    for (const junk of [null, undefined, 'event', 42, {}, { payload: null }, { payload: 'x' }]) {
      expect(staleKeys(junk)).toEqual([])
    }
  })

  it('gives every key in query-keys.ts a decision: refreshed by an event, or not live', () => {
    const produced = new Set(
      Object.values(EVENTS).flatMap((event) => staleKeys(event).map((key) => key[0])),
    )
    const notLive = new Set<string>(NOT_LIVE)
    for (const [name, key] of Object.entries(queryKeys)) {
      // Empty lists stand in for every argument: a string or a list of IDs.
      const make = key as unknown as
        | ((...args: unknown[]) => readonly unknown[])
        | readonly unknown[]
      const prefix = (typeof make === 'function' ? make(...Array(5).fill([])) : make)[0]
      expect(
        produced.has(prefix as string) || notLive.has(prefix as string),
        `query key ${name} (${String(prefix)})`,
      ).toBe(true)
    }
    // The reconnect list is exactly what events can produce.
    expect(new Set(LIVE_PREFIXES.map((key) => key[0]))).toEqual(produced)
  })
})

function Sync() {
  useRealtimeSync()
  return null
}

let handler: (event: unknown) => void

function mount(queryClient = new QueryClient(), strict = false) {
  const tree = (
    <QueryClientProvider client={queryClient}>
      <Sync />
    </QueryClientProvider>
  )
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  return { ...view, queryClient, invalidate }
}

/** Lets the subscribe promise and its cleanup settle. */
const settle = () => act(async () => {})

beforeEach(() => {
  vi.useFakeTimers()
  fake.subscribe.mockImplementation(async (_channels, callback) => {
    handler = callback
    return { unsubscribe: fake.unsubscribe }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useRealtimeSync', () => {
  it('subscribes once to the live tables’ row channels', async () => {
    mount()
    await settle()
    expect(fake.subscribe).toHaveBeenCalledTimes(1)
    expect(fake.subscribe.mock.calls[0]?.[0].map(String)).toEqual([
      'tablesdb.main.tables.groups.rows',
      'tablesdb.main.tables.members.rows',
      'tablesdb.main.tables.transactions.rows',
      'tablesdb.main.tables.statements.rows',
    ])
  })

  it('refreshes each key once for a burst of 100 events, 300 ms after the last', async () => {
    const { invalidate } = mount()
    await settle()
    for (let index = 0; index < 100; index++) handler(EVENTS['transactions.update'])
    act(() => vi.advanceTimersByTime(FLUSH_MS - 1))
    expect(invalidate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(invalidate).toHaveBeenCalledTimes(7)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transaction', 'tx1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] })
  })

  it('waits until 300 ms after the last event, however long a burst lasts', async () => {
    const { invalidate } = mount()
    await settle()
    handler(EVENTS['statements.update'])
    act(() => vi.advanceTimersByTime(200))
    handler(EVENTS['statements.update'])
    act(() => vi.advanceTimersByTime(200))
    expect(invalidate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(100))
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('waits for a pending write before refreshing', async () => {
    const { invalidate, queryClient } = mount()
    await settle()
    let finish!: () => void
    const write = queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => new Promise<void>((resolve) => (finish = resolve)) })
    void write.execute(undefined)
    await settle()
    expect(queryClient.isMutating()).toBe(1)
    handler(EVENTS['members.update'])
    act(() => vi.advanceTimersByTime(FLUSH_MS * 5))
    expect(invalidate).not.toHaveBeenCalled()
    await act(async () => finish())
    act(() => vi.advanceTimersByTime(FLUSH_MS))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['members', 'group1'] })
  })

  it('refreshes every live key once after a reconnect, but not on the first connection', async () => {
    const { invalidate } = mount()
    await settle()
    for (const open of fake.opens) open()
    act(() => vi.advanceTimersByTime(FLUSH_MS))
    expect(invalidate).not.toHaveBeenCalled()
    for (const open of fake.opens) open()
    act(() => vi.advanceTimersByTime(FLUSH_MS))
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(LIVE_PREFIXES)
  })

  it('unsubscribes on unmount, and StrictMode’s double mount leaves exactly one subscription', async () => {
    const { unmount } = mount(new QueryClient(), true)
    await settle()
    expect(fake.subscribe.mock.calls.length - fake.unsubscribe.mock.calls.length).toBe(1)
    act(() => vi.runOnlyPendingTimers())
    // StrictMode's remount keeps the socket.
    expect(fake.disconnect).not.toHaveBeenCalled()
    unmount()
    await settle()
    expect(fake.subscribe.mock.calls.length - fake.unsubscribe.mock.calls.length).toBe(0)
    act(() => vi.runOnlyPendingTimers())
    // Signed out: the socket closes, so the next user's subscription gets a fresh, authorised one.
    expect(fake.disconnect).toHaveBeenCalledTimes(1)
  })

  it('keeps going quietly when Realtime can’t connect', async () => {
    fake.subscribe.mockRejectedValue(new Error('offline'))
    const { unmount } = mount()
    await settle()
    unmount()
    await settle()
    expect(fake.unsubscribe).not.toHaveBeenCalled()
    // The failed subscription has no handle: closing the socket drops it, so the SDK stops retrying.
    act(() => vi.runOnlyPendingTimers())
    expect(fake.disconnect).toHaveBeenCalledTimes(1)
  })

  it('treats the first open after signing out and in again as a first connection', async () => {
    const first = mount()
    await settle()
    for (const open of fake.opens) open()
    first.unmount()
    await settle()
    act(() => vi.runOnlyPendingTimers())
    expect(fake.disconnect).toHaveBeenCalledTimes(1)
    const { invalidate } = mount()
    await settle()
    for (const open of fake.opens) open()
    act(() => vi.advanceTimersByTime(FLUSH_MS))
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('ignores events once unmounted', async () => {
    const { unmount, invalidate } = mount()
    await settle()
    unmount()
    handler(EVENTS['groups.update'])
    act(() => vi.advanceTimersByTime(FLUSH_MS))
    expect(invalidate).not.toHaveBeenCalled()
  })
})
