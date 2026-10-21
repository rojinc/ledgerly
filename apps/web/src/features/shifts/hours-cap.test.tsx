import type { Groups, Profiles, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Query } from 'appwrite'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { useGroups } from '../groups/use-groups'
import { hoursCapOf } from '../profile/hours-cap-values'
import { useProfile } from '../profile/use-profile'
import { durationText, HoursCapSummary } from './hours-cap'
import { ShiftForm } from './shift-form'
import type { ShiftValues } from './shift-values'

vi.mock('../../lib/appwrite', () => ({ DATABASE_ID: 'main', tablesDB: { listRows: vi.fn() } }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn() }))

const listRows = vi.mocked(tablesDB.listRows)

// Sunday 25 October in UTC, but already Monday the 26th in Sydney: a new week there.
const NOW = new Date('2026-10-25T13:30:00.000Z')

const NO_CAP = { hoursCapMinutes: null, hoursCapPeriod: null, hoursCapStartsOn: null }

function mockProfile(cap: Partial<Profiles> = {}) {
  vi.mocked(useProfile).mockReturnValue({
    data: { personId: 'p1', timezone: 'Australia/Sydney', ...NO_CAP, ...cap },
  } as never)
}

const week = (minutes: number) => ({ hoursCapMinutes: minutes, hoursCapPeriod: 'week' as const })

function employer(id: string, extra: Partial<Groups> = {}): Groups {
  return {
    $id: id,
    type: 'employer',
    name: id,
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    archivedAt: null,
    ownerPersonId: 'p1',
    ...extra,
  } as Groups
}

/** A stored shift row as the read selects it. */
function row(id: string, date: string, minutes: number) {
  return { $id: id, date, status: 'posted', inputJson: JSON.stringify({ shift: { minutes } }) }
}

function mockRows(rows: unknown[]) {
  listRows.mockResolvedValue({ total: rows.length, rows } as never)
}

function wrap(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(useGroups).mockReturnValue({
    data: [
      employer('g1'),
      employer('g9', { archivedAt: '2026-09-01' }),
      // Shifts here pay someone else.
      employer('g2', { ownerPersonId: 'p2' }),
      { ...employer('g3'), type: 'house' },
    ],
  } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('hoursCapOf and durationText', () => {
  it('reads the limit from the profile, or null', () => {
    expect(hoursCapOf(NO_CAP)).toBeNull()
    expect(hoursCapOf({ ...NO_CAP, ...week(2400) })).toEqual({ minutes: 2400, period: 'week' })
    expect(
      hoursCapOf({
        hoursCapMinutes: 4800,
        hoursCapPeriod: 'fortnight',
        hoursCapStartsOn: '2026-10-19',
      }),
    ).toEqual({ minutes: 4800, period: 'fortnight', startsOn: '2026-10-19' })
    expect(
      hoursCapOf({ hoursCapMinutes: 4800, hoursCapPeriod: 'fortnight', hoursCapStartsOn: null }),
    ).toBeNull()
    // A profile cached from before the columns.
    expect(hoursCapOf({} as never)).toBeNull()
  })

  it('writes minutes in words', () => {
    expect(durationText(1890)).toBe('31 h 30 min')
    expect(durationText(2400)).toBe('40 h')
    expect(durationText(45)).toBe('45 min')
    expect(durationText(0)).toBe('0 h')
  })
})

describe('HoursCapSummary (Today and Home)', () => {
  it('adds up this week in the profile’s zone, from the shifts that pay you', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 1200), row('b', '2026-10-30', 690)])
    wrap(<HoursCapSummary />)
    const line = await screen.findByText(/^This week:/)
    expect(line.textContent).toBe('This week: 31 h 30 min of your 40 h.')
    expect(listRows).toHaveBeenCalledTimes(1)
    expect(listRows).toHaveBeenCalledWith({
      databaseId: 'main',
      tableId: 'transactions',
      queries: [
        // The groups you own, archived ones too.
        Query.equal('groupId', ['g1', 'g9']),
        // Monday to Sunday in Sydney, not the UTC week that ends today.
        Query.greaterThanEqual('date', '2026-10-26'),
        Query.lessThanEqual('date', '2026-11-01'),
        Query.equal('kind', 'shift'),
        Query.equal('status', ['posted', 'scheduled']),
        Query.select(['$id', 'date', 'status', 'inputJson']),
        Query.orderAsc('date'),
        Query.limit(100),
      ],
    })
  })

  it('reads every page past 100 shifts, with a cursor', async () => {
    mockProfile(week(2400))
    const many = Array.from({ length: 150 }, (_, index) => row(`r${index}`, '2026-10-27', 10))
    listRows.mockImplementation((async ({ queries }: { queries: string[] }) => {
      const rows = queries.includes(Query.cursorAfter('r99')) ? many.slice(100) : many.slice(0, 100)
      return { total: rows.length, rows }
    }) as never)
    wrap(<HoursCapSummary />)
    // 150 shifts of 10 minutes.
    expect((await screen.findByText(/^This week:/)).textContent).toBe(
      'This week: 25 h of your 40 h.',
    )
    expect(listRows).toHaveBeenCalledTimes(2)
  })

  it('says when you’ve reached your limit, in words', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 2400)])
    wrap(<HoursCapSummary />)
    const line = await screen.findByText(/^This week:/)
    expect(line.textContent).toBe('This week: 40 h of your 40 h. You’ve reached your limit.')
  })

  it('says how far over the limit you are', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 2400), row('b', '2026-11-01', 135)])
    wrap(<HoursCapSummary />)
    const line = await screen.findByText(/^This week:/)
    expect(line.textContent).toBe(
      'This week: 42 h 15 min of your 40 h. 2 h 15 min over your limit.',
    )
  })

  it('counts a fortnight from its first Monday', async () => {
    mockProfile({
      hoursCapMinutes: 4800,
      hoursCapPeriod: 'fortnight',
      hoursCapStartsOn: '2026-10-19',
    })
    mockRows([row('a', '2026-10-19', 2400), row('b', '2026-10-26', 450)])
    wrap(<HoursCapSummary />)
    const line = await screen.findByText(/^This fortnight:/)
    expect(line.textContent).toBe('This fortnight: 47 h 30 min of your 80 h.')
    const queries = (listRows.mock.calls[0]?.[0] as unknown as { queries: string[] } | undefined)
      ?.queries
    expect(queries).toContain(Query.greaterThanEqual('date', '2026-10-19'))
    expect(queries).toContain(Query.lessThanEqual('date', '2026-11-01'))
  })

  it('counts a running timer’s minutes so far, in a group you own', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 1800)])
    const running = {
      $id: 'r1',
      groupId: 'g1',
      date: '2026-10-26',
      status: 'running',
      startedAt: '2026-10-25T12:00:00.000Z',
    } as Transactions
    const { unmount } = wrap(<HoursCapSummary running={running} />)
    expect((await screen.findByText(/^This week:/)).textContent).toBe(
      'This week: 31 h 30 min of your 40 h.',
    )
    unmount()
    // Not one you own, or before this week: not counted.
    for (const other of [
      { ...running, groupId: 'g2' },
      { ...running, date: '2026-10-25' },
      { ...running, startedAt: null },
    ]) {
      const { unmount: done } = wrap(<HoursCapSummary running={other} />)
      expect((await screen.findByText(/^This week:/)).textContent).toBe(
        'This week: 30 h of your 40 h.',
      )
      done()
    }
  })

  it('reads nothing and shows nothing with no limit set', async () => {
    mockProfile()
    const { container } = wrap(<HoursCapSummary />)
    await Promise.resolve()
    expect(container.textContent).toBe('')
    expect(listRows).not.toHaveBeenCalled()
  })

  it('counts a shift with no stored minutes as none', async () => {
    mockProfile(week(2400))
    mockRows([
      row('a', '2026-10-26', 600),
      { ...row('b', '2026-10-26', 0), inputJson: '{' },
      { ...row('c', '2026-10-26', 0), inputJson: '{}' },
    ])
    wrap(<HoursCapSummary />)
    expect((await screen.findByText(/^This week:/)).textContent).toBe(
      'This week: 10 h of your 40 h.',
    )
  })
})

describe('ShiftForm’s line (#53)', () => {
  const values: ShiftValues = {
    groupId: 'g1',
    date: '2026-10-28',
    description: 'Shift',
    timing: 'hours',
    startTime: '',
    endTime: '',
    breakMinutes: '',
    hours: '',
    rate: '30',
    note: '',
  }

  function renderForm(id: string, defaults: Partial<ShiftValues> = {}) {
    const onSave = vi.fn().mockResolvedValue(undefined)
    wrap(
      <ShiftForm
        groups={[employer('g1'), employer('g2', { ownerPersonId: 'p2' })]}
        id={id}
        defaultValues={{ ...values, ...defaults }}
        submitLabel="Save"
        rateFor={() => '30'}
        onSave={onSave}
      />,
    )
    return onSave
  }

  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('adds a new shift to the week of its date, and still saves over the limit', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 2160)])
    const onSave = renderForm('new1')
    type('Hours worked', '6')
    const line = await screen.findByText(/^With this shift:/)
    expect(line.textContent).toBe(
      'With this shift: 42 h of your 40 h this week. 2 h over your limit.',
    )
    expect(line.getAttribute('aria-live')).toBe('polite')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
  })

  it('doesn’t count an edited shift twice', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 2160), row('s1', '2026-10-28', 360)])
    renderForm('s1', { hours: '6' })
    expect((await screen.findByText(/^With this shift:/)).textContent).toBe(
      'With this shift: 42 h of your 40 h this week. 2 h over your limit.',
    )
  })

  it('uses the week of the date typed', async () => {
    mockProfile(week(2400))
    mockRows([])
    renderForm('new1', { hours: '8' })
    await screen.findByText(/^With this shift:/)
    type('Date', '2026-11-02')
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        expect.objectContaining({
          queries: expect.arrayContaining([Query.greaterThanEqual('date', '2026-11-02')]),
        }),
      ),
    )
  })

  it('shows nothing for a shift that pays someone else, or with no hours yet', async () => {
    mockProfile(week(2400))
    mockRows([row('a', '2026-10-26', 2160)])
    renderForm('new1', { hours: '6' })
    await screen.findByText(/^With this shift:/)
    type('Employer', 'g2')
    await waitFor(() => expect(screen.queryByText(/^With this shift:/)).toBeNull())
    cleanup()
    renderForm('new1')
    await waitFor(() => expect(listRows).toHaveBeenCalled())
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(screen.queryByText(/^With this shift:/)).toBeNull()
  })

  it('reads nothing with no limit set', async () => {
    mockProfile()
    renderForm('new1', { hours: '6' })
    await Promise.resolve()
    expect(screen.queryByText(/^With this shift:/)).toBeNull()
    expect(listRows).not.toHaveBeenCalled()
  })
})
