import type { Groups } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { useGroups } from '../groups/use-groups'
import { useProfile } from '../profile/use-profile'
import { CalendarPage, groupColours } from './calendar-page'

vi.mock('../../lib/appwrite', () => ({ DATABASE_ID: 'main', tablesDB: { listRows: vi.fn() } }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn() }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))

const listRows = vi.mocked(tablesDB.listRows)
const groupsHook = vi.mocked(useGroups)
const profileHook = vi.mocked(useProfile)

const GROUPS = [
  { $id: 'g1', name: 'Acme Cafe', currency: 'AUD' },
  { $id: 'g2', name: 'Personal', currency: 'AUD' },
] as Groups[]

const ITEMS = [
  {
    $id: 't1',
    groupId: 'g1',
    kind: 'shift',
    status: 'scheduled',
    date: '2026-10-08',
    description: 'Shift',
    totalCents: 12500,
  },
  {
    $id: 't2',
    groupId: 'g1',
    kind: 'shift',
    status: 'posted',
    date: '2026-10-01',
    description: 'Morning shift',
    totalCents: 10000,
  },
  {
    $id: 't3',
    groupId: 'g2',
    kind: 'bill',
    status: 'due',
    date: '2026-10-08',
    description: 'Rent',
    totalCents: 50000,
  },
  {
    $id: 't4',
    groupId: 'g2',
    kind: 'expense',
    status: 'void',
    date: '2026-10-08',
    description: 'Taxi',
    totalCents: 2050,
  },
]

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '/calendar', element: <CalendarPage /> }], {
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

// The queries of the nth listRows call, parsed.
function queriesOf(call = 0): unknown[] {
  const params = listRows.mock.calls[call]?.[0] as { queries?: string[] } | undefined
  return (params?.queries ?? []).map((query) => JSON.parse(query))
}

function day(name: RegExp) {
  return screen.getByRole('button', { name })
}

beforeEach(() => {
  // 07:00 on Sunday 18 October 2026 in Sydney, still the 17th in UTC.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-17T20:00:00.000Z'))
  groupsHook.mockReturnValue({ data: GROUPS, isError: false } as ReturnType<typeof useGroups>)
  profileHook.mockReturnValue({
    data: { timezone: 'Australia/Sydney' },
    isError: false,
  } as ReturnType<typeof useProfile>)
  listRows.mockResolvedValue({ total: ITEMS.length, rows: ITEMS } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  listRows.mockReset()
})

describe('CalendarPage', () => {
  it("opens on this month in the profile's time zone, Monday first, with today marked", async () => {
    renderAt('/calendar')
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeTruthy()
    // The 18th in Sydney, though it's still the 17th in UTC.
    expect(
      await screen.findByRole('button', {
        name: /^Sunday, October 18, 0 items|^Sunday 18 October, 0 items/,
      }),
    ).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: /items?$/ })
    expect(buttons).toHaveLength(35)
    expect(buttons[0]?.getAttribute('aria-label')).toMatch(/Monday.*(September 28|28 September)/)
    expect(buttons.at(-1)?.getAttribute('aria-label')).toMatch(/Sunday.*(November 1|1 November)/)
    expect(within(day(/(October 18|18 October)/)).getByText('18').className).toContain('bg-primary')
  })

  it("loads the visible weeks across the user's groups on idx_group_date", async () => {
    renderAt('/calendar?month=2026-10')
    await screen.findByText('Morning shift')
    expect(listRows).toHaveBeenCalledTimes(1)
    expect(listRows.mock.calls[0]?.[0]).toMatchObject({
      databaseId: 'main',
      tableId: 'transactions',
    })
    expect(queriesOf()).toEqual(
      expect.arrayContaining([
        { method: 'equal', attribute: 'groupId', values: ['g1', 'g2'] },
        { method: 'greaterThanEqual', attribute: 'date', values: ['2026-09-28'] },
        { method: 'lessThanEqual', attribute: 'date', values: ['2026-11-01'] },
        { method: 'limit', values: [100] },
      ]),
    )
  })

  it('draws scheduled and due dashed, posted solid and void struck through, with group names in a legend', async () => {
    renderAt('/calendar?month=2026-10')
    await screen.findByText('Morning shift')
    const thursday = within(day(/(October 8|8 October), 3 items/))
    expect(thursday.getByText('Shift').className).toContain('border-dashed')
    expect(thursday.getByText('Rent').className).toContain('border-dashed')
    expect(thursday.getByText('Taxi').className).toMatch(/line-through/)
    const first = within(day(/(October 1|1 October), 1 item$/))
    expect(first.getByText('Morning shift').className).toContain('border-solid')
    expect(thursday.getByText('Shift').getAttribute('style')).toContain('border-color')
    const legend = within(screen.getByRole('list', { name: 'Groups' }))
    expect(legend.getByText('Acme Cafe')).toBeTruthy()
    expect(legend.getByText('Personal')).toBeTruthy()
  })

  it("lists a day's items with group, status and amount, linking to each transaction", async () => {
    const router = renderAt('/calendar?month=2026-10')
    fireEvent.click(await screen.findByRole('button', { name: /(October 8|8 October), 3 items/ }))
    expect(router.state.location.search).toBe('?month=2026-10&day=2026-10-08')
    const list = within(screen.getByRole('region', { name: /Thursday.*2026/ }))
    const links = list.getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/transactions/t1',
      '/transactions/t3',
      '/transactions/t4',
    ])
    expect(links[0]?.textContent).toMatch(/Shift.*Acme Cafe · Scheduled.*125\.00/)
    expect(links[1]?.textContent).toMatch(/Rent.*Personal · Due.*500\.00/)
    expect(links[2]?.textContent).toMatch(/Taxi.*Personal · Void.*20\.50/)
    fireEvent.click(day(/(October 2|2 October), 0 items/))
    expect(screen.getByText('Nothing on this day.')).toBeTruthy()
  })

  it('names a pair group by its other member, in the legend and the day list (#149)', async () => {
    // Alex added the viewer, so the group's own name is the viewer's.
    groupsHook.mockReturnValue({
      data: [{ $id: 'g3', name: 'Sam', type: 'pair', currency: 'AUD' }],
      isError: false,
    } as ReturnType<typeof useGroups>)
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) =>
      tableId === 'members'
        ? {
            total: 2,
            rows: [
              { $id: 'm1', groupId: 'g3', personId: 'p2', displayName: 'Alex' },
              { $id: 'm2', groupId: 'g3', personId: 'p1', displayName: 'Sam' },
            ],
          }
        : { total: 1, rows: [{ ...ITEMS[2], groupId: 'g3', description: 'Dinner' }] }) as never)
    renderAt('/calendar?month=2026-10&day=2026-10-08')
    const legend = within(await screen.findByRole('list', { name: 'Groups' }))
    expect(await legend.findByText('Alex')).toBeTruthy()
    const list = within(screen.getByRole('region', { name: /Thursday.*2026/ }))
    expect((await list.findByRole('link')).textContent).toMatch(/Dinner.*Alex · Due/)
    // Wraps on a phone, so a long one isn't cut off at 320 px, and keeps to one line from md (#539).
    for (const text of ['Dinner', 'Alex']) {
      const classes = list.getByText(text).closest('[class~="md:truncate"]')?.className.split(' ')
      expect(classes, text).toContain('break-words')
      expect(classes, text).not.toContain('truncate')
    }
    expect(screen.queryByText(/Sam/)).toBeNull()
  })

  it('moves between months and back to today', async () => {
    const router = renderAt('/calendar?month=2026-12')
    await screen.findByRole('heading', { name: /December 2026/ })
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(await screen.findByRole('heading', { name: /January 2027/ })).toBeTruthy()
    expect(router.state.location.search).toBe('?month=2027-01')
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(await screen.findByRole('heading', { name: /November 2026/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(router.state.location.search).toBe('?month=2026-10&day=2026-10-18')
    expect(await screen.findByRole('region', { name: /Sunday.*2026/ })).toBeTruthy()
  })

  it('shows more than three items as "+n more" and pages past 100 rows', async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({
      ...ITEMS[1],
      $id: `t${index}`,
      date: '2026-10-05',
    }))
    listRows.mockResolvedValueOnce({ total: 101, rows: many.slice(0, 100) } as never)
    listRows.mockResolvedValueOnce({ total: 101, rows: many.slice(100) } as never)
    renderAt('/calendar?month=2026-10')
    expect(await screen.findByText('+98 more')).toBeTruthy()
    expect(listRows).toHaveBeenCalledTimes(2)
    expect(queriesOf(1)).toContainEqual({ method: 'cursorAfter', values: ['t99'] })
  })

  it('offers a retry when the transactions fail to load', async () => {
    listRows.mockRejectedValueOnce(new Error('offline'))
    renderAt('/calendar?month=2026-10')
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t load your calendar.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Morning shift')).toBeTruthy()
  })

  it("uses the browser's time zone when the profile can't be read, instead of loading forever", async () => {
    profileHook.mockReturnValue({ data: undefined, isError: true } as ReturnType<typeof useProfile>)
    renderAt('/calendar')
    expect(await screen.findByText('Morning shift')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeTruthy()
  })

  it('names the page while the month waits on the profile’s zone, and keeps that h1 once it loads', () => {
    profileHook.mockReturnValue({
      data: undefined,
      isError: false,
    } as ReturnType<typeof useProfile>)
    const router = renderAt('/calendar')
    const h1 = screen.getByRole('heading', { level: 1, name: 'Calendar' })
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(screen.queryByRole('button', { name: 'Previous month' })).toBeNull()

    // The zone arrives: the same h1 node stays, so focus a move put on it stays too.
    profileHook.mockReturnValue({
      data: { timezone: 'Australia/Sydney' },
      isError: false,
    } as ReturnType<typeof useProfile>)
    act(() => void router.navigate('/calendar'))
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Calendar' })).toBe(h1)
  })

  it('gives every group its own colour, by its place in the list', () => {
    const groups = Array.from({ length: 8 }, (_, index) => ({ $id: `g${index}` })) as Groups[]
    const colours = groupColours(groups)
    expect(new Set(colours.values()).size).toBe(8)
    expect(groupColours(groups).get('g3')).toBe(colours.get('g3'))
  })

  it('draws the two groups in different colours, in the legend and on the chips', async () => {
    renderAt('/calendar?month=2026-10')
    const thursday = within(
      await screen.findByRole('button', { name: /(October 8|8 October), 3 items/ }),
    )
    const shift = thursday.getByText('Shift').style.borderColor
    const rent = thursday.getByText('Rent').style.borderColor
    expect(shift).not.toBe('')
    expect(shift).not.toBe(rent)
  })

  it('draws a running shift dashed', async () => {
    listRows.mockResolvedValue({
      total: 1,
      rows: [{ ...ITEMS[0], $id: 't9', status: 'running', description: 'Timer' }],
    } as never)
    renderAt('/calendar?month=2026-10')
    expect((await screen.findByText('Timer')).className).toContain('border-dashed')
  })

  it("opens a day's month when only the day is given, and ignores a day the grid doesn't show", async () => {
    renderAt('/calendar?day=2026-12-25')
    expect(await screen.findByRole('heading', { name: /December 2026/ })).toBeTruthy()
    expect(await screen.findByRole('region', { name: /December.*2026/ })).toBeTruthy()
    cleanup()
    renderAt('/calendar?month=2026-10&day=2026-12-25')
    await screen.findByText('Morning shift')
    expect(screen.queryByRole('region')).toBeNull()
  })
})
