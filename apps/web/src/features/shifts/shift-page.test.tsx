import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useGroup, useGroups, useMyMember } from '../groups/use-groups'
import { useProfile } from '../profile/use-profile'
import { shiftRoutes } from './routes'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { getRow: vi.fn(), listRows: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
// No work-hours limit: hours-cap.test.tsx has the lines (#53).
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn() }))
vi.mock('../groups/use-groups', () => ({
  useGroups: vi.fn(),
  useGroup: vi.fn(),
  useMyMember: vi.fn(),
}))

const call = vi.mocked(callFunction)
const getRow = vi.mocked(tablesDB.getRow)
const listRows = vi.mocked(tablesDB.listRows)
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

/** The caller's member rows: `members` answers with these; nothing else is listed here. */
function mockRoles(
  roles: Record<string, Members['role']>,
  status: Record<string, Members['status']> = {},
) {
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    if (tableId !== 'members') throw new Error(`Unexpected listRows on ${tableId}`)
    const rows = Object.entries(roles).map(([groupId, role]) => ({
      groupId,
      personId: 'p1',
      role,
      status: status[groupId] ?? 'active',
    }))
    return { total: rows.length, rows }
  }) as never)
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

/** Renders the new-shift page and waits for the groups and roles to load. */
async function renderNew(path: string) {
  const rendered = renderAt(path)
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
  return rendered
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
  vi.mocked(useProfile).mockReturnValue({
    data: {
      personId: 'p1',
      timezone: 'Australia/Sydney',
      hoursCapMinutes: null,
      hoursCapPeriod: null,
    },
  } as never)
  mockRoles({ g1: 'admin', g2: 'member' })
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
    const { router } = await renderNew('/shifts/new')
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

  it('sends a note when one is typed, with its line breaks (#485, #502)', async () => {
    call.mockResolvedValue(view(shiftRow()))
    mockRow(shiftRow())
    await renderNew('/shifts/new')
    expect(input('Note (optional)').value).toBe('')
    expect(input('Note (optional)').tagName).toBe('TEXTAREA')
    type('Start', '09:00')
    type('End', '17:00')
    type('Note (optional)', ' Covered for Priya\nfrom 3 pm ')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().note).toBe('Covered for Priya\nfrom 3 pm')
  })

  it.each([
    ['7:30', 450],
    ['7.5', 450],
  ])('sends hours %j as %i minutes with no times or break', async (hours, minutes) => {
    call.mockResolvedValue(view(shiftRow()))
    mockRow(shiftRow())
    await renderNew('/shifts/new')
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
    await renderNew('/shifts/new')
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

  it('uses the date in the URL instead of today', async () => {
    await renderNew('/shifts/new?date=2026-09-30')
    expect(input('Date').value).toBe('2026-09-30')
  })

  it('takes today in the chosen group’s own time zone', async () => {
    mockGroups([acme, bistro])
    await renderNew('/shifts/new?groupId=g2')
    expect(input('Employer').value).toBe('g2')
    expect(input('Date').value).toBe('2026-10-18')
    expect(input('Hourly rate (USD)').value).toBe('30.00')
  })

  it('moves an untouched date to today in the employer chosen, but not a typed one', async () => {
    mockGroups([acme, bistro])
    await renderNew('/shifts/new')
    // 22:00 UTC: the 19th in Sydney, still the 18th in New York.
    expect(input('Date').value).toBe('2026-10-19')
    type('Employer', 'g2')
    expect(input('Date').value).toBe('2026-10-18')
    type('Employer', 'g1')
    expect(input('Date').value).toBe('2026-10-19')
    type('Date', '2026-10-10')
    type('Employer', 'g2')
    expect(input('Date').value).toBe('2026-10-10')
  })

  it('keeps the date from the URL when the employer changes', async () => {
    mockGroups([acme, bistro])
    await renderNew('/shifts/new?date=2026-09-30')
    type('Employer', 'g2')
    expect(input('Date').value).toBe('2026-09-30')
  })

  it('updates an untouched rate when the employer changes, but not a typed one', async () => {
    mockGroups([acme, bistro])
    call.mockResolvedValue(view(shiftRow()))
    mockRow(shiftRow())
    await renderNew('/shifts/new')
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
    await renderNew('/shifts/new')
    // With no error, End is described by its hint alone.
    expect(input('End').getAttribute('aria-describedby')).toBe('endTime-hint')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findAllByText('Required')).map((error) => error.id)).toEqual([
      'startTime-error',
      'endTime-error',
    ])
    expect(input('Start').getAttribute('aria-describedby')).toBe('startTime-error')
    expect(input('Start').getAttribute('aria-invalid')).toBe('true')
    expect(input('End').getAttribute('aria-describedby')).toBe('endTime-hint endTime-error')
    expect(input('End').getAttribute('aria-invalid')).toBe('true')
    // End's hint follows both fields, outside End's own, so the two errors line up (#502).
    const hint = document.getElementById('endTime-hint') as HTMLElement
    expect(hint.textContent).toBe('An end before the start means the next day.')
    expect(hint.previousElementSibling).toBe(input('End').parentElement)
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a break longer than the shift', async () => {
    await renderNew('/shifts/new')
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
    await renderNew('/shifts/new')
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
    await renderNew('/shifts/new')
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
    await renderNew('/shifts/new')
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
    // A CONFLICT from a write that clashed with another: nothing was saved with this ID.
    call.mockResolvedValueOnce(failure('The ledger is busy.'))
    call.mockImplementationOnce(async (_fn, _method, _path, body) =>
      view(shiftRow({ $id: (body as { id: string }).id })),
    )
    mockRow(shiftRow())
    getRow.mockRejectedValueOnce(new Error('Not found'))
    const { router } = await renderNew('/shifts/new')
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

  it('opens the shift saved by an earlier try when a retry with changes gets CONFLICT (#147 O9)', async () => {
    // The first answer was lost, and the form changed before the retry.
    call.mockResolvedValue(failure('A different transaction already has this ID.'))
    const { router, queryClient } = await renderNew('/shifts/new')
    const invalidated: unknown[] = []
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
      invalidated.push(filters)
    })
    getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
      shiftRow({ $id: rowId, description: 'As first sent' })) as never)
    type('Start', '09:00')
    type('End', '17:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/shifts/${sentBody().id}`))
    expect(getRow).toHaveBeenCalledWith({
      databaseId: 'main',
      tableId: 'transactions',
      rowId: sentBody().id,
    })
    expect(await screen.findByRole('heading', { name: 'As first sent' })).toBeTruthy()
    expect(screen.getByText(/already added by an earlier try/)).toBeTruthy()
    // Shown on this visit only: the history entry no longer carries it, so a reload won't.
    await waitFor(() => expect(router.state.location.state).toBeNull())
    expect(screen.getByText(/already added by an earlier try/)).toBeTruthy()
    // Its write's answer was lost, so what it changed is reloaded.
    for (const key of [['balances', 'g1'], ['history', 'g1'], ['today'], ['calendar']]) {
      expect(invalidated).toContainEqual(expect.objectContaining({ queryKey: key }))
    }
  })

  it.each<[string, Partial<Transactions>]>([
    ['someone else’s row', { createdBy: 'p2' }],
    ['a row that isn’t a shift', { kind: 'expense' }],
  ])('shows the CONFLICT rather than open %s', async (_, extra) => {
    call.mockResolvedValue(failure('A different transaction already has this ID.'))
    const { router } = await renderNew('/shifts/new')
    getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
      shiftRow({ $id: rowId, ...extra })) as never)
    type('Start', '09:00')
    type('End', '17:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A different transaction already has this ID.',
    )
    expect(router.state.location.pathname).toBe('/shifts/new')
  })

  it('keeps Save focusable while saving, and ignores a second submit', async () => {
    call.mockReturnValue(new Promise(() => {}))
    await renderNew('/shifts/new')
    type('Start', '09:00')
    type('End', '17:00')
    const save = screen.getByRole('button', { name: 'Add shift' })
    fireEvent.click(save)
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving.getAttribute('aria-disabled')).toBe('true')
    expect(saving.hasAttribute('disabled')).toBe(false)
    fireEvent.click(saving)
    await act(async () => {})
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shows a CONFLICT when no shift was saved with the ID', async () => {
    call.mockResolvedValue(failure('Someone else changed this at the same time. Try again.'))
    getRow.mockRejectedValue(new Error('Not found'))
    const { router } = await renderNew('/shifts/new')
    type('Start', '09:00')
    type('End', '17:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone else changed this at the same time. Try again.',
    )
    expect(router.state.location.pathname).toBe('/shifts/new')
  })

  it('only looks for a saved shift on CONFLICT', async () => {
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Server error.' } })
    mockRow(shiftRow())
    const { router } = await renderNew('/shifts/new')
    type('Start', '09:00')
    type('End', '17:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Server error.')
    expect(getRow).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/shifts/new')
  })

  it('links to a new employer when the user has no employer groups', async () => {
    mockGroups([
      employer('g3', 'Flat', { type: 'house' }),
      employer('g4', 'Old job', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    await renderNew('/shifts/new')
    expect(screen.getByRole('link', { name: 'New employer' }).getAttribute('href')).toBe(
      '/groups/new-employer',
    )
    expect(screen.queryByRole('button', { name: 'Add shift' })).toBeNull()
  })

  it('says when the groups are loading or could not be loaded', async () => {
    mockGroups(undefined)
    renderAt('/shifts/new')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    cleanup()
    mockGroups(undefined, true)
    renderAt('/shifts/new')
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t load your groups/)
    cleanup()
    mockGroups([acme])
    listRows.mockRejectedValue(new Error('offline'))
    renderAt('/shifts/new')
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t load your groups/)
  })

  it('refuses an end equal to the start and sends nothing', async () => {
    await renderNew('/shifts/new')
    type('Start', '09:00')
    type('End', '09:00')
    fireEvent.click(screen.getByRole('button', { name: 'Add shift' }))
    expect((await screen.findByText('The end must differ from the start')).id).toBe('endTime-error')
    expect(input('End').getAttribute('aria-describedby')).toBe('endTime-hint endTime-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('reads the caller’s roles from their member rows', async () => {
    mockGroups([acme, bistro])
    await renderNew('/shifts/new')
    expect(listRows).toHaveBeenCalledWith({
      databaseId: 'main',
      tableId: 'members',
      queries: [
        Query.equal('groupId', ['g1', 'g2']),
        Query.equal('personId', 'p1'),
        Query.limit(100),
      ],
    })
  })

  it('leaves out groups where the caller is a viewer or only a placeholder', async () => {
    const cafe = employer('g5', 'Cafe Five')
    mockGroups([acme, bistro, cafe])
    mockRoles({ g1: 'viewer', g2: 'member', g5: 'admin' }, { g5: 'placeholder' })
    await renderNew('/shifts/new?groupId=g1')
    // Only Bistro is left, so there's no employer picker and the shift goes there.
    expect(screen.queryByLabelText('Employer')).toBeNull()
    expect(input('Hourly rate (USD)').value).toBe('30.00')
  })

  it('lists only the groups the caller may add shifts to', async () => {
    const cafe = employer('g5', 'Cafe Five')
    mockGroups([acme, bistro, cafe])
    mockRoles({ g1: 'admin', g2: 'viewer', g5: 'member' })
    await renderNew('/shifts/new')
    const options = [...(screen.getByLabelText('Employer') as HTMLSelectElement).options]
    expect(options.map((option) => option.value)).toEqual(['g1', 'g5'])
  })

  it('links to a new employer when the caller only views their employer groups', async () => {
    mockGroups([acme, bistro])
    mockRoles({ g1: 'viewer' })
    await renderNew('/shifts/new')
    expect(screen.getByRole('link', { name: 'New employer' }).getAttribute('href')).toBe(
      '/groups/new-employer',
    )
    expect(screen.queryByRole('button', { name: 'Add shift' })).toBeNull()
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
    // Mounted from the start, so the announcement is read out (#539).
    const statuses = screen.getAllByRole('status')
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
    await waitFor(() => expect(statuses.map((node) => node.textContent)).toContain('Saved.'))
    expect(screen.getByRole('heading', { name: 'Late shift' })).toBeTruthy()
  })

  // PATCH replaces the whole input: a stored note the form didn't send back would be lost (#485).
  it.each([
    ['keeps a stored note through an edit that leaves it', undefined, 'Covered for Priya'],
    ['sends a changed note', 'Swapped with Dan', 'Swapped with Dan'],
    ['clears the note', '', undefined],
  ])('%s', async (_case, typed, sent) => {
    mockRow(
      shiftRow({
        inputJson: JSON.stringify({
          payers: [{ personId: 'p1', cents: 20400 }],
          shift: storedShift,
          note: 'Covered for Priya',
        }),
      }),
    )
    call.mockResolvedValue(view(shiftRow({ description: 'Late shift' })))
    renderAt('/shifts/t1')
    expect(await screen.findByRole('heading', { name: 'Morning shift' })).toBeTruthy()
    expect(input('Note (optional)').value).toBe('Covered for Priya')
    type('Description', 'Late shift')
    if (typed !== undefined) type('Note (optional)', typed)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call).toHaveBeenCalledWith('ledger', 'PATCH', '/transactions/t1', {
      id: 't1',
      groupId: 'g1',
      kind: 'shift',
      date: '2026-10-15',
      description: 'Late shift',
      shift: storedShift,
      ...(sent === undefined ? {} : { note: sent }),
    })
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

  /** The summary's terms and what each says. */
  function summary(): Record<string, string> {
    const terms = [...document.querySelectorAll('dt')]
    return Object.fromEntries(
      terms.map((term) => [term.textContent, term.nextElementSibling?.textContent ?? '']),
    )
  }

  it.each<[string, Members['role'], Partial<Transactions>]>([
    ['a viewer', 'viewer', {}],
    ['a locked shift', 'admin', { statementId: 's1' }],
  ])('shows %s’s date, times, break, hours and pay (#147 O4)', async (_, role, extra) => {
    mockGroup(acme, role)
    mockRow(shiftRow(extra))
    renderAt('/shifts/t1')
    await screen.findByText('Date')
    expect(summary()).toEqual({
      Date: '2026-10-15',
      Times: '09:00–17:30',
      Break: '30 min',
      Hours: expect.stringMatching(/^8 h 0 min at .*25\.50 an hour$/),
      Pay: expect.stringMatching(/204\.00$/),
    })
  })

  it('shows a void shift’s summary with no pay, since it pays nothing', async () => {
    mockRow(shiftRow({ status: 'void', voidReason: 'Sick' }))
    renderAt('/shifts/t1')
    await screen.findByText('Date')
    expect(Object.keys(summary())).toEqual(['Date', 'Times', 'Break', 'Hours'])
  })

  it('shows hours with no times for a shift stored as hours (#147 O4)', async () => {
    mockGroup(acme, 'viewer')
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: { minutes: 450, rateCents: 2550 } }) }))
    renderAt('/shifts/t1')
    await screen.findByText('Date')
    expect(Object.keys(summary())).toEqual(['Date', 'Hours', 'Pay'])
    expect(summary().Hours).toMatch(/^7 h 30 min at /)
  })

  it('shows when a running timer started, in the group’s time zone, and no pay (#147 O4)', async () => {
    mockRow(shiftRow({ status: 'running', startedAt: '2026-10-18T21:00:00.000Z' }))
    renderAt('/shifts/t1')
    await screen.findByText('Date')
    expect(Object.keys(summary())).toEqual(['Date', 'Started'])
    // 08:00 in Sydney.
    expect(summary().Started).toMatch(/^0?8:00/)
  })

  it('shows no summary beside the form', async () => {
    mockRow(shiftRow())
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    expect(screen.queryByText('Pay')).toBeNull()
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

  it('shows a running shift with only the void form', async () => {
    mockRow(shiftRow({ status: 'running', startedAt: '2026-10-18T21:00:00.000Z' }))
    renderAt('/shifts/t1')
    expect(
      await screen.findByText(
        'The timer is running. Stop it on the Today screen, or void it here.',
      ),
    ).toBeTruthy()
    expect(screen.queryByLabelText('Start')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm as worked' })).toBeNull()
    expect(screen.getAllByRole('textbox').map((box) => box.id)).toEqual(['voidReason'])
  })

  it('voids a running shift with POST /void', async () => {
    mockRow(shiftRow({ status: 'running', startedAt: '2026-10-17T21:00:00.000Z' }))
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Reason for voiding')
    type('Reason for voiding', 'Forgot to stop it')
    fireEvent.click(screen.getByRole('button', { name: 'Void shift' }))
    expect(await screen.findByText('Voided. Reason: Forgot to stop it')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/void', {
      reason: 'Forgot to stop it',
    })
  })

  it('keeps a timer’s stored minutes when the times and break are unchanged', async () => {
    const timed = { minutes: 29, rateCents: 2550, startTime: '09:00', endTime: '09:30' }
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: timed }) }))
    call.mockResolvedValue(view(shiftRow()))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    expect(screen.getByText(/^0 h 29 min paid · /)).toBeTruthy()
    type('Description', 'Timed shift')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().shift).toStrictEqual(timed)
    expect(sentBody().description).toBe('Timed shift')
  })

  it('saves a timer stopped within the minute it started, whose times are equal (#147 O5)', async () => {
    const timed = { minutes: 0, rateCents: 2550, startTime: '09:00', endTime: '09:00' }
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: timed }) }))
    call.mockResolvedValue(view(shiftRow()))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    type('Description', 'Quick shift')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().shift).toStrictEqual(timed)
    expect(sentBody().description).toBe('Quick shift')
  })

  it('refuses equal stored times once the break changes, rather than pay a whole day', async () => {
    const timed = { minutes: 0, rateCents: 2550, startTime: '09:00', endTime: '09:00' }
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: timed }) }))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    type('Break (minutes)', '0')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The end must differ from the start')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('still refuses equal times typed over a stored shift’s', async () => {
    mockRow(shiftRow())
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    type('End', '09:00')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The end must differ from the start')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('works the minutes out again once a time changes', async () => {
    const timed = { minutes: 29, rateCents: 2550, startTime: '09:00', endTime: '09:30' }
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: timed }) }))
    call.mockResolvedValue(view(shiftRow()))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    type('End', '10:00')
    expect(screen.getByText(/^1 h 0 min paid · /)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().shift).toStrictEqual({ ...timed, minutes: 60, endTime: '10:00' })
  })

  it('works the minutes out again once the break changes', async () => {
    const timed = { minutes: 29, rateCents: 2550, startTime: '09:00', endTime: '09:30' }
    mockRow(shiftRow({ inputJson: JSON.stringify({ shift: timed }) }))
    call.mockResolvedValue(view(shiftRow()))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Start')
    type('Break (minutes)', '5')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().shift).toStrictEqual({ ...timed, minutes: 25, breakMinutes: 5 })
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

  it('moves focus to the heading when Confirm goes away (#147 O8)', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    call.mockResolvedValue(view(shiftRow({ status: 'posted' })))
    renderAt('/shifts/t1')
    const button = await screen.findByRole('button', { name: 'Confirm as worked' })
    button.focus()
    fireEvent.click(button)
    expect(await screen.findByText('Confirmed.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Morning shift' }))
  })

  it('won’t confirm while the form has unsaved changes', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    call.mockImplementation(async (_fn, _method, _path, body) =>
      view(shiftRow({ status: 'scheduled', ...(body as object) })),
    )
    renderAt('/shifts/t1')
    const confirm = (await screen.findByRole('button', {
      name: 'Confirm as worked',
    })) as HTMLButtonElement
    const off = () => confirm.getAttribute('aria-disabled') === 'true'
    expect(off()).toBe(false)
    type('End', '19:30')
    expect(off()).toBe(true)
    expect(screen.getByText('Save your changes first.').id).toBe(
      confirm.getAttribute('aria-describedby'),
    )
    // Still focusable, but a click does nothing.
    fireEvent.click(confirm)
    expect(call).not.toHaveBeenCalled()
    // Back as stored: nothing to save.
    type('End', '17:30')
    expect(off()).toBe(false)
    type('End', '19:30')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(off()).toBe(false))
    expect(screen.queryByText('Save your changes first.')).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[2]).toBe('/transactions/t1')
  })

  it('starts the form again from the row the server posted', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    // Changed on another device meanwhile: the server posts what it has.
    const stored = { ...storedShift, endTime: '18:30', minutes: 540 }
    call.mockResolvedValue(
      view(
        shiftRow({
          status: 'posted',
          totalCents: 22950,
          inputJson: JSON.stringify({ payers: [{ personId: 'p1', cents: 22950 }], shift: stored }),
        }),
      ),
    )
    renderAt('/shifts/t1')
    await screen.findByText(/^8 h 0 min paid/)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm as worked' }))
    // Waits for the posted row, not a fixed number of ticks (it was flaky under load).
    await waitFor(() => expect(input('End').value).toBe('18:30'))
    expect(screen.getByText('Confirmed.')).toBeTruthy()
    expect(screen.getByText(/^9 h 0 min paid · .*229\.50$/)).toBeTruthy()
  })

  it('reloads the shift when confirming is refused as LOCKED', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    call.mockResolvedValue({
      ok: false,
      error: { code: 'LOCKED', message: 'It’s on a statement being finalised.' },
    })
    renderAt('/shifts/t1')
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm as worked' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('It’s on a statement being finalised.'),
    )
    await waitFor(() => expect(getRow).toHaveBeenCalledTimes(2))
  })

  it('reloads the shift when saving is refused as ARCHIVED, and doesn’t on other errors', async () => {
    mockRow(shiftRow())
    call.mockResolvedValue(failure('Something else.'))
    renderAt('/shifts/t1')
    await screen.findByRole('button', { name: 'Save' })
    type('Description', 'Late shift')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Something else.')
    await settle()
    expect(getRow).toHaveBeenCalledTimes(1)
    call.mockResolvedValue({ ok: false, error: { code: 'ARCHIVED', message: 'Archived.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(getRow).toHaveBeenCalledTimes(2))
  })

  it('marks the group’s balance and history stale after a save', async () => {
    mockRow(shiftRow())
    call.mockResolvedValue(view(shiftRow({ description: 'Late shift' })))
    const { queryClient } = renderAt('/shifts/t1')
    queryClient.setQueryData(queryKeys.balances('g1'), { people: [], transfers: [] })
    queryClient.setQueryData(queryKeys.history('g1', {}), { pages: [], pageParams: [] })
    await screen.findByRole('button', { name: 'Save' })
    type('Description', 'Late shift')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved.')
    expect(queryClient.getQueryState(queryKeys.balances('g1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.history('g1', {}))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryData(queryKeys.transactionShares('t1'))).toEqual([])
  })

  it('puts a scheduled shift back and shows the error when confirming fails', async () => {
    mockRow(shiftRow({ status: 'scheduled' }))
    const pending = deferred<Result<unknown>>()
    call.mockReturnValue(pending.promise)
    renderAt('/shifts/t1')
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm as worked' }))
    expect(await screen.findByText('Confirmed.')).toBeTruthy()
    await act(async () => pending.resolve(failure('It was already confirmed.')))
    await waitFor(() => expect(screen.getByText('Scheduled: not confirmed yet.')).toBeTruthy())
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

  it('moves focus to the heading when the void form goes away (#147 O8)', async () => {
    mockRow(shiftRow())
    call.mockResolvedValue(view(shiftRow({ status: 'void', voidReason: 'Sick' })))
    renderAt('/shifts/t1')
    await screen.findByLabelText('Reason for voiding')
    type('Reason for voiding', 'Sick')
    const button = screen.getByRole('button', { name: 'Void shift' })
    button.focus()
    fireEvent.click(button)
    expect(await screen.findByText('Voided. Reason: Sick')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Morning shift' }))
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
    await waitFor(() => expect(screen.getByText('Confirmed.')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('It’s on a final invoice.')
  })

  it('says when the shift could not be loaded', async () => {
    getRow.mockRejectedValue(new Error('Not found'))
    renderAt('/shifts/t1')
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t load this shift/)
  })
})
