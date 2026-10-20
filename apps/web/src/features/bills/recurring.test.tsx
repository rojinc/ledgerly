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
import { billKeys } from './use-bills'

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
    type('Day of the week', 'MO')
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
    // The form and its button are gone: focus goes to the Bills heading.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Bills' })),
    )
  })

  it('sends monthly on a day with a last date and autopay, or the last day of the month', async () => {
    call.mockResolvedValue(ok({ schedule: schedule('s1') }))
    renderAt('/bills/recurring/new')
    type('Description', 'Phone')
    type('Amount (AUD)', '45.50')
    // A leading zero is fine: "05" is the 5th.
    type('Day of the month', '05')
    type('Last due date (optional)', '2027-06-30')
    const autopay = screen.getByLabelText(/Autopay/)
    expect(
      document.getElementById(autopay.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Without autopay, each bill shows as due until you mark it paid.')
    fireEvent.click(autopay)
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody()).toMatchObject({
      template: { totalCents: 4550, bill: { status: 'due' } },
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=5;UNTIL=20270630',
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

  it('refuses an amount of 0, and a first date more than 31 days ago, inline', async () => {
    renderAt('/bills/recurring/new')
    const first = screen.getByLabelText('First due date') as HTMLInputElement
    // 31 days before Monday the 19th in Sydney.
    expect(first.min).toBe('2026-09-18')
    type('Description', 'Gym')
    type('Amount (AUD)', '0')
    type('First due date', '2026-09-17')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    expect((await screen.findByText('Enter an amount above 0')).id).toBe('amount-error')
    expect(screen.getByText(/^Pick a date from (18 Sep|Sep 18,) 2026 on$/).id).toBe(
      'startsOn-error',
    )
    expect(call).not.toHaveBeenCalled()
    type('First due date', '2026-09-18')
    type('Amount (AUD)', '10')
    call.mockResolvedValue(ok({ schedule: schedule('s1') }))
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody().startsOn).toBe('2026-09-18')
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
  it('lists the recurring bills in words, on schedules.idx_groupId with kind bill or expense', async () => {
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
      expect.stringMatching(/^RentEvery Monday · A?\$400\.00 · AutopayPauseStop$/),
      expect.stringMatching(/^GymLast day of each month · A?\$30\.00 · Ended$/),
      expect.stringMatching(
        /^PhoneEvery Monday · A?\$400\.00 · Last due (31 Dec|Dec 31,) 2026Pause$/,
      ),
    ])
    // Only the one that hasn't been given an end can be stopped; any that hasn't ended, paused.
    expect(
      region.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Pause Rent', 'Stop Rent', 'Pause Phone'])
    const params = listRows.mock.calls
      .map(([call]) => call as unknown as { tableId: string; queries: string[] })
      .find((call) => call.tableId === 'schedules')
    expect(params?.queries).toEqual([
      Query.equal('groupId', 'g1'),
      Query.equal('kind', ['bill', 'expense']),
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
      screen.getByText(
        'Remove Rent? It hasn’t started yet, so its bills are removed, except any you’ve already paid.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))
    expect(await screen.findByText('Removed Rent.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('scheduler', 'DELETE', '/schedules/s1', undefined)
    expect(region.queryByRole('listitem')).toBeNull()
  })

  it('ends one on its first date when its first bill was already paid early', async () => {
    mockLists([schedule('s1', { startsOn: '2026-10-26' })])
    call.mockImplementation(async (_fn, method) =>
      method === 'DELETE'
        ? {
            ok: false as const,
            error: {
              code: 'VALIDATION_FAILED',
              message: 'This schedule has posted transactions, so end it instead of deleting it.',
            },
          }
        : ok({ schedule: schedule('s1', { startsOn: '2026-10-26', endsOn: '2026-10-26' }) }),
    )
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Rent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))
    expect(await screen.findByText('Stopped Rent. Bills already made stay.')).toBeTruthy()
    expect(call.mock.calls.map((args) => args.slice(1))).toEqual([
      ['DELETE', '/schedules/s1', undefined],
      ['POST', '/schedules/s1/end', { endsOn: '2026-10-26' }],
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows any other refusal of a removal as it is', async () => {
    mockLists([schedule('s1', { startsOn: '2026-10-26' })])
    call.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'Not yours.' } })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Rent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not yours.')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shows a stop at once, and reloads the lists and the calendar', async () => {
    mockLists([schedule('s1')])
    call.mockResolvedValue(ok({ schedule: schedule('s1', { endsOn: '2026-10-19' }) }))
    const { queryClient } = renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Rent' }))
    // Every reload from here never answers: what shows is the stop's own answer.
    listRows.mockReturnValue(new Promise(() => {}))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }))
    await screen.findByText('Stopped Rent. Bills already made stay.')
    const region = within(screen.getByRole('region', { name: 'Recurring' }))
    expect(region.getByRole('listitem').textContent).toMatch(/Last due (19 Oct|Oct 19,) 2026/)
    expect(region.queryByRole('button', { name: 'Stop Rent' })).toBeNull()
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toContainEqual(['calendar'])
    expect(keys).toContainEqual(billKeys.all('g1'))
  })

  it('moves focus to Cancel when the question opens', async () => {
    mockLists([schedule('s1')])
    renderAt('/bills')
    const stop = await screen.findByRole('button', { name: 'Stop Rent' })
    stop.focus()
    fireEvent.click(stop)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('shows a stop’s end date once, after the rule’s own end in its words', async () => {
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
    expect(items[0]?.textContent).toMatch(/until (28 Jun|Jun 28,) 2027/)
    expect(items[0]?.textContent).not.toMatch(/Last due/)
    expect(items[1]?.textContent).toMatch(/Last due (28 Dec|Dec 28,) 2026/)
  })

  it('cancels a stop, putting focus back on Stop, and shows a refusal', async () => {
    mockLists([schedule('s1')])
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Try again later.' } })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Rent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again later.')
    // The question is a group named by its words, so they're read out with Cancel.
    const question = screen.getByRole('group', { name: /^Stop Rent from today\?/ })
    expect(question.contains(screen.getByRole('button', { name: 'Cancel' }))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop Rent' }))
    // Asked again, the last refusal is gone.
    fireEvent.click(screen.getByRole('button', { name: 'Stop Rent' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('pauses one from today after confirming, then shows it paused with Resume (#430)', async () => {
    mockLists([schedule('s1')])
    const paused = schedule('s1', { pausedFrom: '2026-10-19' })
    call.mockImplementation(async () => {
      mockLists([paused])
      return ok({ schedule: paused, removed: 1 })
    })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Rent' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('group', {
        name: 'Pause Rent from today? Bills due from today that you haven’t paid or changed are removed, and no more are made until you resume it.',
      }),
    ).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pause it' }))
    expect(await screen.findByText('Paused Rent from today. Resume it to carry on.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('scheduler', 'POST', '/schedules/s1/pause', {
      pausedFrom: '2026-10-19',
    })
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Bills' }))
    const region = within(screen.getByRole('region', { name: 'Recurring' }))
    expect(region.getByRole('listitem').textContent).toMatch(
      /· Paused from (19 Oct|Oct 19,) 2026ResumeStop$/,
    )
    expect(region.queryByRole('button', { name: 'Pause Rent' })).toBeNull()
  })

  it('resumes a paused one with no body, and says the days in between aren’t added (#430)', async () => {
    const paused = schedule('s1', { pausedFrom: '2026-10-12' })
    mockLists([paused])
    call.mockImplementation(async () => {
      mockLists([schedule('s1')])
      return ok({ schedule: { ...paused, pausedFrom: null }, created: 4 })
    })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume Rent' }))
    expect(
      await screen.findByText(
        'Resumed Rent. Bills are made again from today; none are made for the days in between.',
      ),
    ).toBeTruthy()
    expect(call).toHaveBeenCalledWith('scheduler', 'POST', '/schedules/s1/resume', undefined)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Bills' }))
    expect(await screen.findByRole('button', { name: 'Pause Rent' })).toBeTruthy()
    expect(screen.queryByText(/Paused from/)).toBeNull()
  })

  it('cancels a pause, putting focus back on Pause, and shows refusals of a pause or resume (#430)', async () => {
    mockLists([schedule('s1'), schedule('s2', { description: 'Gym', pausedFrom: '2026-10-12' })])
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Try again later.' } })
    renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Rent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause it' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again later.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause Rent' }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume Gym' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again later.')
    expect(screen.getByText(/Paused from/)).toBeTruthy()
  })

  it('keeps a paused bill’s last due date, and finishes a resume before Stop can ask (#430)', async () => {
    mockLists([
      schedule('s1', { pausedFrom: '2026-11-02' }),
      schedule('s2', { description: 'Gym', endsOn: '2026-12-28', pausedFrom: '2026-11-02' }),
    ])
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/bills')
    const region = within(await screen.findByRole('region', { name: 'Recurring' }))
    const items = await region.findAllByRole('listitem')
    expect(items[1]?.textContent).toMatch(
      /· Paused from (2 Nov|Nov 2,) 2026 · Last due (28 Dec|Dec 28,) 2026Resume$/,
    )
    fireEvent.click(region.getByRole('button', { name: 'Resume Rent' }))
    await waitFor(() =>
      expect(region.getByRole('button', { name: 'Resume Rent' }).textContent).toBe('Resuming…'),
    )
    fireEvent.click(region.getByRole('button', { name: 'Stop Rent' }))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('shows a pause at once, before the lists reload, then reads the bills again (#430)', async () => {
    mockLists([schedule('s1')])
    call.mockResolvedValue(
      ok({ schedule: schedule('s1', { pausedFrom: '2026-10-19' }), removed: 1 }),
    )
    const { queryClient } = renderAt('/bills')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Rent' }))
    // Every reload from here never answers: what shows is the pause's own answer.
    listRows.mockReturnValue(new Promise(() => {}))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'Pause it' }))
    await screen.findByText('Paused Rent from today. Resume it to carry on.')
    const region = within(screen.getByRole('region', { name: 'Recurring' }))
    expect(region.getByRole('button', { name: 'Resume Rent' })).toBeTruthy()
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    // The bills it removed from today go from the due list.
    expect(keys).toContainEqual(billKeys.all('g1'))
  })

  it('shows a paused bill that has ended as ended, not paused (#430)', async () => {
    mockLists([schedule('s1', { endsOn: '2026-10-12', pausedFrom: '2026-10-05' })])
    renderAt('/bills')
    const region = within(await screen.findByRole('region', { name: 'Recurring' }))
    const item = await region.findByRole('listitem')
    expect(item.textContent).toMatch(/· Ended$/)
    expect(item.textContent).not.toMatch(/Paused/)
  })

  it('links to New recurring bill', async () => {
    renderAt('/bills')
    expect(
      (await screen.findByRole('link', { name: 'New recurring bill' })).getAttribute('href'),
    ).toBe('/bills/recurring/new')
  })
})
