import type { Groups, Members, Schedules } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
