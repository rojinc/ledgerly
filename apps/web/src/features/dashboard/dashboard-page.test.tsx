import type { Groups } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useGroups } from '../groups/use-groups'
import { useProfile } from '../profile/use-profile'
import { DashboardPage } from './dashboard-page'

vi.mock('../../lib/appwrite', () => ({ DATABASE_ID: 'main', tablesDB: { listRows: vi.fn() } }))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({
  useCurrentUser: () => ({ data: { $id: 'u1', name: 'Sam' } }),
}))
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: 'p1', personalGroupId: 'g3' } }),
}))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn() }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))
// This user has entries, so no guide and no extra read: onboarding/ tests the guide (#52).
vi.mock('../onboarding/use-onboarding', async (original) => ({
  ...(await original<typeof import('../onboarding/use-onboarding')>()),
  useHasEntry: () => ({ data: true }),
}))

const listRows = vi.mocked(tablesDB.listRows)
const call = vi.mocked(callFunction)
const groupsHook = vi.mocked(useGroups)
const profileHook = vi.mocked(useProfile)

const GROUPS = [
  { $id: 'g1', name: 'Acme Cafe', type: 'employer', currency: 'AUD', archivedAt: null },
  { $id: 'g2', name: 'Flat', type: 'house', currency: 'AUD', archivedAt: null },
  { $id: 'g3', name: 'Personal', type: 'personal', currency: 'AUD', archivedAt: null },
  { $id: 'g4', name: 'Kiwi Bar', type: 'employer', currency: 'NZD', archivedAt: '2026-09-01' },
] as Groups[]

const NETS: Record<string, number> = { g1: 71500, g2: -2050, g3: 0, g4: 30000 }

let id = 0
function share(
  groupId: string,
  date: string,
  kind: string,
  given: number,
  received: number,
  category: string | null = null,
) {
  id += 1
  return {
    $id: `s${id}`,
    personId: 'p1',
    groupId,
    date,
    kind,
    category,
    givenCents: given,
    receivedCents: received,
  }
}

// October 2026 in AUD and NZD, and a little in September.
const SHARES = [
  share('g1', '2026-10-02', 'shift', 12500, 0),
  share('g1', '2026-10-09', 'payment', 0, 50000),
  share('g2', '2026-10-01', 'bill', 0, 40000, 'rent'),
  share('g2', '2026-10-05', 'expense', 0, 3550, 'groceries'),
  share('g3', '2026-10-06', 'expense', 0, 1200, null),
  share('g3', '2026-10-20', 'income', 0, 9900),
  // Someone else's share in a shared group never counts.
  { ...share('g2', '2026-10-05', 'expense', 0, 99999, 'groceries'), personId: 'p2' },
  share('g4', '2026-10-03', 'shift', 20000, 0),
  share('g4', '2026-10-10', 'payment', 0, 15000),
  share('g2', '2026-09-30', 'bill', 0, 40000, 'rent'),
]

function profile(timezone: string) {
  profileHook.mockReturnValue({ data: { timezone }, isError: false } as never)
}

function renderPage(path = '/') {
  const router = createMemoryRouter([{ path: '/', element: <DashboardPage /> }], {
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

// Every request's arguments, in order.
function requests() {
  // The object form; the mock also types the old positional one.
  return listRows.mock.calls.map(
    (call) => call[0] as unknown as { tableId: string; queries?: string[] },
  )
}

// The date bounds of every shares request, in order.
function shareRanges(): string[][] {
  return requests().map((args) =>
    (args.queries ?? []).filter((query) => /"(greaterThanEqual|lessThanEqual)"/.test(query)),
  )
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Still Saturday 17 October in Sydney, Los Angeles and UTC.
  vi.setSystemTime(new Date('2026-10-17T20:00:00.000Z'))
  groupsHook.mockReturnValue({ data: GROUPS, isError: false, refetch: vi.fn() } as never)
  profile('Australia/Sydney')
  call.mockImplementation(async (_fn, _method, path) => {
    const groupId = path.split('/')[2] ?? ''
    return {
      ok: true as const,
      data: { people: [{ personId: 'p1', netCents: NETS[groupId] ?? 0 }], transfers: [] },
    }
  })
  listRows.mockResolvedValue({ total: SHARES.length, rows: SHARES } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('DashboardPage: owed to me / I owe', () => {
  it('shows each group with its type and balance from /balances, and totals per currency', async () => {
    renderPage()
    const section = screen.getByRole('region', { name: 'Owed to me / I owe' })
    const rows = within(section).getAllByRole('listitem')
    // While loading, the dots are hidden and a screen reader hears what's coming.
    expect(within(section).getAllByText('Loading balance')).toHaveLength(4)
    expect(rows.map((row) => within(row).getAllByText(/./)[0]?.textContent)).toEqual([
      'Acme Cafe',
      'Flat',
      'Personal',
      'Kiwi Bar',
    ])
    expect(await within(rows[0] as HTMLElement).findByText(/^Owed .*715\.00$/)).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText('Employer')).toBeTruthy()
    expect(await within(rows[1] as HTMLElement).findByText(/^You owe .*20\.50$/)).toBeTruthy()
    expect(await within(rows[2] as HTMLElement).findByText('Settled')).toBeTruthy()
    expect(within(rows[3] as HTMLElement).getByText('Employer · Archived')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('ledger', 'GET', '/groups/g1/balances')
    expect(call).toHaveBeenCalledTimes(4)

    // Never added across currencies.
    const aud = (await within(section).findByText('Total in AUD:')).parentElement as HTMLElement
    expect(aud.textContent).toMatch(/owed to you .*715\.00 · you owe .*20\.50$/)
    const nzd = within(section).getByText('Total in NZD:').parentElement as HTMLElement
    expect(nzd.textContent).toMatch(/owed to you .*300\.00 · you owe .*0\.00$/)
  })

  it('names a pair group by its other member (#149)', async () => {
    // Alex added the viewer, so the group's own name is the viewer's.
    groupsHook.mockReturnValue({
      data: [{ $id: 'g5', name: 'Sam', type: 'pair', currency: 'AUD', archivedAt: null }],
      isError: false,
      refetch: vi.fn(),
    } as never)
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) =>
      tableId === 'members'
        ? {
            total: 2,
            rows: [
              { $id: 'm1', groupId: 'g5', personId: 'p2', displayName: 'Alex' },
              { $id: 'm2', groupId: 'g5', personId: 'p1', displayName: 'Sam' },
            ],
          }
        : { total: 0, rows: [] }) as never)
    renderPage()
    const section = screen.getByRole('region', { name: 'Owed to me / I owe' })
    expect(await within(section).findByText('Alex')).toBeTruthy()
    expect(within(section).queryByText('Sam')).toBeNull()
  })

  it('shows no totals while a balance is missing, and says so', async () => {
    call.mockImplementation(async (_fn, _method, path) =>
      path === '/groups/g2/balances'
        ? { ok: false as const, error: { code: 'INTERNAL', message: 'down' } }
        : { ok: true as const, data: { people: [], transfers: [] } },
    )
    renderPage()
    const section = screen.getByRole('region', { name: 'Owed to me / I owe' })
    expect(await within(section).findByText('Balance not available yet')).toBeTruthy()
    expect(within(section).getByText(/Totals show once every group/)).toBeTruthy()
    expect(within(section).queryByText(/^Total in/)).toBeNull()
  })
})

describe('DashboardPage: this month', () => {
  it('reports the month from the user’s shares, one section per currency', async () => {
    renderPage()
    const aud = await screen.findByRole('region', { name: 'AUD' })
    const value = (scope: HTMLElement, label: string) =>
      within(scope).getByText(label).nextElementSibling?.textContent
    // Rent 400.00 + groceries 35.50 + no category 12.00; p2's share isn't counted.
    expect(value(aud, 'Spending')).toMatch(/447\.50$/)
    // Employer payment 500.00 + personal income 99.00.
    expect(value(aud, 'Income')).toMatch(/599\.00$/)
    expect(value(aud, 'From employers')).toMatch(/500\.00$/)
    expect(value(aud, 'Personal income')).toMatch(/99\.00$/)
    expect(value(aud, 'Earnings from shifts')).toMatch(/125\.00$/)
    // Categories largest first, each amount written out.
    const categories = within(aud).getAllByRole('listitem')
    expect(categories.map((item) => item.textContent?.replace(/[^A-Za-z0-9.]/g, ''))).toEqual([
      expect.stringMatching(/^Rent.*400\.00$/),
      expect.stringMatching(/^Groceries.*35\.50$/),
      expect.stringMatching(/^Nocategory.*12\.00$/),
    ])

    const nzd = screen.getByRole('region', { name: 'NZD' })
    expect(value(nzd, 'Spending')).toMatch(/0\.00$/)
    expect(value(nzd, 'Income')).toMatch(/150\.00$/)
    expect(value(nzd, 'Earnings from shifts')).toMatch(/200\.00$/)
  })

  it('reads the shares with personId = me over the 6 months, in cursor pages of 100', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...share('g3', '2026-10-06', 'expense', 0, 100, 'food'),
      $id: `x${index}`,
    }))
    listRows.mockResolvedValueOnce({ total: 101, rows: page } as never).mockResolvedValueOnce({
      total: 101,
      rows: [share('g3', '2026-10-07', 'expense', 0, 100, 'food')],
    } as never)
    renderPage()
    const aud = await screen.findByRole('region', { name: 'AUD' })
    expect(within(aud).getByText('Spending').nextElementSibling?.textContent).toMatch(/101\.00$/)
    expect(listRows).toHaveBeenCalledTimes(2)
    const [first, second] = requests()
    expect(first?.tableId).toBe('shares')
    expect(first?.queries).toEqual(
      expect.arrayContaining([
        Query.equal('personId', 'p1'),
        Query.greaterThanEqual('date', '2026-05-01'),
        Query.lessThanEqual('date', '2026-10-31'),
        Query.select([
          '$id',
          'personId',
          'groupId',
          'date',
          'kind',
          'category',
          'givenCents',
          'receivedCents',
        ]),
        Query.limit(100),
      ]),
    )
    expect(first?.queries?.some((query) => query.includes('cursorAfter'))).toBe(false)
    expect(second?.queries).toContain(Query.cursorAfter('x99'))
  })

  it.each([
    // 1 November in Sydney, still 31 October in UTC and Los Angeles.
    ['Australia/Sydney', '2026-10-31T14:00:00.000Z', '2026-06-01', '2026-11-30'],
    ['America/Los_Angeles', '2026-11-01T06:00:00.000Z', '2026-05-01', '2026-10-31'],
    ['UTC', '2026-10-31T23:59:00.000Z', '2026-05-01', '2026-10-31'],
  ])('takes today’s month in the profile zone %s', async (timezone, now, start, end) => {
    vi.setSystemTime(new Date(now))
    profile(timezone)
    renderPage()
    await screen.findByRole('region', { name: 'Last 6 months' })
    expect(shareRanges()[0]).toEqual([
      Query.greaterThanEqual('date', start),
      Query.lessThanEqual('date', end),
    ])
  })

  it('says when a month has nothing in it', async () => {
    renderPage('/?month=2026-08')
    expect(await screen.findByText(/^Nothing recorded in August 2026\.$/)).toBeTruthy()
    // August is one of the last 6 months, so the history stays.
    expect(screen.getByRole('region', { name: 'Last 6 months' })).toBeTruthy()
  })

  it('shows the guide’s first step when there are no groups (#52)', async () => {
    groupsHook.mockReturnValue({ data: [], isError: false, refetch: vi.fn() } as never)
    profileHook.mockReturnValue({
      data: { timezone: 'Australia/Sydney', region: 'AU-NSW', currency: 'AUD' },
      isError: false,
    } as never)
    call.mockResolvedValue({ ok: true, data: { groups: [] } })
    renderPage()
    expect(screen.getByRole('heading', { name: 'What do you want to track first?' })).toBeTruthy()
    expect(screen.queryByText(/Nothing here yet/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Owed to me / I owe' })).toBeNull()
    expect(listRows).not.toHaveBeenCalled()
    // Only the pending groups, which the first step shows first.
    await waitFor(() => expect(call).toHaveBeenCalledWith('identity', 'GET', '/groups/pending'))
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('asks to try again when a share’s group isn’t in the list yet, and reloads both', async () => {
    const refetch = vi.fn()
    groupsHook.mockReturnValue({ data: GROUPS.slice(0, 3), isError: false, refetch } as never)
    renderPage()
    expect(await screen.findByText('We couldn’t load your spending and income.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
    await waitFor(() => expect(listRows).toHaveBeenCalledTimes(2))
  })

  it('asks to try again when the shares can’t be read', async () => {
    listRows.mockRejectedValueOnce(new Error('down'))
    renderPage()
    expect(await screen.findByText('We couldn’t load your spending and income.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('region', { name: 'AUD' })).toBeTruthy()
    expect(listRows).toHaveBeenCalledTimes(2)
  })
})

describe('DashboardPage: last 6 months', () => {
  it('lists spending and income per month per currency, and tapping one selects it', async () => {
    const router = renderPage()
    const history = await screen.findByRole('region', { name: 'Last 6 months' })
    const aud = within(history).getByRole('region', { name: 'Last 6 months in AUD' })
    const months = within(aud).getAllByRole('button')
    expect(months).toHaveLength(6)
    expect(months[0]?.textContent).toMatch(/May 2026/)
    expect(months[5]?.textContent).toMatch(/Oct 2026.*Spent .*447\.50 · Income .*599\.00$/)
    expect(months[4]?.textContent).toMatch(/Sep 2026.*Spent .*400\.00 · Income .*0\.00$/)
    expect(months[5]?.getAttribute('aria-pressed')).toBe('true')
    expect(within(history).getByRole('region', { name: 'Last 6 months in NZD' })).toBeTruthy()

    fireEvent.click(months[4] as HTMLElement)
    expect(router.state.location.search).toBe('?month=2026-09')
    expect(await screen.findByRole('heading', { level: 2, name: 'September 2026' })).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: 'AUD' })).getByText('Spending').nextElementSibling
        ?.textContent,
    ).toMatch(/400\.00$/)
    expect(months[4]?.getAttribute('aria-pressed')).toBe('true')
    // Same 6 months, so no new read.
    expect(listRows).toHaveBeenCalledTimes(1)
  })

  it('moves the 6 months forward with Next month', async () => {
    const router = renderPage()
    await screen.findByRole('heading', { level: 2, name: 'October 2026' })
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(router.state.location.search).toBe('?month=2026-11')
    await screen.findByRole('heading', { level: 2, name: 'November 2026' })
    expect(shareRanges()[1]).toEqual([
      Query.greaterThanEqual('date', '2026-06-01'),
      Query.lessThanEqual('date', '2026-11-30'),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(router.state.location.search).toBe('?month=2026-10')
  })

  it.each([
    ['Next month', '/', 'November 2026'],
    ['Previous month', '/?month=2026-05', 'April 2026'],
    ['This month', '/?month=2026-03', 'October 2026'],
  ])('keeps focus on %s while a new 6 months load', async (name, path, heading) => {
    renderPage(path)
    const button = (await screen.findByRole('button', { name })) as HTMLButtonElement
    await screen.findByRole('region', { name: /^Last 6 months$/ })
    // The next read waits, so the page is loading when focus is checked.
    const pending = deferred()
    listRows.mockReturnValueOnce(pending.promise as never)
    button.focus()
    fireEvent.click(button)
    expect(await screen.findByRole('heading', { level: 2, name: heading })).toBeTruthy()
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(document.activeElement).toBe(button)
    await act(async () => pending.resolve({ total: SHARES.length, rows: SHARES }))
    expect(await screen.findByRole('region', { name: /^Last 6 months$/ })).toBeTruthy()
    expect(document.activeElement).toBe(button)
  })

  it('ignores a month before the year 100 in the link', async () => {
    renderPage('/?month=0050-01')
    expect(await screen.findByRole('heading', { level: 2, name: 'October 2026' })).toBeTruthy()
  })

  it('moves the 6 months to end at a chosen month outside them', async () => {
    renderPage('/?month=2026-03')
    await screen.findByRole('heading', { level: 2, name: 'March 2026' })
    expect(shareRanges()[0]).toEqual([
      Query.greaterThanEqual('date', '2025-10-01'),
      Query.lessThanEqual('date', '2026-03-31'),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'This month' }))
    await screen.findByRole('heading', { level: 2, name: 'October 2026' })
    expect(shareRanges()[1]).toEqual([
      Query.greaterThanEqual('date', '2026-05-01'),
      Query.lessThanEqual('date', '2026-10-31'),
    ])
  })
})
