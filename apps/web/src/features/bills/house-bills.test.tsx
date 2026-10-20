import type { Groups, Members, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { ARCHIVED_NOTICE } from '../groups/archive-group'
import { useGroup, useMyMember } from '../groups/use-groups'
import { billRoutes } from './routes'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { getRow: vi.fn(), listRows: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: 'alice', personalGroupId: 'g1' } }),
}))
vi.mock('../groups/use-groups', () => ({ useGroup: vi.fn(), useMyMember: vi.fn() }))

const call = vi.mocked(callFunction)
const getRow = vi.mocked(tablesDB.getRow)
const listRows = vi.mocked(tablesDB.listRows)

// 00:00 UTC on 5 October: 10 am in Sydney, still the 4th in New York.
const NOW = new Date('2026-10-05T00:00:00.000Z')

function settings(defaultBillSplit: 'days' | 'equal') {
  return JSON.stringify({ type: 'house', autoFinalize: false, defaultBillSplit })
}

const HOUSE = {
  $id: 'house1',
  type: 'house',
  name: 'Flat',
  ownerPersonId: 'alice',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  settingsJson: settings('days'),
  archivedAt: null,
} as Groups

// User flow 6: Cara moved in on 1 August.
const MEMBERS = [
  { personId: 'alice', displayName: 'Alice', joinedOn: '2026-01-01', leftOn: null },
  { personId: 'bob', displayName: 'Bob', joinedOn: '2026-01-01', leftOn: null },
  { personId: 'cara', displayName: 'Cara', joinedOn: '2026-08-01', leftOn: null },
] as Members[]

const PERIOD = { periodStart: '2026-07-01', periodEnd: '2026-09-30' }

function bill(extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: 'b1',
    groupId: 'house1',
    kind: 'bill',
    status: 'due',
    date: '2026-10-15',
    dueOn: '2026-10-15',
    description: 'Electricity',
    category: 'electricity',
    totalCents: 27000,
    inputJson: JSON.stringify({ split: { mode: 'days' }, bill: PERIOD }),
    statementId: null,
    voidReason: null,
    createdBy: 'alice',
    ...extra,
  } as Transactions
}

function mockHouse(
  house: Groups = HOUSE,
  role: Members['role'] = 'admin',
  bills: { due?: Transactions[]; paid?: Transactions[]; recurring?: Schedules[] } = {},
) {
  vi.mocked(useGroup).mockReturnValue({ data: house, isError: false } as never)
  vi.mocked(useMyMember).mockReturnValue({ data: { role }, isError: false } as never)
  listRows.mockImplementation((async ({
    tableId,
    queries,
  }: {
    tableId: string
    queries: string[]
  }) => {
    const rows =
      tableId === 'members'
        ? MEMBERS
        : tableId === 'schedules'
          ? (bills.recurring ?? [])
          : queries.includes(Query.equal('status', 'due'))
            ? (bills.due ?? [])
            : (bills.paid ?? [])
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
  return router
}

function view(transaction: Transactions): Result<unknown> {
  return { ok: true, data: { transaction, shares: [], items: [] } }
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

/** Flow 6 step 2: $270 for 1 Jul–30 Sep, due 15 Oct. */
async function fillFlow6() {
  type('Description', 'Electricity')
  type('Category', 'electricity')
  type('Amount (AUD)', '270')
  type('Period starts', '2026-07-01')
  type('Period ends', '2026-09-30')
  type('Due date', '2026-10-15')
}

/** The preview's lines, with the currency's symbol as `$` whatever the locale (`A$`, `$`). */
function previewLines() {
  const section = screen.getByRole('region', { name: 'Each person’s part' })
  return within(section)
    .getAllByRole('listitem')
    .map((item) => item.textContent?.replace(/A?\$/, '$'))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

describe('HouseBillsPage', () => {
  it('lists the house’s bills with their periods, and New bill for the house', async () => {
    mockHouse(HOUSE, 'member', { due: [bill()] })
    renderAt('/bills?groupId=house1')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bills · Flat')
    const link = await screen.findByRole('link', { name: /^Electricity/ })
    expect(link.textContent).toMatch(
      /Due (15 Oct|Oct 15,) 2026 · for (1 Jul|Jul 1,) 2026 – (30 Sep|Sep 30,) 2026/,
    )
    expect(screen.getByRole('link', { name: 'New bill' }).getAttribute('href')).toBe(
      '/bills/new?groupId=house1',
    )
    const queried = listRows.mock.calls
      .map(([params]) => params as unknown as { tableId: string; queries: string[] })
      .filter((params) => params.tableId === 'transactions')
    expect(queried.every((params) => params.queries[0] === Query.equal('groupId', 'house1'))).toBe(
      true,
    )
    // Its recurring bills and expenses too (#403).
    expect(screen.getByRole('link', { name: 'New recurring' }).getAttribute('href')).toBe(
      '/bills/recurring/new?groupId=house1',
    )
    const recurring = within(await screen.findByRole('region', { name: 'Recurring' }))
    expect(await recurring.findByText('None yet.')).toBeTruthy()
  })

  it.each([
    ['a viewer', HOUSE, 'viewer'],
    ['an archived house', { ...HOUSE, archivedAt: '2026-10-01T00:00:00.000Z' }, 'admin'],
  ] as const)('offers no New bill to %s', async (_name, house, role) => {
    mockHouse(house as Groups, role, { due: [bill()] })
    renderAt('/bills?groupId=house1')
    await screen.findByRole('link', { name: /^Electricity/ })
    expect(screen.queryByRole('link', { name: 'New bill' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New recurring' })).toBeNull()
  })

  it('says so for a group that isn’t a house', () => {
    mockHouse({ ...HOUSE, type: 'employer' } as Groups)
    renderAt('/bills?groupId=house1')
    expect(screen.getByRole('alert').textContent).toBe('We couldn’t find that house.')
  })
})

describe('NewHouseBillPage', () => {
  it.each(['UTC', 'Australia/Sydney'])(
    'previews flow 6 by days present and sends it exactly, with the device in %s',
    async (zone) => {
      vi.stubEnv('TZ', zone)
      mockHouse()
      call.mockResolvedValue(view(bill()))
      const router = renderAt('/bills/new?groupId=house1')
      await screen.findByLabelText('Period starts')
      await fillFlow6()
      expect(previewLines()).toEqual([
        'Alice: 92 days, $101.39',
        'Bob: 92 days, $101.39',
        'Cara: 61 days, $67.22',
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
      await waitFor(() => expect(call).toHaveBeenCalled())
      const [fn, method, path, body] = call.mock.calls[0] ?? []
      expect([fn, method, path]).toEqual(['ledger', 'POST', '/transactions'])
      expect(body).toEqual({
        id: expect.any(String),
        groupId: 'house1',
        kind: 'bill',
        date: '2026-10-15',
        description: 'Electricity',
        category: 'electricity',
        totalCents: 27000,
        split: { mode: 'days' },
        bill: { status: 'due', dueOn: '2026-10-15', ...PERIOD },
      })
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(`/bills/${(body as { id: string }).id}`),
      )
    },
  )

  it('sends an already paid bill on its paid date, paid by whoever is picked', async () => {
    // Still the 4th on this device: the default paid date is the house's today, the 5th.
    vi.stubEnv('TZ', 'America/New_York')
    mockHouse()
    call.mockResolvedValue(view(bill({ status: 'posted' })))
    renderAt('/bills/new?groupId=house1')
    await screen.findByLabelText('Period starts')
    await fillFlow6()
    fireEvent.click(screen.getByLabelText('Already paid'))
    // Local today in Sydney, and you, by default.
    expect((screen.getByLabelText('Paid on') as HTMLInputElement).value).toBe('2026-10-05')
    expect((screen.getByLabelText('Paid by') as HTMLSelectElement).value).toBe('alice')
    type('Paid by', 'bob')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      date: '2026-10-05',
      bill: { status: 'paid', ...PERIOD },
      payers: [{ personId: 'bob', cents: 27000 }],
    })
  })

  it('splits by days between only the people ticked, sorted', async () => {
    mockHouse()
    call.mockResolvedValue(view(bill()))
    renderAt('/bills/new?groupId=house1')
    await screen.findByLabelText('Period starts')
    await fillFlow6()
    fireEvent.click(screen.getByLabelText('Only some people, by days present'))
    fireEvent.click(screen.getByLabelText('Cara'))
    fireEvent.click(screen.getByLabelText('Alice'))
    expect(previewLines()).toEqual(['Alice: 92 days, $162.35', 'Cara: 61 days, $107.65'])
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      split: { mode: 'days', personIds: ['alice', 'cara'] },
    })
  })

  it('names no split in a house whose default is equal', async () => {
    mockHouse({ ...HOUSE, settingsJson: settings('equal') } as Groups)
    call.mockResolvedValue(view(bill()))
    renderAt('/bills/new?groupId=house1')
    await screen.findByLabelText('Period starts')
    expect((screen.getByLabelText('Everyone present, equally') as HTMLInputElement).checked).toBe(
      true,
    )
    await fillFlow6()
    expect(previewLines()).toEqual([
      'Alice: 92 days, $90.00',
      'Bob: 92 days, $90.00',
      'Cara: 61 days, $90.00',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(call.mock.calls[0]?.[3]).not.toHaveProperty('split')
  })

  it.each([
    [
      'a period that ends before it starts',
      { 'Period starts': '2026-09-30', 'Period ends': '2026-07-01' },
      'The period can’t end before it starts.',
    ],
    [
      'a period nobody lived there',
      { 'Period starts': '2025-01-01', 'Period ends': '2025-03-31' },
      'Nobody lived here during this period. Check the dates, or the move-in dates on the house page.',
    ],
  ])('refuses %s, and sends nothing', async (_name, fields, message) => {
    mockHouse()
    renderAt('/bills/new?groupId=house1')
    await screen.findByLabelText('Period starts')
    await fillFlow6()
    for (const [label, value] of Object.entries(fields)) type(label, value)
    expect(screen.getByText(message)).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Add bill' })
    expect(save.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(save)
    // Give a submit the time it would take.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(call).not.toHaveBeenCalled()
    // Said once, in the preview's place.
    expect(screen.getAllByText(message)).toHaveLength(1)
  })

  it('shows a refusal from the server inline, and keeps the form and its ID', async () => {
    mockHouse()
    call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Nobody was present during the bill period' },
    })
    renderAt('/bills/new?groupId=house1')
    await screen.findByLabelText('Period starts')
    await fillFlow6()
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Nobody was present/)
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('270')
    call.mockResolvedValueOnce(view(bill()))
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const ids = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(ids[1]).toBe(ids[0])
  })

  it('tells a viewer they can’t add to the house', async () => {
    mockHouse(HOUSE, 'viewer')
    renderAt('/bills/new?groupId=house1')
    expect(
      await screen.findByText('You can see this house’s bills but not add to them.'),
    ).toBeTruthy()
    expect(screen.queryByLabelText('Amount (AUD)')).toBeNull()
  })
})

// A house's recurring bill or expense (#403), made by `createdBy`.
function recurringRow(id: string, extra: Partial<Schedules> = {}): Schedules {
  return {
    $id: id,
    groupId: 'house1',
    kind: 'bill',
    description: 'Internet',
    templateJson: JSON.stringify({ totalCents: 8000, bill: { status: 'due' } }),
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    startsOn: '2026-10-05',
    endsOn: null,
    exdates: [],
    skipPublicHolidays: false,
    autoPost: false,
    createdBy: 'alice',
    ...extra,
  } as unknown as Schedules
}

describe('NewRecurringBillPage in a house (#403)', () => {
  const sent = () => call.mock.calls[0]?.[3] as Record<string, unknown>
  const saved = { ok: true, data: { schedule: recurringRow('s9') } } as Result<unknown>

  it('sends a bill paid by the caller and split between everyone living there on each date, then shows the house’s bills', async () => {
    mockHouse(HOUSE, 'member')
    call.mockResolvedValue(saved)
    const router = renderAt('/bills/recurring/new?groupId=house1')
    const paidBy = (await screen.findByLabelText('Paid by')) as HTMLSelectElement
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'New recurring bill or expense · Flat',
    )
    expect(paidBy.value).toBe('alice')
    type('Description', 'Internet')
    type('Amount (AUD)', '80')
    type('Day of the month', '15')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['scheduler', 'POST', '/schedules'])
    // No split: each one is split between everyone living there on its date.
    expect(sent()).toEqual({
      id: expect.any(String),
      groupId: 'house1',
      kind: 'bill',
      description: 'Internet',
      template: {
        totalCents: 8000,
        bill: { status: 'due' },
        payers: [{ personId: 'alice', cents: 8000 }],
      },
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
      startsOn: '2026-10-05',
      skipPublicHolidays: false,
      autoPost: false,
    })
    await waitFor(() => expect(router.state.location.search).toBe('?groupId=house1'))
    expect(router.state.location.pathname).toBe('/bills')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Bills · Flat'))
  })

  it('sends an expense that posts itself, paid by someone else and split between the people ticked', async () => {
    mockHouse(HOUSE, 'admin')
    call.mockResolvedValue(saved)
    renderAt('/bills/recurring/new?groupId=house1')
    fireEvent.click(await screen.findByLabelText(/^An expense/))
    // An expense always posts itself, as nothing else would post it.
    expect(screen.queryByLabelText(/Autopay/)).toBeNull()
    type('Description', 'Cleaner')
    type('Amount (AUD)', '100')
    type('Paid by', 'bob')
    fireEvent.click(screen.getByLabelText('Only the people I tick'))
    // Everyone living there on the first date is ticked to start with.
    const ticks = within(screen.getByRole('group', { name: 'Who it’s split between' }))
    expect(
      ticks.getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).checked),
    ).toHaveLength(3)
    fireEvent.click(ticks.getByLabelText('Bob'))
    fireEvent.click(screen.getByLabelText('Every week'))
    type('Day of the week', 'FR')
    // Not in the past: those would never be posted.
    type('First date', '2026-10-04')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring expense' }))
    expect(await screen.findByText(/^Pick a date from (5 Oct|Oct 5,) 2026 on$/)).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    type('First date', '2026-10-05')
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring expense' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sent()).toMatchObject({
      kind: 'expense',
      description: 'Cleaner',
      template: {
        totalCents: 10000,
        payers: [{ personId: 'bob', cents: 10000 }],
        split: { mode: 'equal', personIds: ['alice', 'cara'] },
      },
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
      startsOn: '2026-10-05',
      autoPost: true,
    })
    expect(sent().template).not.toHaveProperty('bill')
  })

  it('refuses a split between nobody, sending nothing', async () => {
    mockHouse(HOUSE, 'member')
    renderAt('/bills/recurring/new?groupId=house1')
    await screen.findByLabelText('Description')
    type('Description', 'Internet')
    type('Amount (AUD)', '80')
    fireEvent.click(screen.getByLabelText('Only the people I tick'))
    for (const name of ['Alice', 'Bob', 'Cara']) fireEvent.click(screen.getByLabelText(name))
    fireEvent.click(screen.getByRole('button', { name: 'Add recurring bill' }))
    expect(await screen.findByText('Tick at least one person')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['a viewer', HOUSE, 'viewer', 'You can see this house’s bills but not add to them.'],
    [
      'an archived house',
      { ...HOUSE, archivedAt: '2026-10-01T00:00:00.000Z' },
      'admin',
      ARCHIVED_NOTICE,
    ],
  ] as const)('has no form for %s', async (_name, house, role, message) => {
    mockHouse(house as Groups, role)
    renderAt('/bills/recurring/new?groupId=house1')
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Add recurring/ })).toBeNull()
  })
})

describe('HouseBillsPage: recurring (#403)', () => {
  const ROWS = [
    recurringRow('s1'),
    recurringRow('s2', {
      kind: 'expense',
      description: 'Cleaner',
      templateJson: JSON.stringify({ totalCents: 10000 }),
      autoPost: true,
      createdBy: 'bob',
    }),
  ]
  const items = async () =>
    (
      await within(await screen.findByRole('region', { name: 'Recurring' })).findAllByRole(
        'listitem',
      )
    ).map((item) => item.textContent)

  it('lists its bills and expenses, and offers Stop to a member only on their own', async () => {
    mockHouse(HOUSE, 'member', { recurring: ROWS })
    renderAt('/bills?groupId=house1')
    expect(await items()).toEqual([
      expect.stringMatching(/^InternetEvery Monday · A?\$80\.00Stop$/),
      // An expense always posts itself: it isn't called autopay.
      expect.stringMatching(/^CleanerExpense · Every Monday · A?\$100\.00$/),
    ])
    cleanup()
    mockHouse(HOUSE, 'viewer', { recurring: ROWS })
    renderAt('/bills?groupId=house1')
    expect(await items()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
  })

  it('lets an admin stop anyone’s recurring expense, in an expense’s words', async () => {
    mockHouse(HOUSE, 'admin', { recurring: ROWS })
    call.mockResolvedValue({
      ok: true,
      data: { schedule: { ...ROWS[1], endsOn: '2026-10-05' } },
    } as Result<unknown>)
    renderAt('/bills?groupId=house1')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Cleaner' }))
    expect(
      screen.getByText(
        'Stop Cleaner from today? Nothing more is added after today. What was added already stays.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }))
    expect(await screen.findByText('Stopped Cleaner. What was added already stays.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('scheduler', 'POST', '/schedules/s2/end', {
      endsOn: '2026-10-05',
    })
    expect(document.activeElement?.textContent).toBe('Bills · Flat')
  })
})

describe('BillPage in a house', () => {
  it('marks flow 6’s bill paid on 10 Oct by Alice, with her as the payer', async () => {
    mockHouse()
    getRow.mockResolvedValue(bill() as never)
    call.mockResolvedValue(view(bill({ status: 'posted', date: '2026-10-10' })))
    renderAt('/bills/b1')
    await screen.findByLabelText('Paid by')
    expect((screen.getByLabelText('Paid by') as HTMLSelectElement).value).toBe('alice')
    type('Paid on', '2026-10-10')
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(call.mock.calls[0]).toEqual([
      'ledger',
      'POST',
      '/transactions/b1/post',
      { date: '2026-10-10', payers: [{ personId: 'alice', cents: 27000 }] },
    ])
  })

  it('shows the bill’s period', async () => {
    mockHouse()
    getRow.mockResolvedValue(bill() as never)
    renderAt('/bills/b1')
    const period = await screen.findByText('Period')
    expect(period.nextElementSibling?.textContent).toMatch(
      /(1 Jul|Jul 1,) 2026 – (30 Sep|Sep 30,) 2026/,
    )
  })

  it.each<[string, Members['role'], Partial<Transactions>, Partial<Groups>, boolean]>([
    ['an admin', 'admin', { createdBy: 'bob' }, {}, true],
    ['its creator', 'member', {}, {}, true],
    ['another member', 'member', { createdBy: 'bob' }, {}, false],
    ['a viewer', 'viewer', {}, {}, false],
    ['a locked bill', 'admin', { statementId: 's1' }, {}, false],
    ['an archived house', 'admin', {}, { archivedAt: '2026-10-01T00:00:00.000Z' }, false],
  ])('offers the actions to %s: %s', async (_name, role, row, house, shown) => {
    mockHouse({ ...HOUSE, ...house } as Groups, role)
    getRow.mockResolvedValue(bill(row) as never)
    renderAt('/bills/b1')
    await screen.findByText('Period')
    if (shown) await screen.findByRole('button', { name: 'Mark paid' })
    // Long enough for the caller's role and the members to arrive.
    else await new Promise((resolve) => setTimeout(resolve, 20))
    for (const name of ['Mark paid', 'Change this bill', 'Skip this bill']) {
      expect(Boolean(screen.queryByRole('button', { name }))).toBe(shown)
    }
  })

  it('changes a due bill’s amount, period and split, and keeps who paid', async () => {
    mockHouse()
    const payers = [{ personId: 'bob', cents: 27000 }]
    const stored = bill({
      inputJson: JSON.stringify({ payers, split: { mode: 'days' }, note: 'Q3', bill: PERIOD }),
    })
    getRow.mockResolvedValue(stored as never)
    call.mockResolvedValue(view(stored))
    renderAt('/bills/b1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change this bill' }))
    expect(document.activeElement?.textContent).toBe('Change this bill')
    expect((screen.getByLabelText('Period starts') as HTMLInputElement).value).toBe('2026-07-01')
    type('Amount (AUD)', '280')
    type('Period ends', '2026-08-31')
    fireEvent.click(screen.getByLabelText('Only some people, by days present'))
    fireEvent.click(screen.getByLabelText('Bob'))
    fireEvent.click(screen.getByLabelText('Alice'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'PATCH', '/transactions/b1'])
    expect(call.mock.calls[0]?.[3]).toEqual({
      id: 'b1',
      groupId: 'house1',
      kind: 'bill',
      date: '2026-10-15',
      description: 'Electricity',
      category: 'electricity',
      totalCents: 28000,
      note: 'Q3',
      // Bob paid it before, and pays the new amount: never the editor.
      payers: [{ personId: 'bob', cents: 28000 }],
      split: { mode: 'days', personIds: ['alice', 'bob'] },
      bill: {
        status: 'due',
        dueOn: '2026-10-15',
        periodStart: '2026-07-01',
        periodEnd: '2026-08-31',
      },
    })
  })
})
