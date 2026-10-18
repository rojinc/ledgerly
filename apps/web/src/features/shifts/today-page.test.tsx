import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
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
    ownerPersonId: 'p1',
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

// The caller's role in each group, as their member rows say.
let roles: Record<string, Members['role']> = {}

/**
 * listRows answers `members` with `roles`, and `transactions` with `shifts` for the day query
 * and `running` for the running-timer query.
 */
function mockRows(shifts: Transactions[], running: Transactions[] = []) {
  listRows.mockImplementation((async ({
    tableId,
    queries,
  }: {
    tableId: string
    queries: string[]
  }) => {
    if (tableId === 'members') {
      const rows = Object.entries(roles).map(([groupId, role]) => ({
        groupId,
        personId: 'p1',
        role,
        status: 'active',
      }))
      return { total: rows.length, rows }
    }
    const rows = isRunningQuery(queries) ? running : shifts
    return { total: rows.length, rows }
  }) as never)
}

function transactionLists() {
  return listRows.mock.calls.filter(
    ([params]) => (params as unknown as { tableId: string }).tableId === 'transactions',
  ).length
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
  roles = { g1: 'admin', g2: 'admin' }
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
    expect(listRows).toHaveBeenCalledWith({
      databaseId: 'main',
      tableId: 'members',
      queries: [
        Query.equal('groupId', ['g1', 'g2']),
        Query.equal('personId', 'p1'),
        Query.limit(100),
      ],
    })
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

  it('uses a new id once the server has a timer with it, even if the start answer was lost', async () => {
    mockGroups([acme])
    mockRows([])
    // The server commits the timer, but the answer never arrives.
    call.mockImplementationOnce(async (...args: unknown[]) => {
      const { id } = args[3] as { id: string }
      mockRows([], [shift(id, { status: 'running', startedAt: '2026-10-18T21:58:55.000Z' })])
      throw new Error('Network lost')
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    // The refetch after the error shows the server's timer; stopping it posts it.
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy()
    call.mockImplementationOnce(async () => {
      mockRows([])
      return ok(shift('posted', {}))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    call.mockReturnValueOnce(new Promise(() => {}))
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3))
    const [first, , third] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(third).not.toBe(first)
  })

  it('ignores a timer left running in an archived group, and offers Start in the open one', async () => {
    mockGroups([employer('g1', 'Old Cafe', { archivedAt: '2026-10-01T00:00:00.000Z' }), bistro])
    roles = { g1: 'admin', g2: 'admin' }
    const stuck = shift('old', { status: 'running', startedAt: '2026-09-30T21:00:00.000Z' })
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      if (tableId === 'members') {
        const rows = Object.entries(roles).map(([groupId, role]) => ({
          groupId,
          personId: 'p1',
          role,
          status: 'active',
        }))
        return { total: rows.length, rows }
      }
      // Answers the running-timer query only for the archived group's ID.
      const rows = isRunningQuery(queries) && queries.some((q) => q.includes('"g1"')) ? [stuck] : []
      return { total: rows.length, rows }
    }) as never)
    renderPage()
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it("can't stop a timer before the server has it", async () => {
    mockGroups([acme])
    mockRows([])
    call.mockReturnValueOnce(new Promise(() => {}))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    const stop = (await screen.findByRole('button', { name: 'Stop' })) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    expect(screen.queryByRole('link', { name: /Open the shift/ })).toBeNull()
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

  it('has no Start and no Add a shift for an employer who only views the groups', async () => {
    roles = { g1: 'viewer', g2: 'viewer' }
    mockRows([shift('s1', { description: 'Café' })])
    renderPage()
    expect(await screen.findByText('Café')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Timer' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Add a shift' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New employer' })).toBeNull()
  })

  it('lets a member add a shift but not start the timer', async () => {
    roles = { g1: 'member' }
    mockRows([])
    renderPage()
    expect(await screen.findByRole('link', { name: 'Add a shift' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('starts the timer only in groups the caller owns as an admin', async () => {
    roles = { g1: 'member', g2: 'admin' }
    mockRows([])
    call.mockReturnValue(new Promise(() => {}))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    // One group to start in: no employer picker.
    expect(screen.queryByLabelText('Employer')).toBeNull()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({ groupId: 'g2' })
  })

  it("doesn't offer Start to an admin who isn't the group's owner (the worker)", async () => {
    // The employer joined as an admin of Sam's group: the shift would pay Sam, so only Sam starts.
    mockGroups([employer('g1', 'Acme Cafe', { ownerPersonId: 'p9' })])
    roles = { g1: 'admin' }
    mockRows([])
    renderPage()
    expect(await screen.findByRole('link', { name: 'Add a shift' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('links the running timer to its shift, to void it', async () => {
    mockRows([], [running])
    renderPage()
    expect(
      (
        await screen.findByRole('link', { name: 'Can’t stop it? Open the shift to void it' })
      ).getAttribute('href'),
    ).toBe('/shifts/r1')
  })

  it('keeps the typed break after a failed stop', async () => {
    mockRows([], [running])
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderPage()
    fireEvent.change(await screen.findByLabelText('Break (minutes)'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
    await act(async () => pending.resolve(failure('The shift is locked.')))
    await settle()
    expect((screen.getByLabelText('Break (minutes)') as HTMLInputElement).value).toBe('30')
  })

  it('disables Start while a stop is on its way', async () => {
    mockRows([], [running])
    call.mockReturnValue(new Promise(() => {}))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    const start = (await screen.findByRole('button', { name: 'Start' })) as HTMLButtonElement
    expect(start.disabled).toBe(true)
  })

  it('reloads today after a failed start, to show a timer started elsewhere', async () => {
    mockRows([])
    call.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'A timer is already running.' },
    })
    renderPage()
    const start = await screen.findByRole('button', { name: 'Start' })
    const before = transactionLists()
    mockRows([], [running])
    fireEvent.click(start)
    expect(await screen.findByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
    await waitFor(() => expect(transactionLists()).toBeGreaterThan(before))
    expect(screen.getByRole('timer').textContent).toBe('0:01:05')
  })

  it('clears the break after a successful start', async () => {
    mockRows([], [running])
    call.mockResolvedValueOnce(failure('Not running any more.'))
    const queryClient = renderPage()
    fireEvent.change(await screen.findByLabelText('Break (minutes)'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() =>
      expect((screen.getByLabelText('Break (minutes)') as HTMLInputElement).value).toBe('15'),
    )
    // It was stopped on another device: today reloads without it.
    mockRows([])
    await act(() => queryClient.invalidateQueries({ queryKey: ['today'] }))
    call.mockResolvedValueOnce(ok(running))
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    mockRows([], [shift('r2', { status: 'running', startedAt: NOW.toISOString() })])
    await act(() => queryClient.invalidateQueries({ queryKey: ['today'] }))
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('0:00:00'))
    expect((screen.getByLabelText('Break (minutes)') as HTMLInputElement).value).toBe('')
  })

  it('a new timer doesn’t show the stop error of the timer before it', async () => {
    mockRows([], [running])
    call.mockResolvedValueOnce(failure('Not running any more.'))
    const queryClient = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not running any more.')
    mockRows([])
    await act(() => queryClient.invalidateQueries({ queryKey: ['today'] }))
    call.mockResolvedValueOnce(ok(running))
    mockRows([], [shift('r2', { status: 'running', startedAt: NOW.toISOString() })])
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    await settle()
    expect(screen.getByRole('heading', { name: 'Timer running · Acme Cafe' })).toBeTruthy()
    expect(screen.queryByRole('alert')?.textContent).toBeUndefined()
  })

  it('Start doesn’t show the start error of an earlier attempt after a stop', async () => {
    mockRows([])
    call.mockResolvedValueOnce(failure('A timer is already running.'))
    renderPage()
    const start = await screen.findByRole('button', { name: 'Start' })
    // The failed start reloads today, which finds the timer started on another device.
    mockRows([], [running])
    fireEvent.click(start)
    const stop = await screen.findByRole('button', { name: 'Stop' })
    call.mockResolvedValueOnce(ok(running))
    mockRows([])
    fireEvent.click(stop)
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    await settle()
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
    expect(screen.queryByRole('alert')?.textContent).toBeUndefined()
  })
})
