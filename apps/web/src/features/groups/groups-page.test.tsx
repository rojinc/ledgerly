import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
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
    expect(items.map((item) => within(item).getAllByText(/./)[0]?.textContent)).toEqual([
      'Acme',
      'Flat',
      'Personal',
    ])
    expect(await within(items[0] as HTMLElement).findByText(/^Owed .*715\.00$/)).toBeTruthy()
    expect(within(items[0] as HTMLElement).getByText('Employer')).toBeTruthy()
    expect(await within(items[1] as HTMLElement).findByText(/^You owe .*20\.50$/)).toBeTruthy()
    expect(within(items[1] as HTMLElement).getByText('House · Archived')).toBeTruthy()
    expect(await within(items[2] as HTMLElement).findByText('Settled')).toBeTruthy()
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
})
