import type { Groups } from '@ledgerly/core/generated/rows'
import type { PendingGroup } from '@ledgerly/core/schemas/identity'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { tablesDB, teams } from '../../lib/appwrite'
import { DashboardPage } from '../dashboard/dashboard-page'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
  teams: { list: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
let mockUserId = 'u1'
vi.mock('../auth/use-current-user', () => ({
  useCurrentUser: () => ({ data: { $id: mockUserId, name: 'Sam' } }),
}))
let mockBootstrap: { data?: object; isError: boolean } = { isError: false }
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => mockBootstrap }))
vi.mock('../profile/use-profile', () => ({
  useProfile: () => ({
    data: { timezone: 'Australia/Sydney', region: 'AU-NSW', currency: 'AUD' },
    isError: false,
  }),
}))

const listRows = vi.mocked(tablesDB.listRows)
const call = vi.mocked(callFunction)

function group(id: string, type: Groups['type'], name: string, extra: Partial<Groups> = {}) {
  return {
    $id: id,
    type,
    name,
    ownerPersonId: 'p1',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    archivedAt: null,
    ...extra,
  } as Groups
}

const PERSONAL = group('g0', 'personal', 'Personal')
const KIM = { id: 'g2', type: 'pair', name: 'Sam', counterpartName: 'Kim', archivedAt: null }

/** What the fake backend holds: joined groups, pending ones, and groups with an entry. */
let joined: Groups[]
let pending: PendingGroup[]
let withEntries: string[]

/** The values of a `Query.equal`, from its JSON. */
function values(query: string | undefined): string[] {
  return (JSON.parse(query ?? '{}') as { values?: string[] }).values ?? []
}

function fakeBackend() {
  vi.mocked(teams.list).mockImplementation((async () => ({
    total: joined.length,
    teams: joined.map((g) => ({ $id: g.$id })),
  })) as never)
  listRows.mockImplementation((async ({
    tableId,
    queries,
  }: {
    tableId: string
    queries: string[]
  }) => {
    const ids = values(queries[0])
    const rows =
      tableId === 'groups'
        ? joined.filter((g) => ids.includes(g.$id))
        : tableId === 'transactions'
          ? ids.filter((id) => withEntries.includes(id)).map((id) => ({ $id: `t-${id}` }))
          : tableId === 'members' && ids.includes('g2')
            ? [
                { personId: 'p1', displayName: 'Sam' },
                { personId: 'p2', displayName: 'Kim' },
              ]
            : []
    return { total: rows.length, rows }
  }) as never)
  call.mockImplementation((async (_fn: string, method: string, path: string) => {
    if (path === '/groups/pending') return { ok: true, data: { groups: pending } }
    if (method === 'POST' && path.endsWith('/join')) {
      const id = path.split('/')[2]
      const added = pending.find((g) => g.id === id) as PendingGroup
      pending = pending.filter((g) => g !== added)
      joined = [...joined, group(added.id, added.type, added.name)]
      return { ok: true, data: {} }
    }
    return { ok: true, data: { people: [], transfers: [] } }
  }) as never)
}

/** The transactions reads, call by call. */
function entryReads() {
  return listRows.mock.calls
    .map(([params]) => params as unknown as { tableId: string; queries: string[] })
    .filter((params) => params.tableId === 'transactions')
    .map((params) => params.queries)
}

function renderHome() {
  const router = createMemoryRouter([
    { path: '/', element: <DashboardPage /> },
    { path: '/bills/new', element: <p>New bill</p> },
  ])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, router }
}

/** Lets timers queued now run, as time passes on another page. */
const later = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)))

const STEP_1 = 'What do you want to track first?'
const STEP_2 = 'Record your first entry'

/** The guide's links, as name and href. */
function links(heading: string) {
  const section = screen.getByRole('region', { name: heading })
  return within(section)
    .getAllByRole('link')
    .map((link) => [link.textContent, link.getAttribute('href')])
}

beforeEach(() => {
  mockUserId = 'u1'
  mockBootstrap = { data: { personId: 'p1', personalGroupId: 'g0' }, isError: false }
  joined = [PERSONAL]
  pending = []
  withEntries = []
  localStorage.clear()
  fakeBackend()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('GettingStarted: step 1', () => {
  it('asks what to track when only the personal group is joined, and it is empty', async () => {
    renderHome()
    // The file's first test starts cold. Wait by text, then check the role once: polling the first
    // role query by name (seconds under load) used up findByRole's 1 s. The dashboard's own cold
    // first render can take over 1 s under load too.
    await screen.findByText(STEP_1, {}, { timeout: 3000 })
    expect(screen.getByRole('heading', { name: STEP_1 })).toBeTruthy()
    expect(links(STEP_1)).toEqual([
      [
        'Hours I work for someoneLog your shifts and send invoices to an employer.',
        '/groups/new-employer',
      ],
      [
        'Money I lent or borrowedKeep track of what you and one other person owe each other.',
        '/people/new',
      ],
      ['My billsRent, phone and other bills, with when each one is due.', '/bills/new'],
      ['Change in Profile', '/profile'],
    ])
    expect(
      screen.getByText(
        /^We set your time zone to Australia\/Sydney, holidays to AU-NSW and currency to AUD\./,
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: STEP_2 })).toBeNull()
  })

  it('reads one transaction ID across the joined groups, once', async () => {
    joined = [PERSONAL, group('g1', 'employer', 'Acme')]
    renderHome()
    await screen.findByRole('heading', { name: STEP_2 })
    // The groups in useGroups' order: by name.
    expect(entryReads()).toEqual([
      [Query.equal('groupId', ['g1', 'g0']), Query.select(['$id']), Query.limit(1)],
    ])
  })

  it('shows pending groups first, and after a join announces it and moves on', async () => {
    pending = [KIM as PendingGroup]
    const view = renderHome()
    const join = await screen.findByRole('button', { name: 'Join Kim' })
    // The status region is there, empty, before the join, so the announcement is read out.
    const status = screen.getAllByRole('status').find((node) => node.textContent === '')
    const waiting = screen.getByRole('heading', { name: 'Waiting for you to join' })
    const step1 = screen.getByRole('heading', { name: STEP_1 })
    // Pending groups come before the choices.
    expect(waiting.compareDocumentPosition(step1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(join)
    await waitFor(() => expect(status?.textContent).toBe('Joined Kim.'))
    expect(status?.isConnected).toBe(true)
    expect(document.activeElement).toBe(view.getByRole('heading', { level: 1 }))
    // The joined pair is empty: record its first entry.
    await screen.findByRole('heading', { name: STEP_2 })
    expect(links(STEP_2)).toContainEqual(['Record money lent or borrowedKim', '/people/g2'])
  })

  it('is done after joining a group that already has entries', async () => {
    pending = [KIM as PendingGroup]
    withEntries = ['g2']
    renderHome()
    fireEvent.click(await screen.findByRole('button', { name: 'Join Kim' }))
    await waitFor(() => expect(entryReads()).toHaveLength(2))
    await waitFor(() => expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull())
    expect(screen.queryByRole('heading', { name: STEP_2 })).toBeNull()
    expect(screen.getByText('Joined Kim.')).toBeTruthy()
  })
})

describe('GettingStarted: step 2', () => {
  it('links each open group the user can record in, named as shown', async () => {
    joined = [
      PERSONAL,
      group('g1', 'employer', 'Acme'),
      // A pair is named by its other member.
      group('g2', 'pair', 'Sam'),
      // Shifts pay the owner: an employer who joined someone's group adds none.
      group('g3', 'employer', 'Boss', { ownerPersonId: 'p9' }),
      group('g4', 'pair', 'Old', { archivedAt: '2026-09-01T00:00:00.000Z' }),
      // Houses come in a follow-up.
      group('g5', 'house', 'Flat'),
    ]
    renderHome()
    await screen.findByRole('heading', { name: STEP_2 })
    await waitFor(() =>
      expect(links(STEP_2)).toEqual([
        ['Add a shiftAcme', '/shifts/new?groupId=g1'],
        ['Record money lent or borrowedKim', '/people/g2'],
        ['Add a billPersonal', '/bills/new'],
      ]),
    )
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
  })
})

describe('GettingStarted: done, loading and failures', () => {
  it('reads afresh on each visit, so it never comes back after the first entry', async () => {
    const { router } = renderHome()
    fireEvent.click(await screen.findByRole('link', { name: /^My bills/ }))
    await screen.findByText('New bill')
    await later()
    withEntries = ['g0']
    await act(() => router.navigate('/'))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    await waitFor(() => expect(entryReads()).toHaveLength(2))
    await later()
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
  })

  it('reads once per visit, not again when the window gets focus back', async () => {
    renderHome()
    await screen.findByRole('heading', { name: STEP_1 })
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await later()
    focusManager.setFocused(undefined)
    expect(entryReads()).toHaveLength(1)
  })

  it.each([
    ['the personal group', 'g0'],
    ['another group', 'g1'],
  ])('shows no guide once %s has an entry, in any status', async (_name, id) => {
    joined = [PERSONAL, group('g1', 'employer', 'Acme')]
    withEntries = [id]
    renderHome()
    await waitFor(() => expect(entryReads()).toHaveLength(1))
    await screen.findByRole('region', { name: 'Owed to me / I owe' })
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    expect(screen.queryByRole('heading', { name: STEP_2 })).toBeNull()
  })

  it('shows no guide while the read is on its way', async () => {
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) =>
      tableId === 'transactions' ? new Promise(() => {}) : { total: 1, rows: [PERSONAL] }) as never)
    renderHome()
    await screen.findByRole('region', { name: 'Owed to me / I owe' })
    await waitFor(() => expect(entryReads()).toHaveLength(1))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
  })

  it('shows no guide, and the dashboard as before, when the read fails', async () => {
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
      if (tableId === 'transactions') throw new Error('offline')
      return { total: 1, rows: tableId === 'groups' ? [PERSONAL] : [] }
    }) as never)
    renderHome()
    await screen.findByRole('region', { name: 'Owed to me / I owe' })
    await waitFor(() => expect(entryReads()).toHaveLength(1))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['loading', { isError: false }],
    ['failed', { isError: true }],
  ])('shows no guide while bootstrap is %s', async (_name, bootstrap) => {
    mockBootstrap = bootstrap
    renderHome()
    await screen.findByRole('region', { name: 'Owed to me / I owe' })
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
  })

  it('shows no guide when the groups fail to load', async () => {
    vi.mocked(teams.list).mockRejectedValue(new Error('offline'))
    renderHome()
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t load your groups.')
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    expect(entryReads()).toEqual([])
  })
})

describe('GettingStarted: done is remembered', () => {
  it('on this device once a read finds an entry, so later visits don’t read', async () => {
    renderHome()
    await screen.findByRole('heading', { name: STEP_1 })
    // No entry yet: nothing to remember.
    expect(localStorage.length).toBe(0)
    cleanup()
    withEntries = ['g0']
    renderHome()
    await waitFor(() => expect(entryReads()).toHaveLength(2))
    await waitFor(() => expect(localStorage.getItem('ledgerly:onboarding-done:u1')).toBe('1'))
    cleanup()
    pending = [KIM as PendingGroup]
    renderHome()
    await screen.findByRole('region', { name: 'Owed to me / I owe' })
    await later()
    expect(entryReads()).toHaveLength(2)
    // Done: no guide and, as before the guide, no groups waiting to be joined on Home.
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Waiting for you to join' })).toBeNull()
  })

  it('for this user only', async () => {
    localStorage.setItem('ledgerly:onboarding-done:u1', '1')
    mockUserId = 'u2'
    renderHome()
    expect(await screen.findByRole('heading', { name: STEP_1 })).toBeTruthy()
    expect(entryReads()).toHaveLength(1)
  })

  it('even with no groups', async () => {
    localStorage.setItem('ledgerly:onboarding-done:u1', '1')
    joined = []
    renderHome()
    await screen.findByRole('heading', { level: 1 })
    await later()
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
  })
})

describe('GettingStarted: Hide', () => {
  it('hides it for this user on this device, and moves focus to the heading', async () => {
    const view = renderHome()
    fireEvent.click(await screen.findByRole('button', { name: 'Hide getting started' }))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    expect(document.activeElement).toBe(view.getByRole('heading', { level: 1 }))
    expect(localStorage.getItem('ledgerly:onboarding-hidden:u1')).toBe('1')
    expect(localStorage.length).toBe(1)
  })

  it('stays hidden on the next visit, but not for another user', async () => {
    localStorage.setItem('ledgerly:onboarding-hidden:u1', '1')
    renderHome()
    await screen.findByRole('region', { name: 'Owed to me / I owe' })
    // Still read until done: step 1 shows the groups waiting to be joined.
    await waitFor(() => expect(entryReads()).toHaveLength(1))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    cleanup()
    mockUserId = 'u2'
    renderHome()
    expect(await screen.findByRole('heading', { name: STEP_1 })).toBeTruthy()
  })

  it('still shows the groups waiting to be joined, and announces a join', async () => {
    localStorage.setItem('ledgerly:onboarding-hidden:u1', '1')
    pending = [KIM as PendingGroup]
    renderHome()
    fireEvent.click(await screen.findByRole('button', { name: 'Join Kim' }))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
    expect(await screen.findByText('Joined Kim.')).toBeTruthy()
    // The joined pair is empty, but the guide stays hidden.
    await waitFor(() => expect(entryReads()).toHaveLength(2))
    await later()
    expect(screen.queryByRole('heading', { name: STEP_2 })).toBeNull()
  })

  it('shows the guide when storage throws, and Hide still hides it for now', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderHome()
    fireEvent.click(await screen.findByRole('button', { name: 'Hide getting started' }))
    expect(screen.queryByRole('heading', { name: STEP_1 })).toBeNull()
  })
})
