import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useGroups } from '../groups/use-groups'
import { TodayPage } from './today-page'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { getRow: vi.fn(), listRows: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))

const call = vi.mocked(callFunction)
const listRows = vi.mocked(tablesDB.listRows)
const groupsHook = vi.mocked(useGroups)

// 22:00 UTC on 18 October: already the 19th in Sydney, still the 18th in New York.
const NOW = new Date('2026-10-18T22:00:00.000Z')

function employer(id: string, name: string, extra: Partial<Groups> = {}): Groups {
  return {
    $id: id,
    type: 'employer',
    name,
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    settingsJson: '{}',
    archivedAt: null,
    ...extra,
  } as Groups
}

const acme = employer('g1', 'Acme Cafe')
const bistro = employer('g2', 'Bistro', { currency: 'USD', timezone: 'America/New_York' })

function shift(id: string, extra: Partial<Transactions>): Transactions {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'shift',
    status: 'posted',
    date: '2026-10-19',
    description: 'Shift',
    totalCents: 0,
    statementId: null,
    startedAt: null,
    voidReason: null,
    createdBy: 'p1',
    ...extra,
  } as Transactions
}

const refetchGroups = vi.fn()

function mockGroups(groups: Groups[] | undefined, isError = false) {
  groupsHook.mockReturnValue({ data: groups, isError, refetch: refetchGroups } as never)
}

function isRunningQuery(queries: string[]) {
  return queries.includes(Query.equal('status', 'running'))
}

/** listRows answers with `shifts` for the day query and `running` for the running-timer query. */
function mockRows(shifts: Transactions[], running: Transactions[] = []) {
  listRows.mockImplementation((async ({ queries }: { queries: string[] }) => {
    const rows = isRunningQuery(queries) ? running : shifts
    return { total: rows.length, rows }
  }) as never)
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <TodayPage /> }])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return queryClient
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function ok(transaction: Transactions): Result<unknown> {
  return { ok: true, data: { transaction, shares: [], items: [] } }
}

function failure(message: string): Result<unknown> {
  return { ok: false, error: { code: 'CONFLICT', message } }
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

const running = shift('r1', {
  status: 'running',
  date: '2026-10-19',
  startedAt: '2026-10-18T21:58:55.000Z',
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  mockGroups([acme, bistro])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('TodayPage', () => {
  it('lists today’s shifts by each group’s own date, with status and amount', async () => {
    mockRows([
      shift('s1', { groupId: 'g1', date: '2026-10-19', description: 'Café', totalCents: 20400 }),
      shift('s2', {
        groupId: 'g2',
        date: '2026-10-18',
        status: 'scheduled',
        description: 'Dinner',
        totalCents: 15000,
      }),
      // Yesterday in Sydney and tomorrow in New York: not today in their own group.
      shift('s3', { groupId: 'g1', date: '2026-10-18', description: 'Old' }),
      shift('s4', { groupId: 'g2', date: '2026-10-19', description: 'Next' }),
    ])
    renderPage()
    const list = await screen.findByRole('list')
    const items = within(list).getAllByRole('link')
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['/shifts/s2', '/shifts/s1'])
    expect(items[0]?.textContent).toMatch(/^DinnerBistro · Scheduled.*150\.00$/)
    expect(items[1]?.textContent).toMatch(/^CaféAcme Cafe · Confirmed.*204\.00$/)
    expect(screen.queryByText('Old')).toBeNull()
    expect(screen.queryByText('Next')).toBeNull()

    const queries = listRows.mock.calls.map(
      ([params]) => (params as unknown as { queries: string[] }).queries,
    )
    expect(listRows).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: 'main', tableId: 'transactions' }),
    )
    expect(queries).toContainEqual([
      Query.equal('groupId', ['g1', 'g2']),
      Query.greaterThanEqual('date', '2026-10-18'),
      Query.lessThanEqual('date', '2026-10-19'),
      Query.equal('kind', 'shift'),
      Query.orderAsc('date'),
      Query.limit(100),
    ])
    expect(queries).toContainEqual([
      Query.equal('groupId', ['g1', 'g2']),
      Query.equal('status', 'running'),
      Query.orderAsc('date'),
      Query.limit(100),
    ])
    expect(screen.getByRole('link', { name: 'Add a shift' }).getAttribute('href')).toBe(
      '/shifts/new',
    )
  })

  it('says when there are no shifts today', async () => {
    mockRows([])
    renderPage()
    expect(await screen.findByText('No shifts today.')).toBeTruthy()
  })

  it('shows a started timer at once, then sends POST /timer/start', async () => {
    mockGroups([acme])
    mockRows([])
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderPage()
    // One employer: no employer picker.
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    expect(screen.queryByLabelText('Employer')).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('0:00:00')
    expect(call).toHaveBeenCalledTimes(1)
    const body = call.mock.calls[0]?.[3] as { id: string }
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/timer/start', body)
    expect(body).toStrictEqual({ id: body.id, groupId: 'g1' })
    expect(body.id).toMatch(/^[a-zA-Z0-9]/)
    mockRows([], [shift(body.id, { status: 'running', startedAt: NOW.toISOString() })])
    await act(async () => pending.resolve(ok(running)))
    await settle()
    expect(screen.getByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
  })

  it('starts the timer in the chosen employer', async () => {
    mockRows([])
    call.mockReturnValue(new Promise(() => {}))
    renderPage()
    fireEvent.change(await screen.findByLabelText('Employer'), { target: { value: 'g2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('heading', { name: 'Timer running · Bistro' })).toBeTruthy()
    expect(call.mock.calls[0]?.[3]).toMatchObject({ groupId: 'g2' })
  })

  it('puts Start back with the error when starting fails, and retries with the same id and employer', async () => {
    mockRows([])
    const pending = deferred<Result<unknown>>()
    call.mockReturnValueOnce(pending.promise)
    renderPage()
    fireEvent.change(await screen.findByLabelText('Employer'), { target: { value: 'g2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('heading', { name: 'Timer running · Bistro' })).toBeTruthy()
    await act(async () => pending.resolve(failure('A timer is already running.')))
    await settle()
    expect(screen.getByRole('heading', { name: 'Timer' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('A timer is already running.')
    expect((screen.getByLabelText('Employer') as HTMLSelectElement).value).toBe('g2')

    call.mockReturnValueOnce(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const [first, second] = call.mock.calls.map((args) => args[3] as { id: string })
    expect(second).toStrictEqual(first)
    expect(second).toMatchObject({ groupId: 'g2' })
  })

  it('uses a new id for the next start after a successful one', async () => {
    mockGroups([acme])
    mockRows([])
    call.mockResolvedValue(ok(running))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    // The refetch after the start finds no running timer, so Start is back.
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const [first, second] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).not.toBe(first)
  })

  it('shows the running time from startedAt, ticking each second', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    mockRows([], [running])
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('0:01:05')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('timer').textContent).toBe('0:01:06')
    act(() => vi.advanceTimersByTime(3600 * 1000))
    expect(screen.getByRole('timer').textContent).toBe('1:01:06')
  })

  it('still shows a timer started yesterday', async () => {
    mockRows(
      [],
      [
        shift('r0', {
          status: 'running',
          date: '2026-10-18',
          startedAt: '2026-10-17T20:00:00.000Z',
        }),
      ],
    )
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('26:00:00')
  })

  it('ignores a running timer someone else started', async () => {
    mockRows([], [shift('r2', { status: 'running', createdBy: 'p2' })])
    renderPage()
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
  })

  it.each([
    ['30', { transactionId: 'r1', breakMinutes: 30 }],
    [' ', { transactionId: 'r1' }],
  ])('stops with the break %j', async (text, body) => {
    mockRows([], [running])
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderPage()
    fireEvent.change(await screen.findByLabelText('Break (minutes)'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    // Shown as stopped at once.
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]).toStrictEqual(['ledger', 'POST', '/timer/stop', body])
  })

  it('refuses a break that isn’t whole minutes and sends nothing', async () => {
    mockRows([], [running])
    renderPage()
    fireEvent.change(await screen.findByLabelText('Break (minutes)'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect((await screen.findByText('Enter whole minutes')).id).toBe('timerBreak-error')
    expect(screen.getByLabelText('Break (minutes)').getAttribute('aria-describedby')).toBe(
      'timerBreak-error',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('puts the running timer back with the error when stopping fails', async () => {
    mockRows([], [running])
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
    await act(async () => pending.resolve(failure('The shift is locked.')))
    await settle()
    expect(screen.getByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('The shift is locked.')
  })

  it('shows a load error and tries again', async () => {
    listRows.mockRejectedValueOnce(new Error('offline'))
    renderPage()
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t load today’s shifts.')
    mockRows([])
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No shifts today.')).toBeTruthy()
  })

  it('tries the groups again when they could not be loaded', () => {
    mockGroups(undefined, true)
    renderPage()
    expect(screen.getByRole('alert').textContent).toBe('We couldn’t load today’s shifts.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetchGroups).toHaveBeenCalledTimes(1)
  })

  it('keeps today’s shifts when a background refetch fails', async () => {
    mockGroups([acme])
    mockRows([shift('s1', { description: 'Café' })])
    const queryClient = renderPage()
    expect(await screen.findByText('Café')).toBeTruthy()
    listRows.mockRejectedValue(new Error('offline'))
    await act(() => queryClient.refetchQueries({ queryKey: ['today'] }))
    await settle()
    expect(screen.getByText('Café')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('links to a new employer when the user has no open employer groups', async () => {
    mockGroups([
      employer('g3', 'Flat', { type: 'house' }),
      employer('g4', 'Old job', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    mockRows([])
    renderPage()
    expect((await screen.findByRole('link', { name: 'New employer' })).getAttribute('href')).toBe(
      '/groups/new-employer',
    )
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Add a shift' })).toBeNull()
  })
})
