import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useGroup, useGroups, useMyMember } from '../groups/use-groups'
import { shiftRoutes } from './routes'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { getRow: vi.fn(), listRows: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
vi.mock('../groups/use-groups', () => ({
  useGroups: vi.fn(),
  useGroup: vi.fn(),
  useMyMember: vi.fn(),
}))

const call = vi.mocked(callFunction)
const getRow = vi.mocked(tablesDB.getRow)
const groupsHook = vi.mocked(useGroups)
const groupHook = vi.mocked(useGroup)
const memberHook = vi.mocked(useMyMember)

// 22:00 UTC on 18 October: already the 19th in Sydney, still the 18th in New York.
const NOW = new Date('2026-10-18T22:00:00.000Z')

function employer(id: string, name: string, extra: Partial<Groups> = {}): Groups {
  return {
    $id: id,
    type: 'employer',
    name,
    ownerPersonId: 'p1',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: 'weekly',
    cycleAnchor: '2026-10-05',
    nextCloseAt: null,
    settingsJson: JSON.stringify({
      type: 'employer',
      defaultRateCents: 2550,
      paymentTermsDays: 7,
      autoFinalize: false,
      recipients: [],
    }),
    archivedAt: null,
    ...extra,
  } as Groups
}

const acme = employer('g1', 'Acme Cafe')
const bistro = employer('g2', 'Bistro', {
  currency: 'USD',
  timezone: 'America/New_York',
  settingsJson: JSON.stringify({
    type: 'employer',
    defaultRateCents: 3000,
    paymentTermsDays: 14,
    autoFinalize: false,
    recipients: [],
  }),
})

const storedShift = {
  minutes: 480,
  rateCents: 2550,
  breakMinutes: 30,
  startTime: '09:00',
  endTime: '17:30',
}

function shiftRow(extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: 't1',
    groupId: 'g1',
    kind: 'shift',
    status: 'posted',
    date: '2026-10-15',
    description: 'Morning shift',
    category: null,
    totalCents: 20400,
    inputJson: JSON.stringify({
      payers: [{ personId: 'p1', cents: 20400 }],
      shift: storedShift,
    }),
    dueOn: null,
    scheduleId: null,
    overridden: false,
    statementId: null,
    receiptFileIds: null,
    startedAt: null,
    remindedAt: null,
    voidReason: null,
    createdBy: 'p1',
    updatedBy: 'p1',
    ...extra,
  } as Transactions
}

function mockGroups(groups: Groups[] | undefined, isError = false) {
  groupsHook.mockReturnValue({ data: groups, isError } as ReturnType<typeof useGroups>)
}

function mockGroup(group: Groups, role: Members['role'] | null = 'admin') {
  groupHook.mockReturnValue({ data: group, isError: false } as ReturnType<typeof useGroup>)
  memberHook.mockReturnValue({
    data: role ? ({ role } as Members) : null,
    isError: false,
  } as ReturnType<typeof useMyMember>)
}

function mockRow(row: Transactions) {
  getRow.mockResolvedValue(row as never)
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/', children: shiftRoutes.children },
      { path: '/groups/new-employer', element: <p>New employer page</p> },
    ],
    { initialEntries: [path] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function input(label: string | RegExp) {
  return screen.getByLabelText(label) as HTMLInputElement
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function view(transaction: Transactions): Result<unknown> {
  return { ok: true, data: { transaction, shares: [], items: [] } }
}

function failure(message: string): Result<unknown> {
  return { ok: false, error: { code: 'CONFLICT', message } }
}

function sentBody(index = 0) {
  return call.mock.calls[index]?.[3] as Record<string, unknown> & { id: string }
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  mockGroups([acme])
  mockGroup(acme)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('NewShiftPage', () => {
  it('sends the exact shift for start and end times, then opens the shift', async () => {
    call.mockImplementation(async (_fn, _method, _path, body) =>
      view(shiftRow({ $id: (body as { id: string }).id, status: 'posted' })),
    )
    getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
      shiftRow({ $id: rowId })) as never)
    const { router } = renderAt('/shifts/new')
    expect(screen.getByRole('heading', { name: 'New shift' })).toBeTruthy()
    // One employer: no employer picker.
    expect(screen.queryByLabelText('Employer')).toBeNull()
    expect(input('Date').value).toBe('2026-10-19')
    expect(input('Description').value).toBe('Shift')
    expect(input('Hourly rate (AUD)').value).toBe('25.50')

    type('Description', '  Morning  ')
    type('Start', '09:00')
    type('End', '17:30')
    type('Break (minutes)', '30')
    expect(screen.getByText(/^8 h 0 min paid · .*204\.00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = sentBody()
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions', body)
    expect(body).toStrictEqual({
      id: body.id,
      groupId: 'g1',
      kind: 'shift',
      date: '2026-10-19',
      description: 'Morning',
      shift: {
        minutes: 480,
        rateCents: 2550,
        breakMinutes: 30,
        startTime: '09:00',
        endTime: '17:30',
      },
    })
    expect(body.id).toMatch(/^[a-zA-Z0-9]/)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/shifts/${body.id}`))
  })

  it.each([
    ['7:30', 450],
    ['7.5', 450],
  ])('sends hours %j as %i minutes with no times or break', async (hours, minutes) => {
    call.mockResolvedValue(view(shiftRow()))
    mockRow(shiftRow())
    renderAt('/shifts/new')
    type('Break (minutes)', '30')
    fireEvent.click(screen.getByLabelText('Hours'))
    type('Hours worked', hours)
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().shift).toStrictEqual({ minutes, rateCents: 2550 })
  })

  it('counts an end before the start as the next day', async () => {
    call.mockResolvedValue(view(shiftRow()))
    mockRow(shiftRow())
    renderAt('/shifts/new')
    type('Start', '22:00')
    type('End', '06:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().shift).toStrictEqual({
      minutes: 480,
      rateCents: 2550,
      startTime: '22:00',
      endTime: '06:00',
    })
  })

  it('uses the date in the URL instead of today', () => {
    renderAt('/shifts/new?date=2026-09-30')
    expect(input('Date').value).toBe('2026-09-30')
  })

  it('takes today in the chosen group’s own time zone', () => {
    mockGroups([acme, bistro])
    renderAt('/shifts/new?groupId=g2')
    expect(input('Employer').value).toBe('g2')
    expect(input('Date').value).toBe('2026-10-18')
    expect(input('Hourly rate (USD)').value).toBe('30.00')
  })

  it('updates an untouched rate when the employer changes, but not a typed one', async () => {
    mockGroups([acme, bistro])
    call.mockResolvedValue(view(shiftRow()))
    mockRow(shiftRow())
    renderAt('/shifts/new')
    expect(input('Employer').value).toBe('g1')
    expect(input('Hourly rate (AUD)').value).toBe('25.50')
    type('Employer', 'g2')
    expect(input('Hourly rate (USD)').value).toBe('30.00')
    type('Employer', 'g1')
    expect(input('Hourly rate (AUD)').value).toBe('25.50')
    type('Hourly rate (AUD)', '28')
    type('Employer', 'g2')
    expect(input('Hourly rate (USD)').value).toBe('28')

    type('Start', '09:00')
    type('End', '10:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody()).toMatchObject({
      groupId: 'g2',
      shift: { minutes: 60, rateCents: 2800 },
    })
  })

  it('shows Required on a missing start and end and sends nothing', async () => {
    renderAt('/shifts/new')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findAllByText('Required')).map((error) => error.id)).toEqual([
      'startTime-error',
      'endTime-error',
    ])
    expect(input('Start').getAttribute('aria-describedby')).toBe('startTime-error')
    expect(input('Start').getAttribute('aria-invalid')).toBe('true')
    expect(input('End').getAttribute('aria-describedby')).toBe('endTime-hint endTime-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a break longer than the shift', async () => {
    renderAt('/shifts/new')
    type('Start', '09:00')
    type('End', '10:00')
    type('Break (minutes)', '90')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByText('The break is longer than the shift')).id).toBe(
      'breakMinutes-error',
    )
    expect(input('Break (minutes)').getAttribute('aria-describedby')).toBe('breakMinutes-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a break that isn’t whole minutes', async () => {
    renderAt('/shifts/new')
    type('Start', '09:00')
    type('End', '10:00')
    type('Break (minutes)', '1.5')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByText('Enter whole minutes')).id).toBe('breakMinutes-error')
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'Required'],
    ['abc', 'Enter hours like 7.5 or 7:30'],
    ['7:75', 'Enter hours like 7.5 or 7:30'],
    ['25', 'At most 24 hours'],
  ])('shows an inline error for the hours %j and sends nothing', async (hours, message) => {
    renderAt('/shifts/new')
    fireEvent.click(screen.getByLabelText('Hours'))
    type('Hours worked', hours)
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByText(message)).id).toBe('hours-error')
    expect(input('Hours worked').getAttribute('aria-describedby')).toBe('hours-hint hours-error')
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'Required'],
    ['abc', 'Enter an amount like 25.50'],
    ['25.555', 'Enter an amount like 25.50'],
  ])('shows an inline error for the rate %j and sends nothing', async (rate, message) => {
    renderAt('/shifts/new')
    type('Start', '09:00')
    type('End', '17:00')
    type('Hourly rate (AUD)', rate)
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByText(message)).id).toBe('rate-error')
    expect(input('Hourly rate (AUD)').getAttribute('aria-describedby')).toBe('rate-error')
    expect(input('Hourly rate (AUD)').getAttribute('aria-invalid')).toBe('true')
    expect(call).not.toHaveBeenCalled()
  })

  it('shows the function error and retries with the same id', async () => {
    call.mockResolvedValueOnce(failure('The ledger is busy.'))
    call.mockImplementationOnce(async (_fn, _method, _path, body) =>
      view(shiftRow({ $id: (body as { id: string }).id })),
    )
    mockRow(shiftRow())
    const { router } = renderAt('/shifts/new')
    type('Start', '09:00')
    type('End', '17:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The ledger is busy.')
    expect(router.state.location.pathname).toBe('/shifts/new')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(sentBody(1).id).toBe(sentBody(0).id)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/shifts/${sentBody(0).id}`))
  })

  it('links to a new employer when the user has no employer groups', () => {
    mockGroups([
      employer('g3', 'Flat', { type: 'house' }),
      employer('g4', 'Old job', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    renderAt('/shifts/new')
    expect(screen.getByRole('link', { name: 'New employer' }).getAttribute('href')).toBe(
      '/groups/new-employer',
    )
    expect(screen.queryByRole('button', { name: 'Add shift' })).toBeNull()
  })

  it('says when the groups are loading or could not be loaded', () => {
    mockGroups(undefined)
    renderAt('/shifts/new')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    cleanup()
    mockGroups(undefined, true)
    renderAt('/shifts/new')
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t load your groups/)
  })
})

describe('ShiftPage', () => {
  it('starts from the stored shift and saves it with a PATCH and the same id', async () => {
    mockRow(shiftRow())
    call.mockResolvedValue(view(shiftRow({ description: 'Late shift' })))
    renderAt('/shifts/t1')
    expect(await screen.findByRole('heading', { name: 'Morning shift' })).toBeTruthy()
    expect(screen.getByText('Confirmed.')).toBeTruthy()
    expect(input('Date').value).toBe('2026-10-15')
    expect(input('Description').value).toBe('Morning shift')
    expect(input('Start and end').checked).toBe(true)
    expect(input('Start').value).toBe('09:00')
    expect(input('End').value).toBe('17:30')
    expect(input('Break (minutes)').value).toBe('30')
    expect(input('Hourly rate (AUD)').value).toBe('25.50')
    expect(getRow).toHaveBeenCalledWith({
      databaseId: 'main',
      tableId: 'transactions',
      rowId: 't1',
    })

    type('Description', 'Late shift')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call).toHaveBeenCalledWith('ledger', 'PATCH', '/transactions/t1', {
      id: 't1',
      groupId: 'g1',
      kind: 'shift',
      date: '2026-10-15',
      description: 'Late shift',
      shift: storedShift,
    })
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Late shift' })).toBeTruthy()
  })

  it('starts a shift stored as hours in hours mode', async () => {
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: { minutes: 450, rateCents: 2550 } }) }))
    renderAt('/shifts/t1')
    expect(((await screen.findByLabelText('Hours worked')) as HTMLInputElement).value).toBe('7:30')
    expect(input('Hours').checked).toBe(true)
  })

  it('lets a member change a shift they added', async () => {
    mockGroup(acme, 'member')
    mockRow(shiftRow())
    renderAt('/shifts/t1')
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Void shift' })).toBeTruthy()
  })

  it.each<[string, Members['role'], Partial<Transactions>]>([
    ['a viewer', 'viewer', {}],
    ['a member who did not add it', 'member', { createdBy: 'p2' }],
  ])('is read-only for %s', async (_, role, extra) => {
    mockGroup(acme, role)
    mockRow(shiftRow(extra))
    renderAt('/shifts/t1')
    expect(
      await screen.findByText('Only an admin or the person who added it can change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is read-only when it is on a final invoice', async () => {
    mockRow(shiftRow({ statementId: 's1' }))
    renderAt('/shifts/t1')
    expect(await screen.findByText('It’s on a final invoice, so it can’t be changed.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is read-only in an archived group', async () => {
    mockGroup({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    mockRow(shiftRow())
    renderAt('/shifts/t1')
    expect(await screen.findByText('This group is archived.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a void shift with its reason and no form', async () => {
    mockRow(shiftRow({ status: 'void', voidReason: 'Didn’t go' }))
    renderAt('/shifts/t1')
    expect(await screen.findByText('Voided. Reason: Didn’t go')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('sends a running shift to the Today screen', async () => {
    mockRow(shiftRow({ status: 'running', startedAt: '2026-10-18T21:00:00.000Z' }))
    renderAt('/shifts/t1')
    expect(
      await screen.findByText('The timer is running. Stop it on the Today screen.'),
    ).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('confirms a scheduled shift at once, then with POST /post', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderAt('/shifts/t1')
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm as worked' }))
    expect(await screen.findByText('Confirmed.')).toBeTruthy()
    expect(screen.queryByText('Scheduled: not confirmed yet.')).toBeNull()
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/post', {})
    await act(async () => pending.resolve(view(shiftRow({ status: 'posted' }))))
    await settle()
    expect(screen.getByText('Confirmed.')).toBeTruthy()
  })

  it('puts a scheduled shift back and shows the error when confirming fails', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderAt('/shifts/t1')
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm as worked' }))
    expect(await screen.findByText('Confirmed.')).toBeTruthy()
    await act(async () => pending.resolve(failure('It was already confirmed.')))
    await settle()
    expect(screen.getByText('Scheduled: not confirmed yet.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('It was already confirmed.')
  })

  it('voids with the reason at once, then with POST /void', async () => {
    mockRow(shiftRow())
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderAt('/shifts/t1')
    await screen.findByLabelText('Reason for voiding')
    type('Reason for voiding', '  Sick  ')
    fireEvent.click(screen.getByRole('button', { name: 'Void shift' }))
    expect(await screen.findByText('Voided. Reason: Sick')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/void', {
      reason: 'Sick',
    })
    await act(async () => pending.resolve(view(shiftRow({ status: 'void', voidReason: 'Sick' }))))
    await settle()
    expect(screen.getByText('Voided. Reason: Sick')).toBeTruthy()
  })

  it('needs a reason to void and sends nothing without one', async () => {
    mockRow(shiftRow())
    renderAt('/shifts/t1')
    await screen.findByLabelText('Reason for voiding')
    type('Reason for voiding', '   ')
    fireEvent.click(screen.getByRole('button', { name: 'Void shift' }))
    expect((await screen.findByText('Say why, for example “Didn’t go”.')).id).toBe(
      'voidReason-error',
    )
    expect(input('Reason for voiding').getAttribute('aria-describedby')).toBe('voidReason-error')
    expect(screen.getByText('Confirmed.')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('puts the shift back and shows the error when voiding fails', async () => {
    mockRow(shiftRow())
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderAt('/shifts/t1')
    await screen.findByLabelText('Reason for voiding')
    type('Reason for voiding', 'Sick')
    fireEvent.click(screen.getByRole('button', { name: 'Void shift' }))
    expect(await screen.findByText('Voided. Reason: Sick')).toBeTruthy()
    await act(async () => pending.resolve(failure('It’s on a final invoice.')))
    await settle()
    expect(screen.getByText('Confirmed.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('It’s on a final invoice.')
  })

  it('says when the shift could not be loaded', async () => {
    getRow.mockRejectedValue(new Error('Not found'))
    renderAt('/shifts/t1')
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t load this shift/)
  })
})
