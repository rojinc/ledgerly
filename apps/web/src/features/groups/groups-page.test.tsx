import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { tablesDB, teams } from '../../lib/appwrite'
import { GroupsPage } from './groups-page'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  teams: { list: vi.fn() },
  tablesDB: { listRows: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))

const listTeams = vi.mocked(teams.list)
const listRows = vi.mocked(tablesDB.listRows)
const call = vi.mocked(callFunction)

function group(id: string, type: string, name: string, extra: object = {}) {
  return { $id: id, type, name, currency: 'AUD', archivedAt: null, ...extra }
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <GroupsPage /> }])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return queryClient
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('GroupsPage', () => {
  it('lists the groups the user has joined, sorted by name, with type and balance', async () => {
    listTeams.mockResolvedValue({
      total: 3,
      teams: [{ $id: 'g1' }, { $id: 'g2' }, { $id: 'g3' }],
    } as never)
    listRows.mockResolvedValue({
      total: 3,
      rows: [
        group('g2', 'employer', 'Acme'),
        group('g1', 'personal', 'Personal'),
        group('g3', 'house', 'Flat', { archivedAt: '2026-10-01T00:00:00.000Z' }),
      ],
    } as never)
    call.mockImplementation(async (_fn, _method, path) => {
      const nets: Record<string, number> = {
        '/groups/g1/balances': 0,
        '/groups/g2/balances': 71500,
        '/groups/g3/balances': -2050,
      }
      return {
        ok: true as const,
        data: { people: [{ personId: 'p1', netCents: nets[path] ?? 0 }], transfers: [] },
      }
    })
    renderPage()
    const items = await screen.findAllByRole('listitem')
    // Archived groups come last, in their own section (#37).
    expect(items.map((item) => within(item).getAllByText(/./)[0]?.textContent)).toEqual([
      'Acme',
      'Personal',
      'Flat',
    ])
    expect(await within(items[0] as HTMLElement).findByText(/^Owed .*715\.00$/)).toBeTruthy()
    expect(within(items[0] as HTMLElement).getByText('Employer')).toBeTruthy()
    expect(await within(items[1] as HTMLElement).findByText('Settled')).toBeTruthy()
    const archived = screen.getByRole('region', { name: 'Archived' })
    expect(within(archived).getByText('Flat')).toBeTruthy()
    // Marked in text, not only by colour, and its balance still shows.
    expect(within(archived).getByText('House · Archived')).toBeTruthy()
    expect(await within(archived).findByText(/^You owe .*20\.50$/)).toBeTruthy()
    // Only employer groups link to their settings.
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe(
      '/groups/g2/settings',
    )
    expect(screen.queryByRole('link', { name: 'Flat' })).toBeNull()
    // The rows come from the user's teams only.
    expect(listRows).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'groups',
        queries: expect.arrayContaining([expect.stringContaining('g1')]),
      }),
    )
  })

  it('moves focus to the heading and says so after joining a pending group', async () => {
    listTeams.mockResolvedValue({ total: 0, teams: [] } as never)
    listRows.mockResolvedValue({ total: 0, rows: [] } as never)
    let joined = false
    call.mockImplementation(async (_fn, method, path) => {
      if (method === 'POST') {
        joined = true
        return { ok: true as const, data: { group: {}, member: {} } }
      }
      if (path === '/groups/pending') {
        const groups = joined ? [] : [{ id: 'g7', type: 'pair', name: 'Alex', archivedAt: null }]
        return { ok: true as const, data: { groups } }
      }
      return { ok: true as const, data: { people: [], transfers: [] } }
    })
    renderPage()
    const join = await screen.findByRole('button', { name: 'Join Alex' })
    join.focus()
    fireEvent.click(join)
    expect(await screen.findByText('Joined Alex.')).toBeTruthy()
    expect(screen.getByText('Joined Alex.').getAttribute('role')).toBe('status')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Groups' }))
    // The row goes, and focus stays on the heading.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join Alex' })).toBeNull())
    expect(document.activeElement?.tagName).toBe('H1')
  })

  it('links a lend & borrow group to its page', async () => {
    listTeams.mockResolvedValue({ total: 1, teams: [{ $id: 'g4' }] } as never)
    listRows.mockResolvedValue({ total: 1, rows: [group('g4', 'pair', 'Sam')] } as never)
    call.mockResolvedValue({ ok: true, data: { people: [], transfers: [] } })
    renderPage()
    expect((await screen.findByRole('link', { name: 'Sam' })).getAttribute('href')).toBe(
      '/people/g4',
    )
  })

  it('shows a dash when the balance is not available', async () => {
    listTeams.mockResolvedValue({ total: 1, teams: [{ $id: 'g2' }] } as never)
    listRows.mockResolvedValue({ total: 1, rows: [group('g2', 'employer', 'Acme')] } as never)
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Not deployed' } })
    renderPage()
    expect(await screen.findByTitle('Balance not available yet')).toBeTruthy()
  })

  it('reads every page of teams', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ $id: `g${from + i}` }))
    listTeams
      .mockResolvedValueOnce({ total: 101, teams: page(0, 100) } as never)
      .mockResolvedValueOnce({ total: 101, teams: page(100, 1) } as never)
    listRows.mockResolvedValue({ total: 0, rows: [] } as never)
    call.mockResolvedValue({ ok: true, data: { people: [], transfers: [] } })
    renderPage()
    await vi.waitFor(() => expect(listRows).toHaveBeenCalledTimes(2))
    expect(listTeams).toHaveBeenCalledTimes(2)
  })

  it('offers a retry when the groups fail to load', async () => {
    listTeams.mockRejectedValue(new Error('offline'))
    renderPage()
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('keeps the list when a background refetch fails', async () => {
    listTeams.mockResolvedValue({ total: 1, teams: [{ $id: 'g2' }] } as never)
    listRows.mockResolvedValue({ total: 1, rows: [group('g2', 'employer', 'Acme')] } as never)
    call.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'No route' } })
    const queryClient = renderPage()
    expect(await screen.findByText('Acme')).toBeTruthy()
    listTeams.mockRejectedValue(new Error('offline'))
    await queryClient.invalidateQueries({ queryKey: ['groups', 'u1'] })
    expect(queryClient.getQueryState(['groups', 'u1'])?.status).toBe('error')
    // Let React render the failed refetch before looking.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.queryByText(/couldn’t load your groups/)).toBeNull()
    // The dash has text a screen reader reads out.
    expect(screen.getByText('Balance not available yet').className).toContain('sr-only')
  })
})
