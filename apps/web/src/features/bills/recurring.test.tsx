import type { Groups, Schedules } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useGroup } from '../groups/use-groups'
import { billRoutes } from './routes'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { getRow: vi.fn(), listRows: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: 'p1', personalGroupId: 'g1' } }),
}))
vi.mock('../groups/use-groups', () => ({ useGroup: vi.fn() }))

const call = vi.mocked(callFunction)
const listRows = vi.mocked(tablesDB.listRows)

// 22:00 UTC on 18 October: already Monday the 19th in Sydney.
const NOW = new Date('2026-10-18T22:00:00.000Z')

const personal = {
  $id: 'g1',
  type: 'personal',
  name: 'Personal',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

function schedule(id: string, extra: Partial<Schedules> = {}): Schedules {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'bill',
    description: 'Rent',
    templateJson: JSON.stringify({ totalCents: 40000, category: 'rent', bill: { status: 'due' } }),
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    startsOn: '2026-10-19',
    endsOn: null,
    exdates: [],
    skipPublicHolidays: false,
    autoPost: false,
    createdBy: 'p1',
    ...extra,
  } as unknown as Schedules
}

/** Schedules answer with `recurring`; the due and paid lists are empty. */
function mockLists(recurring: Schedules[]) {
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    const rows = tableId === 'schedules' ? recurring : []
    return { total: rows.length, rows }
  }) as never)
}

function renderAt(path: string) {
  const router = createMemoryRouter([billRoutes, { path: '*', element: null }], {
    initialEntries: [path],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

function ok(data: unknown): Result<unknown> {
  return { ok: true, data }
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function sentBody(index = 0) {
  return call.mock.calls[index]?.[3] as Record<string, unknown> & { id: string }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(useGroup).mockReturnValue({ data: personal, isError: false } as never)
  mockLists([])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('NewRecurringBillPage', () => {
  it('sends rent weekly on Monday as a bill schedule, then goes back to Bills (flow 10)', async () => {
    call.mockImplementation(async (_fn, _method, _path, body) =>
      ok({ schedule: schedule((body as { id: string }).id) }),
    )
    const { router } = renderAt('/bills/recurring/new')
    // Today in Sydney, as the first due date.
    expect((screen.getByLabelText('First due date') as HTMLInputElement).value).toBe('2026-10-19')
    type('Description', 'Rent')
    type('Category', 'rent')
    type('Amount (AUD)', '400')
    fireEvent.click(screen.getByLabelText('Every week'))
    type('On', 'MO')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['scheduler', 'POST', '/schedules'])
    expect(sentBody()).toStrictEqual({
      id: sentBody().id,
      groupId: 'g1',
      kind: 'bill',
      description: 'Rent',
      template: { totalCents: 40000, category: 'rent', bill: { status: 'due' } },
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      startsOn: '2026-10-19',
      skipPublicHolidays: false,
      autoPost: false,
    })
    expect(sentBody().id).toHaveLength(20)
    await waitFor(() => expect(router.state.location.pathname).toBe('/bills'))
  })

  it('sends monthly on a day with a last date and autopay, or the last day of the month', async () => {
    call.mockResolvedValue(ok({ schedule: schedule('s1') }))
    renderAt('/bills/recurring/new')
    type('Description', 'Phone')
    type('Amount (AUD)', '45.50')
    type('Day of the month', '15')
    type('Last due date (optional)', '2027-06-30')
    const autopay = screen.getByLabelText(/Autopay/)
    expect(
      document.getElementById(autopay.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Bills are paid automatically once auto-pay is switched on for the app.')
    fireEvent.click(autopay)
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody()).toMatchObject({
      template: { totalCents: 4550, bill: { status: 'due' } },
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20270630',
      autoPost: true,
    })
    cleanup()
    call.mockClear()
    renderAt('/bills/recurring/new')
    type('Description', 'Rent')
    type('Amount (AUD)', '1600')
    fireEvent.click(screen.getByLabelText('On the last day of each month'))
    expect(screen.queryByLabelText('Day of the month')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=-1')
  })

  it('refuses a day past 28, an empty amount and a last date before the first, inline', async () => {
    renderAt('/bills/recurring/new')
    type('Description', 'Gym')
    type('Day of the month', '31')
    type('Last due date (optional)', '2026-10-01')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    expect(
      (await screen.findByText('Enter a day from 1 to 28, or choose the last day of the month')).id,
    ).toBe('monthDay-error')
    expect(screen.getByText('Required').id).toBe('amount-error')
    expect(screen.getByText('The last date must be on or after the first').id).toBe('until-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('shows the scheduler’s refusal and stays, keeping one id for a retry', async () => {
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Only an admin can add schedules here.' },
    })
    const { router } = renderAt('/bills/recurring/new')
    type('Description', 'Rent')
    type('Amount (AUD)', '400')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only an admin can add schedules here.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(sentBody(1).id).toBe(sentBody(0).id)
    expect(router.state.location.pathname).toBe('/bills/recurring/new')
  })
})

describe('BillsPage: recurring', () => {
  it('lists the recurring bills in words, on schedules.idx_groupId with kind = bill', async () => {
    mockLists([
      schedule('s1', { autoPost: true }),
      schedule('s2', {
        description: 'Gym',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
        templateJson: '{"totalCents":3000}',
        endsOn: '2026-10-01',
      }),
      schedule('s3', { description: 'Phone', endsOn: '2026-12-31' }),
    ])
    renderAt('/bills')
    const region = within(await screen.findByRole('region', { name: 'Recurring' }))
    const items = await region.findAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^RentEvery Monday · A?\$400\.00 · AutopayStop$/),
      expect.stringMatching(/^GymLast day of each month · A?\$30\.00 · Ended$/),
      expect.stringMatching(/^PhoneEvery Monday · A?\$400\.00 · Last due (31 Dec|Dec 31,) 2026$/),
    ])
    // Only the one that hasn't been given an end can be stopped.
    expect(
      region.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Stop Rent'])
    const params = listRows.mock.calls
      .map(([call]) => call as unknown as { tableId: string; queries: string[] })
      .find((call) => call.tableId === 'schedules')
    expect(params?.queries).toEqual([
      Query.equal('groupId', 'g1'),
      Query.equal('kind', 'bill'),
      Query.orderAsc('startsOn'),
      Query.orderAsc('$id'),
      Query.limit(100),
    ])
  })

  it('reads every page of schedules with a cursor', async () => {
    const page = Array.from({ length: 100 }, (_, index) => schedule(`s${index}`))
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      if (tableId !== 'schedules') return { total: 0, rows: [] }
      return queries.includes(Query.cursorAfter('s99'))
        ? { total: 101, rows: [schedule('s100')] }
        : { total: 101, rows: page }
    }) as never)
    renderAt('/bills')
    const region = within(await screen.findByRole('region', { name: 'Recurring' }))
    await waitFor(() => expect(region.getAllByRole('listitem')).toHaveLength(101))
  })

  it('stops one from today in the group’s time zone, after confirming', async () => {
    mockLists([schedule('s1')])
    call.mockImplementation(async () => {
      // Stored as stopped: the list reloads it so.
      mockLists([schedule('s1', { endsOn: '2026-10-19' })])
      return ok({ schedule: schedule('s1', { endsOn: '2026-10-19' }) })
    })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Rent' }))
    expect(screen.getByText(/Stop Rent from today\?/)).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }))
    expect(await screen.findByText('Stopped Rent. Bills already made stay.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('scheduler', 'POST', '/schedules/s1/end', {
      endsOn: '2026-10-19',
    })
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Bills' }))
    // Shown as stopped at once: Stop doesn't come back before the list reloads.
    expect(screen.queryByRole('button', { name: 'Stop Rent' })).toBeNull()
  })

  it('removes one that hasn’t started yet, as it can’t be given an end before its start', async () => {
    mockLists([schedule('s1', { startsOn: '2026-10-26' })])
    call.mockImplementation(async () => {
      mockLists([])
      return ok({})
    })
    renderAt('/bills')
    const region = within(await screen.findByRole('region', { name: 'Recurring' }))
    expect((await region.findByRole('listitem')).textContent).toMatch(
      /Starts (26 Oct|Oct 26,) 2026/,
    )
    fireEvent.click(region.getByRole('button', { name: 'Stop Rent' }))
    expect(
      screen.getByText('Remove Rent? It hasn’t started yet, so no bills are kept.'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))
    expect(await screen.findByText('Removed Rent.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('scheduler', 'DELETE', '/schedules/s1', undefined)
    expect(region.queryByRole('listitem')).toBeNull()
  })

  it('moves focus to Cancel when the question opens', async () => {
    mockLists([schedule('s1')])
    renderAt('/bills')
    const stop = await screen.findByRole('button', { name: 'Stop Rent' })
    stop.focus()
    fireEvent.click(stop)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('shows the last due date from the rule’s end too, the earlier one first', async () => {
    mockLists([
      schedule('s1', { rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20270628' }),
      schedule('s2', {
        description: 'Gym',
        rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20270628',
        endsOn: '2026-12-28',
      }),
    ])
    renderAt('/bills')
    const region = within(await screen.findByRole('region', { name: 'Recurring' }))
    const items = await region.findAllByRole('listitem')
    expect(items[0]?.textContent).toMatch(/Last due (28 Jun|Jun 28,) 2027/)
    expect(items[1]?.textContent).toMatch(/Last due (28 Dec|Dec 28,) 2026/)
  })

  it('cancels a stop, putting focus back on Stop, and shows a refusal', async () => {
    mockLists([schedule('s1')])
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Try again later.' } })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Rent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again later.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop Rent' }))
  })

  it('links to New recurring bill', async () => {
    renderAt('/bills')
    expect(
      (await screen.findByRole('link', { name: 'New recurring bill' })).getAttribute('href'),
    ).toBe('/bills/recurring/new')
  })
})
