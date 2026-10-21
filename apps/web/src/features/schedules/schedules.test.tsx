import type { Groups, Members, Schedules } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useGroups, useMyMember } from '../groups/use-groups'
import { scheduleRoutes } from './routes'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'pw' } }) }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn(), useMyMember: vi.fn() }))

const listRows = vi.mocked(tablesDB.listRows)
const getRow = vi.mocked(tablesDB.getRow)
const call = vi.mocked(callFunction)

const acme = {
  $id: 'g1',
  type: 'employer',
  name: 'Acme',
  ownerPersonId: 'pw',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  archivedAt: null,
  settingsJson: JSON.stringify({
    type: 'employer',
    defaultRateCents: 2500,
    paymentTermsDays: 7,
    autoFinalize: false,
    recipients: [],
  }),
} as Groups

const thursdays = {
  $id: 'abcdefghij0123456789',
  groupId: 'g1',
  kind: 'shift',
  description: 'Thursday shift',
  templateJson: JSON.stringify({ shift: { minutes: 300, rateCents: 2500 } }),
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  startsOn: '2026-10-22',
  endsOn: null,
  exdates: ['2026-11-05'],
  skipPublicHolidays: true,
  autoPost: false,
  horizonDays: 56,
  // Running: the scheduler looks at it again tomorrow.
  nextRunAt: '2026-10-19T19:00:00.000Z',
  createdBy: 'pw',
} as Schedules

function mockGroup(group: Groups, role: Members['role'] = 'admin') {
  vi.mocked(useGroups).mockReturnValue({ data: [group], isError: false } as never)
  vi.mocked(useMyMember).mockReturnValue({ data: { role }, isError: false } as never)
}

function mockSchedules(rows: Schedules[]) {
  listRows.mockResolvedValue({ total: rows.length, rows } as never)
  getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
    rows.find((row) => row.$id === rowId)) as never)
}

/** The scheduler answers the preview with these dates, and anything else with `other`. */
function mockScheduler(other?: Result<unknown>) {
  call.mockImplementation(async (_fn, _method, path) =>
    path === '/schedules/preview'
      ? {
          ok: true,
          data: {
            dates: ['2026-10-22', '2026-10-29'],
            skipped: [
              { date: '2026-11-05', reason: 'exdate' },
              { date: '2026-12-24', reason: 'holiday' },
            ],
          },
        }
      : (other ?? { ok: true, data: { schedule: thursdays, created: 2 } }),
  )
}

function renderAt(path: string) {
  const router = createMemoryRouter([scheduleRoutes, { path: '*', element: null }], {
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

function callsTo(path: string) {
  return call.mock.calls.filter((args) => args[2] === path)
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('NewSchedulePage', () => {
  it('builds every Thursday 5h at the default rate, previews it, and creates it', async () => {
    mockGroup(acme)
    mockScheduler()
    const { router } = renderAt('/schedules/new?groupId=g1')
    expect((screen.getByLabelText('Hourly rate (AUD)') as HTMLInputElement).value).toBe('25.00')
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-10-22' } })
    fireEvent.click(screen.getByLabelText(/Skip public holidays/))

    // The preview asks once the form settles, with the input the API takes.
    const preview = screen.getByRole('region', { name: 'Next shifts' })
    expect(await within(preview).findByText(/(22 Oct|Oct 22),? 2026/)).toBeTruthy()
    expect(within(preview).getAllByText(/\$125\.00$/)).toHaveLength(2)
    expect(within(preview).getByText(/(24 Dec|Dec 24),? 2026: public holiday/)).toBeTruthy()
    expect(within(preview).getByText(/(5 Nov|Nov 5),? 2026: a day you skipped/)).toBeTruthy()
    expect(callsTo('/schedules/preview').at(-1)?.[3]).toEqual({
      groupId: 'g1',
      kind: 'shift',
      description: 'Shift',
      template: { shift: { minutes: 300, rateCents: 2500 } },
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      startsOn: '2026-10-22',
      skipPublicHolidays: true,
      autoPost: false,
      count: 10,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(callsTo('/schedules')).toHaveLength(1))
    const [, method, , input] = callsTo('/schedules')[0] ?? []
    expect(method).toBe('POST')
    expect(input).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=TH', startsOn: '2026-10-22' })
    expect((input as { id: string }).id).toHaveLength(20)
    await waitFor(() => expect(router.state.location.search).toBe('?groupId=g1'))
  })

  it('builds the other documented shapes from the form', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Tuesday'))
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '7:30' } })
    await waitFor(() =>
      expect(callsTo('/schedules/preview').at(-1)?.[3]).toMatchObject({
        rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
        template: { shift: { minutes: 450 } },
      }),
    )
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'monthly' } })
    fireEvent.change(screen.getByLabelText('On day'), { target: { value: '-1' } })
    fireEvent.click(screen.getByLabelText('After a number of shifts'))
    fireEvent.change(screen.getByLabelText('Number of shifts'), { target: { value: '6' } })
    await waitFor(() =>
      expect(callsTo('/schedules/preview').at(-1)?.[3]).toMatchObject({
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6',
      }),
    )
  })

  it('asks for no preview, and refuses to save, until the form makes sense', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    // No day picked yet.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(callsTo('/schedules/preview')).toHaveLength(0)
    expect(screen.getByText('Fill in the form to see the dates.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Pick at least one day')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: 'five' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Enter hours like 5, 7.5 or 7:30')).toBeTruthy()
    expect(callsTo('/schedules')).toHaveLength(0)
  })

  it('asks once the form settles, not on every keystroke', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Thursday'))
    // Typed 100 ms apart: well inside the 400 ms the preview waits for.
    for (const hours of ['5', '6', '5.5']) {
      fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: hours } })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await waitFor(() => expect(callsTo('/schedules/preview')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(callsTo('/schedules/preview')).toHaveLength(1)
    expect(callsTo('/schedules/preview')[0]?.[3]).toMatchObject({
      template: { shift: { minutes: 330 } },
    })
  })

  it('drops the old dates once the form stops making sense', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    const preview = screen.getByRole('region', { name: 'Next shifts' })
    expect(await within(preview).findByText(/(22 Oct|Oct 22),? 2026/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Thursday'))
    expect(await within(preview).findByText('Fill in the form to see the dates.')).toBeTruthy()
    expect(within(preview).queryByText(/(22 Oct|Oct 22),? 2026/)).toBeNull()
    expect(within(preview).queryByText('Skipped')).toBeNull()
  })

  it('refuses a count over 500 on the count field, before sending', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    fireEvent.click(screen.getByLabelText('After a number of shifts'))
    fireEvent.change(screen.getByLabelText('Number of shifts'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Enter a number from 1 to 500')).toBeTruthy()
    expect(callsTo('/schedules')).toHaveLength(0)
  })

  it('shows a refusal from the scheduler in the form', async () => {
    mockGroup(acme)
    mockScheduler({ ok: false, error: { code: 'FORBIDDEN', message: 'Only an admin can.' } })
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Only an admin can.')
  })

  it('keeps Create schedule focusable while saving, and sends once', async () => {
    mockGroup(acme)
    // The create never answers.
    mockScheduler(new Promise(() => {}) as never)
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving.getAttribute('aria-disabled')).toBe('true')
    saving.focus()
    expect(document.activeElement).toBe(saving)
    fireEvent.click(saving)
    expect(fireEvent.submit(saving.closest('form') as HTMLFormElement)).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(callsTo('/schedules')).toHaveLength(1)
  })

  it('has no form for someone who isn’t an admin, or in an archived group', () => {
    mockGroup(acme, 'member')
    renderAt('/schedules/new?groupId=g1')
    expect(screen.getByText('Only an admin can set up schedules in this group.')).toBeTruthy()
    cleanup()
    mockGroup({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/schedules/new?groupId=g1')
    expect(
      screen.getByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create schedule' })).toBeNull()
  })
})

describe('EditSchedulePage', () => {
  it('opens a schedule as saved and saves it with PATCH, keeping its skipped days', async () => {
    mockGroup(acme)
    mockSchedules([thursdays])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    expect(await screen.findByRole('heading', { name: 'Thursday shift' })).toBeTruthy()
    expect((screen.getByLabelText('Thursday') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Paid hours per shift') as HTMLInputElement).value).toBe('5')
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(1))
    const [, method, , input] = callsTo(`/schedules/${thursdays.$id}`)[0] ?? []
    expect(method).toBe('PATCH')
    expect(input).toMatchObject({
      id: thursdays.$id,
      template: { shift: { minutes: 360, rateCents: 2500 } },
      exdates: ['2026-11-05'],
    })
  })

  it('keeps the end date and horizon it doesn’t show, and lets a creator who isn’t an admin save', async () => {
    mockGroup(acme, 'member')
    mockSchedules([{ ...thursdays, endsOn: '2026-12-31', horizonDays: 120 }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(1))
    expect(callsTo(`/schedules/${thursdays.$id}`)[0]?.[3]).toMatchObject({
      endsOn: '2026-12-31',
      exdates: ['2026-11-05'],
      horizonDays: 120,
    })
  })

  it('says why when a new start is after the kept end date', async () => {
    mockGroup(acme)
    mockSchedules([{ ...thursdays, endsOn: '2026-12-31' }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    fireEvent.change(await screen.findByLabelText('Starts on'), { target: { value: '2027-01-07' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Must be on or before the schedule’s end date')).toBeTruthy()
    expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(0)
  })

  it('won’t edit a shift template with more than hours and rate, so a save can’t drop it', async () => {
    mockGroup(acme)
    mockSchedules([
      {
        ...thursdays,
        templateJson: JSON.stringify({
          shift: { minutes: 300, rateCents: 2500, breakMinutes: 30 },
        }),
      },
    ])
    renderAt(`/schedules/${thursdays.$id}`)
    expect(await screen.findByText(/set up in a way this page can’t show/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('won’t edit a rule this page can’t show', async () => {
    mockGroup(acme)
    mockSchedules([{ ...thursdays, rrule: 'FREQ=DAILY' }])
    renderAt(`/schedules/${thursdays.$id}`)
    expect(await screen.findByText(/set up in a way this page can’t show/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})

describe('SchedulesPage', () => {
  it('lists the group’s schedules in words, and ends one on a date', async () => {
    mockGroup(acme)
    mockSchedules([thursdays])
    mockScheduler({ ok: true, data: { schedule: { ...thursdays, endsOn: '2026-12-31' } } })
    renderAt('/schedules?groupId=g1')
    expect(
      await screen.findByText(/^Every Thursday · from Thu, (22 Oct|Oct 22),? 2026$/),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'New schedule' }).getAttribute('href')).toBe(
      '/schedules/new?groupId=g1',
    )
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2026-12-31' } })
    fireEvent.click(screen.getByRole('button', { name: 'End schedule' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('scheduler', 'POST', `/schedules/${thursdays.$id}/end`, {
        endsOn: '2026-12-31',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('button', { name: 'End schedule' })).toBeNull())
  })

  it('offers no New, Edit or End to a member on someone else’s schedule, or when archived', async () => {
    mockGroup(acme, 'member')
    mockSchedules([{ ...thursdays, createdBy: 'pe' }])
    renderAt('/schedules?groupId=g1')
    expect(await screen.findByText('Thursday shift')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'New schedule' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Thursday shift' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull()
    cleanup()
    mockGroup({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/schedules?groupId=g1')
    expect(await screen.findByText('Thursday shift')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull()
  })
})

// #137 review (lead, 06:17): B1 and the should-fixes.
describe('#137 review', () => {
  // 11:00 on Monday 19 Oct 2026 in Sydney.
  const NOW = new Date('2026-10-19T00:00:00.000Z')
  const fakeToday = () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  }
  afterEach(() => vi.useRealTimers())

  const fill = (hours = '5') => {
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: hours } })
  }

  it('B1: with no day ticked, says so there only, with no rule jargon on Starts on', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Pick at least one day')).toBeTruthy()
    expect(screen.getByLabelText('Starts on').getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByText(/KEY=VALUE|BYDAY|startsOn/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('B1: a last date before the start says so in words, under Last date', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fill()
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-10-22' } })
    fireEvent.click(screen.getByLabelText('On a date'))
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2026-10-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Must be on or after the start date')).toBeTruthy()
    expect(screen.getByLabelText('Last date').getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByText(/UNTIL/)).toBeNull()
    expect(callsTo('/schedules')).toHaveLength(0)
  })

  it('starts a new schedule at most 31 days ago, and says past dates are created too', async () => {
    fakeToday()
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fill()
    const startsOn = screen.getByLabelText('Starts on') as HTMLInputElement
    expect(startsOn.min).toBe('2026-09-18')
    fireEvent.change(startsOn, { target: { value: '2006-10-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText(/^Pick a date from .*2026 on$/)).toBeTruthy()
    expect(callsTo('/schedules')).toHaveLength(0)
    fireEvent.change(startsOn, { target: { value: '2026-10-08' } })
    const preview = screen.getByRole('region', { name: 'Next shifts' })
    expect(
      within(preview).getByText(
        /^Dates from Thu, (8 Oct|Oct 8),? 2026 to yesterday are created too\. They wait for you to confirm them\.$/,
      ),
    ).toBeTruthy()
    // From today on, no note.
    fireEvent.change(startsOn, { target: { value: '2026-10-19' } })
    expect(within(preview).queryByText(/to yesterday are created too/)).toBeNull()
    fireEvent.change(startsOn, { target: { value: '2026-10-08' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(callsTo('/schedules')).toHaveLength(1))
    expect(callsTo('/schedules')[0]?.[3]).toMatchObject({ startsOn: '2026-10-08' })
  })

  it('keeps an edited schedule’s start, however old, with no limit', async () => {
    fakeToday()
    mockGroup(acme)
    mockSchedules([{ ...thursdays, exdates: [], startsOn: '2025-01-02' }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    const startsOn = (await screen.findByLabelText('Starts on')) as HTMLInputElement
    expect(startsOn.min).toBe('')
  })

  it('gives the hour limits their own messages', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fill('25')
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('At most 24 hours a shift')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Enter more than 0 hours')).toBeTruthy()
  })

  it('prices a shift as the ledger rounds it, not cut down', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    // 7 h 20 min at $25.55 is $187.3666…: the ledger rounds it to $187.37.
    fill('7:20')
    fireEvent.change(screen.getByLabelText('Hourly rate (AUD)'), { target: { value: '25.55' } })
    const preview = screen.getByRole('region', { name: 'Next shifts' })
    expect((await within(preview).findAllByText(/\$187\.37$/)).length).toBeGreaterThan(0)
  })

  it('says every 3 weeks, not every other week, for three', () => {
    mockGroup(acme)
    renderAt('/schedules/new?groupId=g1')
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '3' } })
    expect(screen.getByText('Every 3 weeks counts from this week.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } })
    expect(screen.getByText('Every other week counts from this week.')).toBeTruthy()
  })

  it('puts focus on the list’s heading after saving, and refreshes Today and the calendar', async () => {
    mockGroup(acme)
    mockScheduler()
    mockSchedules([thursdays])
    const { queryClient } = renderAt('/schedules/new?groupId=g1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 1, name: 'Schedules' }),
      ),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['today'] })
  })

  it('shows a schedule as ended once its end date or its rule’s last date has passed', async () => {
    fakeToday()
    mockGroup(acme)
    mockSchedules([
      { ...thursdays, $id: 's1', description: 'Ended by date', endsOn: '2026-10-18' },
      { ...thursdays, $id: 's2', description: 'Ends today', endsOn: '2026-10-19' },
      {
        ...thursdays,
        $id: 's3',
        description: 'Rule ended',
        rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015',
      },
      {
        ...thursdays,
        $id: 's4',
        description: 'Ten shifts',
        rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=10',
      },
    ])
    renderAt('/schedules?groupId=g1')
    const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement
    for (const name of ['Ended by date', 'Rule ended']) {
      const ended = await row(name)
      expect(within(ended).getByText(/· Ended$/)).toBeTruthy()
      expect(within(ended).queryByRole('button', { name: 'End' })).toBeNull()
      expect(within(ended).queryByRole('link')).toBeNull()
    }
    const today = await row('Ends today')
    expect(within(today).queryByText(/· Ended$/)).toBeNull()
    expect(within(today).getByRole('button', { name: 'End' })).toBeTruthy()
    expect(within(await row('Rule ended')).getByText(/^Every Thursday, until /)).toBeTruthy()
    expect(
      within(await row('Ten shifts')).getByText(/^Every Thursday, 10 shifts · from /),
    ).toBeTruthy()
  })

  it('ends from today by default, or from the start when it hasn’t started', async () => {
    fakeToday()
    mockGroup(acme)
    mockSchedules([
      { ...thursdays, $id: 's1', description: 'Running', startsOn: '2026-10-01' },
      { ...thursdays, $id: 's2', description: 'Later', startsOn: '2026-11-05' },
    ])
    renderAt('/schedules?groupId=g1')
    const running = (await screen.findByText('Running')).closest('li') as HTMLElement
    fireEvent.click(within(running).getByRole('button', { name: 'End' }))
    expect((within(running).getByLabelText('Last date') as HTMLInputElement).value).toBe(
      '2026-10-19',
    )
    const later = screen.getByText('Later').closest('li') as HTMLElement
    fireEvent.click(within(later).getByRole('button', { name: 'End' }))
    expect((within(later).getByLabelText('Last date') as HTMLInputElement).value).toBe('2026-11-05')
  })

  it('checks End’s date in words, and puts focus back on End after Cancel or ending', async () => {
    mockGroup(acme)
    mockSchedules([thursdays])
    mockScheduler({ ok: true, data: { schedule: { ...thursdays, endsOn: '2099-12-31' } } })
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'End' }))
    const field = screen.getByLabelText('Last date')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '2026-10-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'End schedule' }))
    expect(
      screen.getByText(/^Pick a date on or after the start, Thu, (22 Oct|Oct 22),? 2026$/),
    ).toBeTruthy()
    expect(callsTo(`/schedules/${thursdays.$id}/end`)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'End' }))
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2099-12-31' } })
    fireEvent.click(screen.getByRole('button', { name: 'End schedule' }))
    await waitFor(() => expect(callsTo(`/schedules/${thursdays.$id}/end`)).toHaveLength(1))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'End' })),
    )
  })

  it('shows no past-dates note when editing: an edit doesn’t recreate them', async () => {
    fakeToday()
    mockGroup(acme)
    mockSchedules([{ ...thursdays, exdates: [], startsOn: '2026-10-01' }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    const preview = await screen.findByRole('region', { name: 'Next shifts' })
    await within(preview).findByText(/(22 Oct|Oct 22),? 2026/)
    expect(within(preview).queryByText(/to yesterday are created too/)).toBeNull()
  })

  it('puts focus on the list’s heading after ending on a past date, as End goes', async () => {
    fakeToday()
    mockGroup(acme)
    const running = { ...thursdays, startsOn: '2026-09-03' }
    mockSchedules([running])
    // The scheduler answers with the schedule ended yesterday; the list reads it as stored.
    call.mockImplementation(async () => {
      const ended = { ...running, endsOn: '2026-10-18' }
      mockSchedules([ended])
      return { ok: true, data: { schedule: ended } }
    })
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'End' }))
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2026-10-18' } })
    fireEvent.click(screen.getByRole('button', { name: 'End schedule' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: /^Shift schedules in/ }),
      ),
    )
    expect(await screen.findByText(/· Ended$/)).toBeTruthy()
  })

  it('gives a viewer no Edit or End, even on a schedule they set up', async () => {
    mockGroup(acme, 'viewer')
    mockSchedules([thursdays])
    renderAt('/schedules?groupId=g1')
    expect(await screen.findByText('Thursday shift')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Thursday shift' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull()
    cleanup()
    mockGroup(acme, 'viewer')
    renderAt(`/schedules/${thursdays.$id}`)
    expect(
      await screen.findByText(
        'Only an admin, or the member who set it up, can change this schedule.',
      ),
    ).toBeTruthy()
  })
})

// #428: a schedule an archive stopped stays stopped until Restart (scheduling.md, step 1).
describe('Restart', () => {
  // 11:00 on Monday 19 Oct 2026 in Sydney.
  const NOW = new Date('2026-10-19T00:00:00.000Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  // Archived on 14 Oct, before it was made up to its end.
  const stopped = {
    ...thursdays,
    startsOn: '2026-09-03',
    nextRunAt: null,
    generatedThrough: '2026-10-14',
  }
  const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement
  // Schedule IDs are 20 characters (scheduleInputSchema).
  const id = (n: number) => `schedule${n}`.padEnd(20, '0')

  it('sends the stopped schedule’s stored input unchanged, then says so and refreshes the list', async () => {
    mockGroup(acme)
    mockSchedules([stopped])
    // Running again: the list then reads it as stored.
    const running = { ...stopped, nextRunAt: '2026-10-19T19:00:00.000Z' }
    call.mockImplementation(async () => {
      mockSchedules([running])
      return { ok: true, data: { schedule: running, created: 4, updated: 0, removed: 0 } }
    })
    const { queryClient } = renderAt('/schedules?groupId=g1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const restart = await screen.findByRole('button', { name: 'Restart' })
    // Stopped: Restart and End, no Pause, which would start it again without Restart's checks.
    expect(screen.getByRole('button', { name: 'End' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    fireEvent.click(restart)
    await waitFor(() => expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(1))
    const [fn, method, , input] = callsTo(`/schedules/${thursdays.$id}`)[0] ?? []
    expect([fn, method]).toEqual(['scheduler', 'PATCH'])
    expect(input).toStrictEqual({
      id: thursdays.$id,
      groupId: 'g1',
      kind: 'shift',
      description: 'Thursday shift',
      template: { shift: { minutes: 300, rateCents: 2500 } },
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      startsOn: '2026-09-03',
      exdates: ['2026-11-05'],
      horizonDays: 56,
      skipPublicHolidays: true,
      autoPost: false,
    })
    expect(
      await screen.findByText(
        'Restarted. Shifts carry on from today; the days it was stopped aren’t added.',
      ),
    ).toBeTruthy()
    // Its Restart goes, and Pause (#430) takes its place.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' })),
    )
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedules', 'g1'] })
  })

  it('keeps an end date and a rule’s end it doesn’t show', async () => {
    mockGroup(acme)
    mockSchedules([{ ...stopped, endsOn: '2026-12-31', rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=20' }])
    mockScheduler()
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(1))
    expect(callsTo(`/schedules/${thursdays.$id}`)[0]?.[3]).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=20',
      endsOn: '2026-12-31',
    })
  })

  it('is offered on a stopped schedule not made up to its end, never on a running or finished one', async () => {
    mockGroup(acme)
    mockSchedules([
      { ...thursdays, $id: id(1), description: 'Running' },
      { ...stopped, $id: id(2), description: 'Never ends' },
      { ...stopped, $id: id(3), description: 'Ends today', endsOn: '2026-10-19' },
      { ...stopped, $id: id(4), description: 'Ended yesterday', endsOn: '2026-10-18' },
      {
        ...stopped,
        $id: id(5),
        description: 'Until next week',
        rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261029',
      },
      {
        ...stopped,
        $id: id(6),
        description: 'Until last week',
        rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015',
      },
      // 3 Sep to 1 Oct.
      { ...stopped, $id: id(7), description: 'Five shifts', rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=5' },
      // 3 Sep to 22 Oct.
      {
        ...stopped,
        $id: id(8),
        description: 'Eight shifts',
        rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=8',
      },
      {
        ...stopped,
        $id: id(9),
        description: 'Eight shifts, all made',
        rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=8',
        generatedThrough: '2026-10-22',
      },
      // Running: step 1 cleared nextRunAt once it was made up to its end, 24 days ahead.
      {
        ...stopped,
        $id: id(10),
        description: 'Made up to its end',
        endsOn: '2026-11-12',
        generatedThrough: '2026-11-12',
      },
      // Its end moved earlier after it was made further.
      {
        ...stopped,
        $id: id(11),
        description: 'Made past its end',
        endsOn: '2026-11-12',
        generatedThrough: '2026-12-01',
      },
      {
        ...stopped,
        $id: id(12),
        description: 'A day short',
        endsOn: '2026-11-12',
        generatedThrough: '2026-11-11',
      },
      {
        ...stopped,
        $id: id(13),
        description: 'Never made',
        endsOn: '2026-11-12',
        generatedThrough: null,
      },
      // Paused from a day still ahead: Resume (#430), never Restart.
      { ...stopped, $id: id(14), description: 'Paused', pausedFrom: '2026-11-02' },
    ])
    renderAt('/schedules?groupId=g1')
    const offered: string[] = []
    for (const name of [
      'Running',
      'Never ends',
      'Ends today',
      'Ended yesterday',
      'Until next week',
      'Until last week',
      'Five shifts',
      'Eight shifts',
      'Eight shifts, all made',
      'Made up to its end',
      'Made past its end',
      'A day short',
      'Never made',
      'Paused',
    ]) {
      if (within(await row(name)).queryByRole('button', { name: 'Restart' })) offered.push(name)
    }
    expect(offered).toEqual([
      'Never ends',
      'Ends today',
      'Until next week',
      'Eight shifts',
      'A day short',
      'Never made',
    ])
  })

  it('is offered to an admin, or a member on a schedule they set up, never in an archived group', async () => {
    const offered = async () => {
      await screen.findByText('Thursday shift')
      return screen.queryByRole('button', { name: 'Restart' }) !== null
    }
    mockSchedules([stopped])
    mockGroup(acme, 'member')
    renderAt('/schedules?groupId=g1')
    expect(await offered()).toBe(true)
    cleanup()
    mockSchedules([{ ...stopped, createdBy: 'pe' }])
    mockGroup(acme, 'member')
    renderAt('/schedules?groupId=g1')
    expect(await offered()).toBe(false)
    cleanup()
    mockSchedules([{ ...stopped, createdBy: 'pe' }])
    mockGroup(acme, 'admin')
    renderAt('/schedules?groupId=g1')
    expect(await offered()).toBe(true)
    cleanup()
    mockSchedules([stopped])
    mockGroup(acme, 'viewer')
    renderAt('/schedules?groupId=g1')
    expect(await offered()).toBe(false)
    cleanup()
    mockSchedules([stopped])
    mockGroup({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/schedules?groupId=g1')
    expect(await offered()).toBe(false)
  })

  it('isn’t offered on a schedule its edit form can’t show, as it can’t be saved from here', async () => {
    mockGroup(acme)
    mockSchedules([{ ...stopped, rrule: 'FREQ=DAILY' }])
    renderAt('/schedules?groupId=g1')
    await screen.findByText('Thursday shift')
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  // AI A's N2 on #441: the server would refuse it, so it gets no Restart.
  it('isn’t offered on a stored schedule the schema refuses', async () => {
    mockGroup(acme)
    mockSchedules([{ ...stopped, horizonDays: 121 }])
    renderAt('/schedules?groupId=g1')
    await screen.findByText('Thursday shift')
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('shows the scheduler’s refusal next to it, and sends once while it waits', async () => {
    mockGroup(acme)
    mockSchedules([stopped])
    let answer: (result: Result<unknown>) => void = () => {}
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    const busy = await screen.findByRole('button', { name: 'Restarting…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(busy)
    answer({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Someone it names has left.' },
    })
    expect((await screen.findByRole('alert')).textContent).toBe('Someone it names has left.')
    expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(1)
    expect(screen.queryByText(/^Restarted\./)).toBeNull()
  })
})

describe('SchedulesPage: pause and resume (#430)', () => {
  // 11:00 on Monday 19 Oct 2026 in Sydney.
  const NOW = new Date('2026-10-19T00:00:00.000Z')
  const running = { ...thursdays, startsOn: '2026-10-01' }
  const paused = { ...running, pausedFrom: '2026-11-02' }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  /** The scheduler answers with `after`, which the list then reads as stored. */
  function answerWith(after: Schedules, extra: object) {
    call.mockImplementation(async () => {
      mockSchedules([after])
      return { ok: true, data: { schedule: after, ...extra } }
    })
  }

  it('pauses from today by default, then shows the pause, with focus on Resume', async () => {
    mockGroup(acme)
    mockSchedules([running])
    answerWith({ ...running, pausedFrom: '2026-10-19' }, { removed: 2 })
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    const field = screen.getByLabelText('Pause from') as HTMLInputElement
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('2026-10-19')
    expect(field.min).toBe('2026-10-19')
    fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('scheduler', 'POST', `/schedules/${running.$id}/pause`, {
        pausedFrom: '2026-10-19',
      }),
    )
    expect(await screen.findByText(/· Paused from Mon, (19 Oct|Oct 19),? 2026$/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(
      /^Paused from Mon, (19 Oct|Oct 19),? 2026\.$/,
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Resume' })),
    )
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.getByRole('button', { name: 'End' })).toBeTruthy()
  })

  it('pauses from a later date picked, and says that date', async () => {
    mockGroup(acme)
    mockSchedules([running])
    answerWith(paused, { removed: 1 })
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    fireEvent.change(screen.getByLabelText('Pause from'), { target: { value: '2026-11-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('scheduler', 'POST', `/schedules/${running.$id}/pause`, {
        pausedFrom: '2026-11-02',
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /^Paused from Mon, (2 Nov|Nov 2),? 2026\.$/,
      ),
    )
  })

  it('checks the date in words before sending, and puts focus back on Pause after Cancel', async () => {
    mockGroup(acme)
    mockSchedules([running])
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    const field = screen.getByLabelText('Pause from')
    fireEvent.change(field, { target: { value: '2026-10-18' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }))
    expect(
      screen.getByText(/^Pick today, Mon, (19 Oct|Oct 19),? 2026, or a later date$/),
    ).toBeTruthy()
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }))
    expect(screen.getByText('Required')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }))
  })

  it('resumes with no body, says so, and puts focus on Pause', async () => {
    mockGroup(acme)
    mockSchedules([paused])
    answerWith({ ...paused, pausedFrom: null }, { created: 3 })
    renderAt('/schedules?groupId=g1')
    expect(await screen.findByText(/· Paused from Mon, (2 Nov|Nov 2),? 2026$/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'scheduler',
        'POST',
        `/schedules/${paused.$id}/resume`,
        undefined,
      ),
    )
    expect((await screen.findByRole('status')).textContent).toBe(
      'Resumed. Shifts carry on from today; the days in between aren’t added.',
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' })),
    )
    expect(screen.queryByText(/Paused from/)).toBeNull()
  })

  it('shows a refusal from pause in its form, and from resume under the row', async () => {
    mockGroup(acme)
    mockSchedules([running, { ...paused, $id: 'klmnopqrst0123456789', description: 'Saturdays' }])
    mockScheduler({ ok: false, error: { code: 'FORBIDDEN', message: 'Only an admin can.' } })
    renderAt('/schedules?groupId=g1')
    const row = (await screen.findByText('Thursday shift')).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Pause' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Pause schedule' }))
    expect((await within(row).findByRole('alert')).textContent).toBe('Only an admin can.')
    // The form stays, to try again or cancel.
    expect(within(row).getByLabelText('Pause from')).toBeTruthy()
    const other = screen.getByText('Saturdays').closest('li') as HTMLElement
    fireEvent.click(within(other).getByRole('button', { name: 'Resume' }))
    expect((await within(other).findByRole('alert')).textContent).toBe('Only an admin can.')
    expect(within(other).getByText(/Paused from/)).toBeTruthy()
  })

  it('offers no Pause or Resume to a viewer, on someone else’s schedule, when archived, or once ended', async () => {
    const rows = [running, { ...paused, $id: 'klmnopqrst0123456789', description: 'Saturdays' }]
    for (const [role, group, createdBy] of [
      ['viewer', acme, 'pw'],
      ['member', acme, 'pe'],
      ['admin', { ...acme, archivedAt: '2026-10-01T00:00:00.000Z' }, 'pw'],
    ] as const) {
      mockGroup(group as Groups, role)
      mockSchedules(rows.map((row) => ({ ...row, createdBy })))
      renderAt('/schedules?groupId=g1')
      expect(await screen.findByText('Saturdays')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
      cleanup()
    }
    mockGroup(acme)
    mockSchedules([
      { ...running, endsOn: '2026-10-18' },
      { ...paused, $id: 'klmnopqrst0123456789', description: 'Saturdays', endsOn: '2026-10-18' },
    ])
    renderAt('/schedules?groupId=g1')
    expect(await screen.findAllByText(/· Ended$/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('lets a member pause and resume a schedule they set up', async () => {
    mockGroup(acme, 'member')
    mockSchedules([running, { ...paused, $id: 'klmnopqrst0123456789', description: 'Saturdays' }])
    renderAt('/schedules?groupId=g1')
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
  })

  it('lets End wait for a resume on its way, so what the resume says isn’t lost', async () => {
    mockGroup(acme)
    mockSchedules([paused])
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await screen.findByRole('button', { name: 'Resuming…' })
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    expect(screen.queryByLabelText('Last date')).toBeNull()
  })

  it('sends one resume however often Resume is pressed while it’s on its way', async () => {
    mockGroup(acme)
    mockSchedules([paused])
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Resuming…' }))
    // Long enough for a second request to have gone out.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shows a pause at once, before the list reloads, and says the date it was given', async () => {
    mockGroup(acme)
    mockSchedules([running])
    call.mockResolvedValue({
      ok: true,
      data: { schedule: { ...running, pausedFrom: '2026-11-09' }, removed: 0 },
    })
    renderAt('/schedules?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    fireEvent.change(screen.getByLabelText('Pause from'), { target: { value: '2026-11-09' } })
    // Every reload from here never answers: what shows is the pause's own answer.
    listRows.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }))
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.getByText(/· Paused from Mon, (9 Nov|Nov 9),? 2026$/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(
      /^Paused from Mon, (9 Nov|Nov 9),? 2026\.$/,
    )
  })
})

describe('skipped dates on the schedule form (#487)', () => {
  // 01:00 on Monday 19 Oct 2026 in Sydney, the group's time zone, and still Sunday in UTC.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-18T14:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  const lastPreview = () => callsTo('/schedules/preview').at(-1)?.[3] as { exdates?: string[] }
  const skip = (date: string) => {
    fireEvent.change(screen.getByLabelText('Date to skip'), { target: { value: date } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip this date' }))
  }
  // The reason a date was refused, under the input.
  const reason = () => document.getElementById('skipDate-error')?.textContent
  // What the live region reads out.
  const said = () =>
    within(screen.getByRole('group', { name: 'Skipped dates' })).getByText(
      (_, element) => element?.getAttribute('aria-live') === 'polite',
    ).textContent
  const skippedList = () =>
    within(screen.getByRole('group', { name: 'Skipped dates' }))
      .queryAllByRole('button', { name: /^Remove / })
      .map((button) => button.getAttribute('aria-label'))

  it('adds a date to the list and the preview, and removes it from both', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.click(screen.getByLabelText('Thursday'))
    fireEvent.change(screen.getByLabelText('Paid hours per shift'), { target: { value: '5' } })
    skip('2026-11-12')
    skip('2026-11-05')
    // In date order, each Remove named for its date, and the add read out.
    expect(skippedList()).toEqual([
      expect.stringMatching(/^Remove Thu, (5 Nov|Nov 5),? 2026$/),
      expect.stringMatching(/^Remove Thu, (12 Nov|Nov 12),? 2026$/),
    ])
    expect(said()).toMatch(/^Thu, (5 Nov|Nov 5),? 2026 is skipped\.$/)
    await waitFor(() => expect(lastPreview().exdates).toEqual(['2026-11-05', '2026-11-12']))

    const remove = screen.getByRole('button', { name: /^Remove Thu, (5 Nov|Nov 5),? 2026$/ })
    remove.focus()
    fireEvent.click(remove)
    expect(skippedList()).toHaveLength(1)
    expect(said()).toMatch(/^Thu, (5 Nov|Nov 5),? 2026 is no longer skipped\.$/)
    // Its button is gone, so the input takes focus.
    expect(document.activeElement).toBe(screen.getByLabelText('Date to skip'))
    await waitFor(() => expect(lastPreview().exdates).toEqual(['2026-11-12']))
    fireEvent.click(screen.getByRole('button', { name: /^Remove Thu, (12 Nov|Nov 12),? 2026$/ }))
    await waitFor(() => expect(lastPreview()).not.toHaveProperty('exdates'))

    // A new schedule has no planned shifts to remove, so no line about them.
    expect(screen.queryByText(/Saving removes the planned shift/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(callsTo('/schedules')).toHaveLength(1))
    expect(callsTo('/schedules')[0]?.[3]).not.toHaveProperty('exdates')
  })

  it('refuses a date before the start or today, after the last date, or skipped already', async () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-10-22' } })
    skip('2026-10-21')
    expect(reason()).toMatch(/^Pick a date from Thu, (22 Oct|Oct 22),? 2026 on\.$/)
    // Read out too, since focus stays on the button; and cleared once another date is picked.
    expect(said()).toMatch(/^Pick a date from Thu, (22 Oct|Oct 22),? 2026 on\.$/)
    fireEvent.change(screen.getByLabelText('Date to skip'), { target: { value: '2026-10-29' } })
    expect(reason()).toBeUndefined()
    // A start in the past: today is the earliest.
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-10-01' } })
    skip('2026-10-18')
    expect(reason()).toMatch(/^Pick a date from Mon, (19 Oct|Oct 19),? 2026 on\.$/)
    skip('2026-10-19')
    expect(skippedList()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('On a date'))
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2026-11-30' } })
    skip('2026-12-01')
    expect(reason()).toMatch(/^Pick a date on or before Mon, (30 Nov|Nov 30),? 2026\.$/)
    skip('2026-11-30')
    skip('2026-11-30')
    expect(reason()).toMatch(/^Mon, (30 Nov|Nov 30),? 2026 is already skipped\.$/)
    skip('')
    expect(reason()).toBe('Pick a date.')
    expect(skippedList()).toHaveLength(2)
  })

  it('skips the date on Enter, without saving the schedule', () => {
    mockGroup(acme)
    mockScheduler()
    renderAt('/schedules/new?groupId=g1')
    const input = screen.getByLabelText('Date to skip')
    fireEvent.change(input, { target: { value: '2026-11-05' } })
    // fireEvent.keyDown doesn't submit; a submit after it would, unless Enter was stopped.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(skippedList()).toHaveLength(1)
    expect(callsTo('/schedules')).toHaveLength(0)
  })

  it('on an edit, lists only dates from today on, keeps past ones, and saves the new list', async () => {
    mockGroup(acme)
    // Stored out of order, as the API takes them.
    mockSchedules([{ ...thursdays, exdates: ['2026-11-12', '2025-12-25', '2026-11-05'] }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    await screen.findByRole('heading', { name: 'Thursday shift' })
    expect(skippedList()).toEqual([
      expect.stringMatching(/(5 Nov|Nov 5),? 2026$/),
      expect.stringMatching(/(12 Nov|Nov 12),? 2026$/),
    ])
    expect(
      screen.getByText(
        'Saving removes the planned shift on a newly skipped day, unless it’s been edited or confirmed, and brings back the shift on a day you remove, from today on.',
      ),
    ).toBeTruthy()
    skip('2026-11-19')
    fireEvent.click(screen.getByRole('button', { name: /^Remove Thu, (5 Nov|Nov 5),? 2026$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(callsTo(`/schedules/${thursdays.$id}`)).toHaveLength(1))
    const [, method, , input] = callsTo(`/schedules/${thursdays.$id}`)[0] ?? []
    expect(method).toBe('PATCH')
    expect((input as { exdates: string[] }).exdates).toEqual([
      '2025-12-25',
      '2026-11-12',
      '2026-11-19',
    ])
  })

  it('takes the earlier of a kept end date and the rule’s last date', async () => {
    mockGroup(acme)
    mockSchedules([{ ...thursdays, endsOn: '2026-12-31' }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    await screen.findByRole('heading', { name: 'Thursday shift' })
    skip('2027-01-07')
    expect(reason()).toMatch(/^Pick a date on or before Thu, (31 Dec|Dec 31),? 2026\.$/)
    // A later last date for the rule changes nothing.
    fireEvent.click(screen.getByLabelText('On a date'))
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2027-03-01' } })
    skip('2027-01-07')
    expect(reason()).toMatch(/^Pick a date on or before Thu, (31 Dec|Dec 31),? 2026\.$/)
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2026-11-30' } })
    skip('2026-12-10')
    expect(reason()).toMatch(/^Pick a date on or before Mon, (30 Nov|Nov 30),? 2026\.$/)
    expect(skippedList()).toHaveLength(1)
  })

  it('says so at 366 dates, past ones counted, and adds no more', async () => {
    mockGroup(acme)
    const past = Array.from({ length: 365 }, (_, day) =>
      new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10),
    )
    mockSchedules([{ ...thursdays, exdates: past }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    await screen.findByRole('heading', { name: 'Thursday shift' })
    // 365: one more can go in, and then the input says so.
    expect(screen.queryByText('At most 366 dates can be skipped.')).toBeNull()
    skip('2026-11-12')
    expect(skippedList()).toHaveLength(1)
    expect(screen.getAllByText('At most 366 dates can be skipped.')).toHaveLength(1)
    const button = screen.getByRole('button', { name: 'Skip this date' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-describedby')).toBe('skipDate-hint')
    skip('2026-11-19')
    expect(skippedList()).toHaveLength(1)
    expect(screen.getAllByText('At most 366 dates can be skipped.')).toHaveLength(1)
  })

  it('says a schedule that has ended has no dates left to skip', async () => {
    mockGroup(acme)
    mockSchedules([{ ...thursdays, endsOn: '2026-10-15', exdates: [] }])
    mockScheduler()
    renderAt(`/schedules/${thursdays.$id}`)
    await screen.findByRole('heading', { name: 'Thursday shift' })
    skip('2026-10-22')
    expect(reason()).toBe('This schedule has no dates left to skip.')
    expect(skippedList()).toEqual([])
  })
})
