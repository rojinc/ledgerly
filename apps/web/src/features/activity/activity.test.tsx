import type { Activity, Groups, Members } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tablesDB, teams } from '../../lib/appwrite'
import { useGroups } from '../groups/use-groups'
import { ActivityPage } from './activity-page'
import { ACTIVITY_PAGE } from './use-activity'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
  teams: { list: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))

const listRows = vi.mocked(tablesDB.listRows)

const house = {
  $id: 'g1',
  type: 'house',
  name: 'House',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups
const acme = { ...house, $id: 'g2', type: 'employer', name: 'Acme' } as Groups

const MEMBERS = [
  { $id: 'm1', groupId: 'g1', personId: 'p1', displayName: 'Sam', role: 'admin' },
  { $id: 'm2', groupId: 'g1', personId: 'p2', displayName: 'Kim', role: 'viewer' },
] as Members[]

function entry(id: string, extra: Partial<Activity> = {}): Activity {
  return {
    $id: id,
    groupId: 'g1',
    actorPersonId: 'p1',
    action: 'transaction.created',
    transactionId: null,
    summary: `Entry ${id}`,
    changesJson: null,
    at: '2026-10-18T14:30:00.000+00:00',
    ...extra,
  } as Activity
}

function mockGroups(groups: Groups[]) {
  vi.mocked(useGroups).mockReturnValue({ data: groups, isError: false } as never)
}

/** listRows answers members with MEMBERS, and activity with `pages`, one per call. */
function mockRows(...pages: Activity[][]) {
  const queue = [...pages]
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    const rows = tableId === 'members' ? MEMBERS : (queue.shift() ?? [])
    return { total: rows.length, rows }
  }) as never)
}

/** The activity queries, call by call. */
function activityQueries() {
  return listRows.mock.calls
    .map(([params]) => params as unknown as { tableId: string; queries: string[] })
    .filter((params) => params.tableId === 'activity')
    .map((params) => params.queries)
}

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '/activity', element: <ActivityPage /> }], {
    initialEntries: [path],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const FIRST_PAGE = [
  Query.equal('groupId', 'g1'),
  Query.select(['$id', 'actorPersonId', 'transactionId', 'summary', 'at']),
  Query.orderDesc('at'),
  Query.orderDesc('$id'),
  Query.limit(100),
]

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('ActivityPage', () => {
  it("shows the first group's activity, newest first as Appwrite orders it", async () => {
    mockGroups([house])
    mockRows([entry('a2', { summary: 'Added “Milk” ($4.00)' }), entry('a1')])
    renderAt('/activity')
    const items = await screen.findAllByRole('listitem')
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Added “Milk” ($4.00)',
      'Entry a1',
    ])
    expect(activityQueries()).toEqual([FIRST_PAGE])
  })

  it('loads older pages after the last ID, and stops after a short page', async () => {
    mockGroups([house])
    const full = Array.from({ length: ACTIVITY_PAGE }, (_, i) => entry(`a${200 - i}`))
    mockRows(full, [entry('a0')])
    renderAt('/activity')
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }))
    expect(await screen.findByText('Entry a0')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(ACTIVITY_PAGE + 1)
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull()
    expect(activityQueries()).toEqual([FIRST_PAGE, [...FIRST_PAGE, Query.cursorAfter('a101')]])
  })

  it('has no "Show older" after a first page that is short', async () => {
    mockGroups([house])
    mockRows([entry('a1')])
    renderAt('/activity')
    await screen.findByText('Entry a1')
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull()
  })

  it('names the actor from their member row, or says automatic or former member', async () => {
    mockGroups([house])
    mockRows([
      entry('a3', { actorPersonId: 'p2' }),
      entry('a2', { actorPersonId: null }),
      entry('a1', { actorPersonId: 'gone' }),
    ])
    renderAt('/activity')
    const items = await screen.findAllByRole('listitem')
    expect(items.map((item) => item.querySelectorAll('p')[1]?.textContent)).toEqual([
      expect.stringMatching(/^Kim · /),
      expect.stringMatching(/^Automatic · /),
      expect.stringMatching(/^A former member · /),
    ])
  })

  it('links to the transaction when the entry has one', async () => {
    mockGroups([house])
    mockRows([entry('a2', { transactionId: 't1' }), entry('a1')])
    renderAt('/activity')
    const items = await screen.findAllByRole('listitem')
    const link = within(items[0] as HTMLElement).getByRole('link', { name: 'View transaction' })
    expect(link.getAttribute('href')).toBe('/transactions/t1')
    expect(within(items[1] as HTMLElement).queryByRole('link')).toBeNull()
  })

  it('never shows changesJson, and reads names only from members', async () => {
    mockGroups([house])
    const changes = { before: { payers: ['p9'] }, after: { note: 'kim@example.com 0400 000 000' } }
    mockRows([entry('a1', { changesJson: JSON.stringify(changes) })])
    renderAt('/activity')
    await screen.findByText('Entry a1')
    expect(document.body.textContent).not.toMatch(/p9|example\.com|0400/)
    expect(activityQueries()[0]?.join()).not.toMatch(/changesJson/)
    const tables = listRows.mock.calls.map(([params]) => (params as { tableId: string }).tableId)
    expect(new Set(tables)).toEqual(new Set(['activity', 'members']))
    expect(teams.list).not.toHaveBeenCalled()
  })

  it.each(['UTC', 'Australia/Sydney'])(
    "shows the time in the group's time zone on a device in %s",
    async (deviceZone) => {
      const before = process.env.TZ
      process.env.TZ = deviceZone
      try {
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(deviceZone)
        mockGroups([house])
        mockRows([entry('a1', { at: '2026-10-18T14:30:00.000Z' })])
        renderAt('/activity')
        const time = (await screen.findByText(/2026/)).closest('time')
        expect(time?.getAttribute('dateTime')).toBe('2026-10-18T14:30:00.000Z')
        // 19 Oct 2026, 1:30 am in Sydney, in the device's locale.
        expect(time?.textContent).toMatch(/^(19 Oct 2026, 1:30\sam|Oct 19, 2026, 1:30\sAM)$/)
      } finally {
        process.env.TZ = before
      }
    },
  )

  it('lists the groups by the name shown, and keeps the choice in the URL', async () => {
    const pair = { ...house, $id: 'g3', type: 'pair', name: 'Sam' } as Groups
    mockGroups([acme, house, pair])
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      const rows =
        tableId !== 'members'
          ? [entry('a1', { summary: `In ${queries[0]}` })]
          : queries[0] === Query.equal('groupId', 'g3')
            ? [
                { personId: 'p1', displayName: 'Sam' },
                { personId: 'p4', displayName: 'Ana' },
              ]
            : MEMBERS
      return { total: rows.length, rows }
    }) as never)
    const router = renderAt('/activity')
    const select = (await screen.findByLabelText('Group')) as HTMLSelectElement
    // A pair is named by its other member (#145).
    await waitFor(() =>
      expect([...select.options].map((o) => o.textContent)).toEqual(['Acme', 'Ana', 'House']),
    )
    expect(select.value).toBe('g2')
    fireEvent.change(select, { target: { value: 'g1' } })
    expect(await screen.findByText(`In ${Query.equal('groupId', 'g1')}`)).toBeTruthy()
    expect(router.state.location.search).toBe('?groupId=g1')
  })

  it('shows an archived group to a viewer', async () => {
    mockGroups([{ ...house, archivedAt: '2026-10-01T00:00:00.000Z' } as Groups])
    mockRows([entry('a1')])
    renderAt('/activity?groupId=g1')
    expect(await screen.findByText('Entry a1')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'House (archived)' })).toBeTruthy()
  })

  it('says loading, then that nothing has happened yet', async () => {
    mockGroups([house])
    mockRows([])
    renderAt('/activity')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Nothing has happened in this group yet.',
      ),
    )
  })

  it('says loading while the groups load', () => {
    vi.mocked(useGroups).mockReturnValue({ data: undefined, isError: false } as never)
    renderAt('/activity')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('offers to try again when the activity fails to load', async () => {
    mockGroups([house])
    listRows.mockRejectedValueOnce(new Error('offline'))
    renderAt('/activity')
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t load the activity.')
    mockRows([entry('a1')])
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Entry a1')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers to try again when the groups fail to load', async () => {
    const refetch = vi.fn()
    vi.mocked(useGroups).mockReturnValue({ data: undefined, isError: true, refetch } as never)
    renderAt('/activity')
    expect(screen.getByRole('alert').textContent).toBe('We couldn’t load your groups.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
  })

  it("says so for a group that isn't one of the user's, and keeps the select", async () => {
    mockGroups([house])
    mockRows([entry('a1')])
    const router = renderAt('/activity?groupId=other')
    expect(screen.getByRole('alert').textContent).toBe('We couldn’t find that group.')
    expect(activityQueries()).toEqual([])
    const select = screen.getByLabelText('Group') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'g1' } })
    expect(await screen.findByText('Entry a1')).toBeTruthy()
    expect(router.state.location.search).toBe('?groupId=g1')
  })
})
