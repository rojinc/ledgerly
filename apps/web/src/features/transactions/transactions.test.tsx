import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { Query } from 'appwrite'
import type { ReactNode } from 'react'
import { createMemoryRouter } from 'react-router'
// The app's, from main.tsx, whose navigations can flushSync.
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { staleKeys } from '../../lib/realtime'
import { useBalances, useGroup, useGroups, useMyMember } from '../groups/use-groups'
import { transactionRoutes } from './routes'
import { useVoidTransaction } from './use-transactions'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
  // lib/realtime registers its reconnect listener on import.
  realtime: { onOpen: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
// The viewer's person: the worker by default; tests switch to the employer, or to not loaded.
let mockPersonId = 'pw'
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: mockPersonId ? { personId: mockPersonId } : undefined }),
}))
vi.mock('../groups/use-groups', () => ({
  useGroups: vi.fn(),
  useGroup: vi.fn(),
  useMyMember: vi.fn(),
  useBalances: vi.fn(),
}))

const listRows = vi.mocked(tablesDB.listRows)
const getRow = vi.mocked(tablesDB.getRow)
const call = vi.mocked(callFunction)

// "Now" in every test: 2026-10-18 evening in Sydney.
const NOW = new Date('2026-10-18T09:00:00.000Z')

const acme = {
  $id: 'g1',
  type: 'employer',
  name: 'Acme',
  ownerPersonId: 'pw',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

const MEMBERS = [
  { $id: 'm1', groupId: 'g1', personId: 'pw', displayName: 'Sam', role: 'admin' },
  { $id: 'm2', groupId: 'g1', personId: 'pe', displayName: 'Acme', role: 'viewer' },
] as Members[]

function row(id: string, extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'expense',
    status: 'posted',
    date: '2026-10-18',
    description: 'Supplies',
    category: 'work',
    totalCents: 4000,
    inputJson: JSON.stringify({ note: 'From the hardware shop' }),
    statementId: null,
    voidReason: null,
    createdBy: 'pw',
    ...extra,
  } as Transactions
}

function mockGroups(group: Groups, role: Members['role'] = 'admin', net = 0) {
  vi.mocked(useGroups).mockReturnValue({ data: [group], isError: false } as never)
  vi.mocked(useGroup).mockReturnValue({ data: group, isError: false } as never)
  vi.mocked(useMyMember).mockReturnValue({ data: { role }, isError: false } as never)
  vi.mocked(useBalances).mockReturnValue({
    data: {
      people: [
        { personId: 'pw', netCents: net },
        { personId: 'pe', netCents: -net },
      ],
      transfers: [],
    },
    isError: false,
  } as never)
}

/**
 * listRows answers members with `members`, shares with `shares`, items with `items` and
 * transactions with `history`.
 */
function mockRows(
  history: Transactions[] = [],
  shares: object[] = [],
  members = MEMBERS,
  items: object[] = [],
) {
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    const rows =
      tableId === 'members'
        ? members
        : tableId === 'shares'
          ? shares
          : tableId === 'items'
            ? items
            : history
    return { total: rows.length, rows }
  }) as never)
}

/** listRows' parameters, call by call. */
function listCalls() {
  return listRows.mock.calls.map(
    ([params]) => params as unknown as { tableId: string; queries: string[] },
  )
}

function renderAt(path: string) {
  const router = createMemoryRouter([transactionRoutes, { path: '*', element: null }], {
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

beforeEach(() => {
  mockPersonId = 'pw'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('NewTransactionPage', () => {
  it.each([
    ['I paid for them (reimbursable)', 'pw', 'pe'],
    ['Bought on their card, for work', 'pe', 'pe'],
    ['Personal, on their card / cash advance', 'pe', 'pw'],
  ])('sends “%s” as the documented expense', async (label, payer, forWhom) => {
    mockGroups(acme)
    mockRows()
    call.mockResolvedValue(ok({ transaction: row('x1'), shares: [] }))
    const { router } = renderAt('/transactions/new?groupId=g1')
    fireEvent.click(await screen.findByLabelText(new RegExp(label.replace(/[()/]/g, '.'))))
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Supplies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'POST', '/transactions'])
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      groupId: 'g1',
      kind: 'expense',
      // Local today in the group's zone (Sydney is already the 18th's evening).
      date: '2026-10-18',
      description: 'Supplies',
      totalCents: 4000,
      category: 'work',
      payers: [{ personId: payer, cents: 4000 }],
      split: { mode: 'equal', personIds: [forWhom] },
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/transactions/x1'))
  })

  it('sends a payment received from the employer to the worker, with no category', async () => {
    mockGroups(acme)
    mockRows()
    call.mockResolvedValue(ok({ transaction: row('x2', { kind: 'payment' }), shares: [] }))
    renderAt('/transactions/new?groupId=g1')
    fireEvent.click(await screen.findByLabelText(/Payment received/))
    expect(screen.queryByLabelText('Category')).toBeNull()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'October pay' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as Record<string, unknown>
    expect(body).toMatchObject({
      kind: 'payment',
      totalCents: 50000,
      payment: { fromPersonId: 'pe', toPersonId: 'pw' },
    })
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('payers')
  })

  it('refuses an amount that isn’t one, or isn’t above 0, before sending', async () => {
    mockGroups(acme)
    mockRows()
    renderAt('/transactions/new?groupId=g1')
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '4.005' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Supplies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Enter an amount like 40.50')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Enter an amount above 0')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps one ID per visit, so a retry after an error can’t add it twice', async () => {
    mockGroups(acme)
    mockRows()
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    call.mockReturnValueOnce(new Promise(() => {}))
    renderAt('/transactions/new?groupId=g1')
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Supplies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const [first, second] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).toBe(first)
  })

  it('warns of a possible duplicate when a retry with changed content gets CONFLICT', async () => {
    mockGroups(acme)
    mockRows()
    // The first try was saved, but its answer was lost; the retry, changed, conflicts.
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CONFLICT', message: 'A different transaction already has this ID.' },
    })
    renderAt('/transactions/new?groupId=g1')
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Supplies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again.')
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This may already have been saved from your last try. Check History before adding it again.',
      ),
    )
  })

  it('shows ARCHIVED from an old tab in plain words', async () => {
    mockGroups(acme)
    mockRows()
    call.mockResolvedValue({ ok: false, error: { code: 'ARCHIVED', message: 'Group is archived' } })
    renderAt('/transactions/new?groupId=g1')
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Supplies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^This group has been archived, so it can’t be changed any more/,
    )
  })

  it('has no form for an admin who isn’t the group’s owner (the presets speak as the worker)', async () => {
    mockGroups({ ...acme, ownerPersonId: 'pe' })
    mockRows()
    renderAt('/transactions/new?groupId=g1')
    expect(
      await screen.findByText('Only the person this group pays adds expenses and payments here.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  it('tells the owner who can now only view the group that they can’t add', async () => {
    mockGroups(acme, 'viewer')
    mockRows()
    renderAt('/transactions/new?groupId=g1')
    expect(
      await screen.findByText('You can see this group’s history but no longer add to it.'),
    ).toBeTruthy()
  })

  it('gives an amount example in the group’s currency', async () => {
    mockGroups({ ...acme, currency: 'JPY' })
    mockRows()
    renderAt('/transactions/new?groupId=g1')
    expect(await screen.findByText('For example 4050.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount (JPY)'), { target: { value: '40.5' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Supplies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Enter an amount like 4050')).toBeTruthy()
    // Three decimals for a currency like KWD.
    cleanup()
    mockGroups({ ...acme, currency: 'KWD' })
    renderAt('/transactions/new?groupId=g1')
    expect(await screen.findByText('For example 4.050.')).toBeTruthy()
  })

  it('has no form for a viewer or an archived group', async () => {
    mockGroups(acme, 'viewer')
    mockRows()
    renderAt('/transactions/new?groupId=g1')
    expect(
      await screen.findByText('You can see this group’s history but no longer add to it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    cleanup()
    mockGroups({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/transactions/new?groupId=g1')
    expect(
      await screen.findByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })
})

// A house in Sydney (#180). Dan moved out on 2026-09-30; Erin moves in on the 19th.
const house = {
  $id: 'house1',
  type: 'house',
  name: 'The flat',
  ownerPersonId: 'cara',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

function housemate(personId: string, displayName: string, joinedOn: string, leftOn?: string) {
  const role = leftOn ? 'viewer' : 'member'
  return {
    $id: `m-${personId}`,
    groupId: 'house1',
    personId,
    displayName,
    role,
    joinedOn,
    leftOn: leftOn ?? null,
  } as Members
}

const HOUSEMATES = [
  housemate('cara', 'Cara', '2026-01-01'),
  housemate('alice', 'Alice', '2026-01-01'),
  housemate('bob', 'Bob', '2026-01-01'),
  housemate('dan', 'Dan', '2026-01-01', '2026-09-30'),
]

// 01:30 on the 19th in Sydney, still the 18th in UTC.
const HOUSE_NOW = new Date('2026-10-18T14:30:00Z')

describe('NewTransactionPage, house expense', () => {
  beforeEach(() => {
    mockPersonId = 'alice'
    vi.setSystemTime(HOUSE_NOW)
  })

  /** Opens the form and fills in a valid expense, with the default ticks. */
  async function open(members = HOUSEMATES, role: Members['role'] = 'member') {
    mockGroups(house, role)
    mockRows([], [], members)
    const view = renderAt('/transactions/new?groupId=house1')
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Groceries' } })
    return view
  }

  const ticked = () =>
    screen
      .getAllByRole('checkbox')
      .filter((box) => (box as HTMLInputElement).checked)
      .map((box) => (box as HTMLInputElement).value)

  it('sends who paid and who it’s split between, then opens the expense', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9', { groupId: 'house1' }), shares: [] }))
    const { router } = await open()
    expect(screen.getByRole('heading', { name: 'Add expense' })).toBeTruthy()
    // The owner check is the employer's only: Cara owns this house, Alice adds.
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-19')
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('Paid by') as HTMLSelectElement).value).toBe('alice')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'groceries' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'POST', '/transactions'])
    expect(call.mock.calls[0]?.[3]).toEqual({
      id: expect.any(String),
      groupId: 'house1',
      kind: 'expense',
      date: '2026-10-19',
      description: 'Groceries',
      category: 'groceries',
      totalCents: 9000,
      payers: [{ personId: 'alice', cents: 9000 }],
      split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/transactions/x9'))
  })

  it('sends another payer, the people ticked in personId order, and a two-line note', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Paid by'), { target: { value: 'bob' } })
    fireEvent.click(screen.getByLabelText('Bob'))
    // A textarea, so Enter starts a new line (#502).
    expect(screen.getByLabelText('Note (optional)').tagName).toBe('TEXTAREA')
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Market\nstall 4' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as Record<string, unknown>
    expect(body).toMatchObject({
      payers: [{ personId: 'bob', cents: 4000 }],
      split: { mode: 'equal', personIds: ['alice', 'cara'] },
      note: 'Market\nstall 4',
    })
    expect(body).not.toHaveProperty('category')
  })

  it('previews each part from core, with the leftover cent on the first personId', async () => {
    await open()
    const preview = await screen.findByRole('region', { name: 'Each person’s part' })
    expect(within(preview).getByText(/^Alice: paid .*90\.00, share .*30\.00$/)).toBeTruthy()
    expect(within(preview).getByText(/^Bob: share .*30\.00$/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '100' } })
    expect(within(preview).getByText(/^Alice: paid .*100\.00, share .*33\.34$/)).toBeTruthy()
    expect(within(preview).getByText(/^Bob: share .*33\.33$/)).toBeTruthy()
    expect(within(preview).getByText(/^Cara: share .*33\.33$/)).toBeTruthy()
    // A payer who isn't ticked only paid.
    fireEvent.click(screen.getByLabelText('Alice'))
    expect(within(preview).getByText(/^Alice: paid .*100\.00$/)).toBeTruthy()
    expect(within(preview).getByText(/^Bob: share .*50\.00$/)).toBeTruthy()
  })

  it('ticks those living there on the date, until a tick is changed by hand', async () => {
    await open()
    expect(ticked()).toEqual(['cara', 'alice', 'bob'].sort((a, b) => a.localeCompare(b)))
    const dan = screen.getByLabelText(/^Dan/) as HTMLInputElement
    // The line is part of the label, so it isn't read a second time as a description.
    expect(dan.getAttribute('aria-describedby')).toBeNull()
    expect(screen.getByLabelText(/^Dan.*not living here on this date$/)).toBe(dan)
    expect(screen.getByText('not living here on this date')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-15' } })
    await waitFor(() => expect(dan.checked).toBe(true))
    expect(screen.queryByText('not living here on this date')).toBeNull()
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-19' } })
    await waitFor(() => expect(dan.checked).toBe(false))
    // Ticked by hand: he's sent, and the date no longer moves the ticks.
    fireEvent.click(dan)
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-20' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-19' } })
    expect(dan.checked).toBe(true)
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      split: { personIds: ['alice', 'bob', 'cara', 'dan'] },
    })
  })

  it('ticks someone moving in on today’s date (local today, not UTC)', async () => {
    await open([...HOUSEMATES, housemate('erin', 'Erin', '2026-10-19')])
    expect((screen.getByLabelText(/^Erin/) as HTMLInputElement).checked).toBe(true)
  })

  it.each([
    ['', 'Groceries', 'Required'],
    ['lots', 'Groceries', 'Enter an amount like 40.50'],
    ['0', 'Groceries', 'Enter an amount above 0'],
    ['90', '', 'Required'],
  ])(
    'refuses amount “%s”, description “%s” before sending',
    async (amount, description, message) => {
      await open()
      fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: amount } })
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      const field = screen.getByLabelText(amount === '90' ? 'Description' : 'Amount (AUD)')
      await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
      expect(screen.getByText(message)).toBeTruthy()
      expect(call).not.toHaveBeenCalled()
    },
  )

  it('refuses a split between nobody, or more than 15 people', async () => {
    const many = Array.from({ length: 16 }, (_, n) =>
      housemate(`p${String(n).padStart(2, '0')}`, `Person ${n}`, '2026-01-01'),
    )
    await open([housemate('alice', 'Alice', '2026-01-01'), ...many])
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('At most 15 people can be in one expense.')).toBeTruthy()
    for (const box of screen.getAllByRole('checkbox')) {
      if ((box as HTMLInputElement).checked) fireEvent.click(box)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const message = await screen.findByText('Tick at least one person to split it between.')
    expect(
      screen.getByRole('group', { name: 'Split equally between' }).getAttribute('aria-describedby'),
    ).toBe(message.id)
    expect(call).not.toHaveBeenCalled()
  })

  it('allows 15 people, payer included, and refuses a 16th', async () => {
    const others = Array.from({ length: 15 }, (_, n) =>
      housemate(`p${String(n).padStart(2, '0')}`, `Person ${n}`, '2026-01-01'),
    )
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open([housemate('alice', 'Alice', '2026-01-01'), ...others])
    // Alice pays but isn't in the split: still 16 people.
    fireEvent.click(screen.getByLabelText('Alice'))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('At most 15 people can be in one expense.')).toBeTruthy()
    // Said once: the preview doesn't add core's wording of the same rule.
    expect(screen.queryByRole('region', { name: 'Each person’s part' })).toBeNull()
    expect(screen.queryByText(/per transaction/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Person 0'))
    expect(await screen.findByRole('region', { name: 'Each person’s part' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as { split: { personIds: string[] } } | undefined
    expect(body?.split.personIds).toHaveLength(14)
  })

  it('sends a list for a house of one', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open([housemate('alice', 'Alice', '2026-01-01')])
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      split: { mode: 'equal', personIds: ['alice'] },
    })
  })

  it('offers everyone as the payer, and the ticks still follow the date after a payer change', async () => {
    await open()
    const payer = screen.getByLabelText('Paid by')
    expect(
      within(payer)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Alice', 'Bob', 'Cara', 'Dan'])
    fireEvent.change(payer, { target: { value: 'dan' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-15' } })
    await waitFor(() =>
      expect((screen.getByLabelText(/^Dan/) as HTMLInputElement).checked).toBe(true),
    )
  })

  it('ties the empty-split error to each box, and clears it once the date ticks someone', async () => {
    // Everyone moves in tomorrow, so today ticks nobody.
    await open([housemate('alice', 'Alice', '2026-10-20'), housemate('bob', 'Bob', '2026-10-20')])
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const message = await screen.findByText('Tick at least one person to split it between.')
    const alice = screen.getByLabelText(/^Alice/)
    expect(alice.getAttribute('aria-invalid')).toBe('true')
    expect(alice.getAttribute('aria-describedby')).toBe(message.id)
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-20' } })
    await waitFor(() =>
      expect(screen.queryByText('Tick at least one person to split it between.')).toBeNull(),
    )
    expect(alice.getAttribute('aria-invalid')).toBe('false')
    expect(call).not.toHaveBeenCalled()
  })

  it('shows the ledger’s own refusal from core, and sends nothing', async () => {
    // The viewer's member row is missing from the list (removed meanwhile), so they can't pay.
    mockPersonId = 'zed'
    await open()
    expect(
      (await screen.findAllByText('Only members of the group can be in a transaction')).length,
    ).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only members of the group can be in a transaction',
    )
    // Shown above the form now, so the preview no longer repeats it.
    expect(screen.getAllByText('Only members of the group can be in a transaction')).toHaveLength(1)
    expect(call).not.toHaveBeenCalled()
  })

  it('shows a server refusal and keeps the ID for the retry', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Only members of the group can be in a transaction',
      },
    })
    call.mockReturnValueOnce(new Promise(() => {}))
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only members of the group can be in a transaction',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const [first, second] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).toBe(first)
  })

  it('warns of a possible duplicate on CONFLICT', async () => {
    call.mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'Taken.' } })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This may already have been saved from your last try. Check the calendar before adding it again.',
    )
  })

  it('sends what several people paid, and refuses amounts that don’t add up', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open()
    fireEvent.click(screen.getByLabelText('Several people paid'))
    expect(screen.queryByLabelText('Paid by')).toBeNull()
    fireEvent.change(screen.getByLabelText('Alice paid (AUD)'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('Bob paid (AUD)'), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const message = await screen.findByText(
      /^The amounts paid add up to A?\$85\.00, but the total is A?\$90\.00\.$/,
    )
    expect(
      screen
        .getByRole('group', { name: 'How much each person paid' })
        .getAttribute('aria-describedby'),
    ).toBe(message.id)
    // The message is an alert, and focus goes to the first amount.
    expect(message.getAttribute('role')).toBe('alert')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Alice paid (AUD)')),
    )
    expect(call).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Alice paid (AUD)'), { target: { value: '50' } })
    // Fixed: the message goes as the amounts change, not at the next Add.
    await waitFor(() => expect(screen.queryByText(/^The amounts paid add up to/)).toBeNull())
    const preview = await screen.findByRole('region', { name: 'Each person’s part' })
    expect(within(preview).getByText(/^Alice: paid .*50\.00, share .*30\.00$/)).toBeTruthy()
    expect(within(preview).getByText(/^Bob: paid .*40\.00, share .*30\.00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      totalCents: 9000,
      payers: [
        { personId: 'alice', cents: 5000 },
        { personId: 'bob', cents: 4000 },
      ],
      split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
    })
  })

  it('splits by amounts, refusing ones that don’t match the total', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '60' } })
    fireEvent.click(screen.getByLabelText('By amounts'))
    expect(screen.getByRole('group', { name: 'Split between' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cara' }))
    fireEvent.change(screen.getByLabelText('Alice’s amount (AUD)'), { target: { value: '25' } })
    expect(screen.queryByLabelText('Cara’s amount (AUD)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Bob’s amount (AUD)'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(
      await screen.findByText(/^The amounts add up to A?\$55\.00, but the total is A?\$60\.00\.$/),
    ).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Bob’s amount (AUD)'), { target: { value: '35' } })
    await waitFor(() => expect(screen.queryByText(/^The amounts add up to/)).toBeNull())
    const preview = await screen.findByRole('region', { name: 'Each person’s part' })
    expect(within(preview).getByText(/^Bob: share .*35\.00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      split: {
        mode: 'exact',
        amounts: [
          { personId: 'alice', cents: 2500 },
          { personId: 'bob', cents: 3500 },
        ],
      },
    })
  })

  it('splits by percentages, which must add up to 100%', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open()
    fireEvent.click(screen.getByLabelText('By percentages'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cara' }))
    fireEvent.change(screen.getByLabelText('Alice’s percentage'), { target: { value: '66.66' } })
    fireEvent.change(screen.getByLabelText('Bob’s percentage'), { target: { value: '33.333' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Enter a percentage like 33.33')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Bob’s percentage'), { target: { value: '33.33' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('The percentages add up to 99.99%, not 100%.')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Alice’s percentage'), { target: { value: '66.67' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      split: {
        mode: 'percent',
        percents: [
          { personId: 'alice', basisPoints: 6667 },
          { personId: 'bob', basisPoints: 3333 },
        ],
      },
    })
  })

  it('starts a new split mode with empty parts', async () => {
    await open()
    fireEvent.click(screen.getByLabelText('By amounts'))
    fireEvent.change(screen.getByLabelText('Alice’s amount (AUD)'), { target: { value: '60' } })
    fireEvent.click(screen.getByLabelText('By percentages'))
    await waitFor(() =>
      expect((screen.getByLabelText('Alice’s percentage') as HTMLInputElement).value).toBe(''),
    )
  })

  it('counts everyone named against the 15-person limit, in any split mode', async () => {
    const others = Array.from({ length: 15 }, (_, n) =>
      housemate(`p${String(n).padStart(2, '0')}`, `Person ${n}`, '2026-01-01'),
    )
    await open([housemate('alice', 'Alice', '2026-01-01'), ...others])
    fireEvent.click(screen.getByLabelText('By shares'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alice' }))
    for (const person of others) {
      fireEvent.change(screen.getByLabelText(`${person.displayName}’s shares`), {
        target: { value: '1' },
      })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('At most 15 people can be in one expense.')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('splits by shares, previewed by core', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await open()
    fireEvent.click(screen.getByLabelText('By shares'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cara' }))
    fireEvent.change(screen.getByLabelText('Alice’s shares'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Bob’s shares'), { target: { value: '1' } })
    const preview = await screen.findByRole('region', { name: 'Each person’s part' })
    expect(within(preview).getByText(/^Alice: paid .*90\.00, share .*60\.00$/)).toBeTruthy()
    expect(within(preview).getByText(/^Bob: share .*30\.00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      split: {
        mode: 'weights',
        weights: [
          { personId: 'alice', weight: 2 },
          { personId: 'bob', weight: 1 },
        ],
      },
    })
  })

  it('clears a refusal shown above the form once the form changes', async () => {
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again.')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('asks to pick a group when the link names none it knows', async () => {
    mockGroups(house)
    mockRows([], [], HOUSEMATES)
    renderAt('/transactions/new?groupId=nope')
    expect(await screen.findByText(/^Pick an employer or a house from/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Groups' }).getAttribute('href')).toBe('/groups')
  })

  it('has no form for a viewer or in an archived house', async () => {
    mockGroups(house, 'viewer')
    mockRows([], [], HOUSEMATES)
    renderAt('/transactions/new?groupId=house1')
    expect(
      await screen.findByText('You can see this house’s history but no longer add to it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    cleanup()
    mockGroups({ ...house, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/transactions/new?groupId=house1')
    expect(
      await screen.findByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })
})

describe('NewTransactionPage, itemised receipt (#42)', () => {
  beforeEach(() => {
    mockPersonId = 'alice'
    vi.setSystemTime(HOUSE_NOW)
  })

  /** Opens the house form, names the receipt and switches it to items. */
  async function itemise() {
    mockGroups(house)
    mockRows([], [], HOUSEMATES)
    const view = renderAt('/transactions/new?groupId=house1')
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Groceries' } })
    fireEvent.click(screen.getByLabelText('Itemise this receipt'))
    return view
  }

  /** Fills item `number` (from 1), adding it first unless it's the first. */
  function fillItem(number: number, name: string, amount: string) {
    if (number > 1) fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    fireEvent.change(screen.getByLabelText(`Item ${number} name`), { target: { value: name } })
    fireEvent.change(screen.getByLabelText(`Item ${number} amount (AUD)`), {
      target: { value: amount },
    })
  }

  const whoFor = (number: number) =>
    screen.getByRole('group', { name: `Who item ${number} is for` })

  it('sends user flow 7’s receipt item by item, with core’s preview', async () => {
    const stored = [{ $id: 'i0', position: 0 }]
    call.mockResolvedValue(
      ok({ transaction: row('x9', { groupId: 'house1' }), shares: [], items: stored }),
    )
    const { router, queryClient } = await itemise()
    expect(screen.queryByLabelText('Amount (AUD)')).toBeNull()
    expect(screen.queryByRole('group', { name: 'How to split it' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Who’s sharing this receipt' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'groceries' } })
    fireEvent.change(screen.getByLabelText('Paid by'), { target: { value: 'bob' } })
    fillItem(1, 'Milk', '4.00')
    fillItem(2, 'Bread', '5.00')
    fillItem(3, 'Beer', '20.00')
    fireEvent.click(within(whoFor(3)).getByLabelText('Alice'))
    fireEvent.click(within(whoFor(3)).getByLabelText('Cara'))
    fillItem(4, 'Discount', '2.00')
    fireEvent.click(screen.getByLabelText('Item 4 is a discount'))
    expect(screen.getByText(/^Total: .*27\.00$/)).toBeTruthy()
    expect(screen.getByLabelText('Item 4 amount (AUD)').getAttribute('aria-describedby')).toBe(
      'item-3-amount-hint',
    )
    expect(
      screen.getByText('For example 40.50. A minus sign makes it a discount.', {
        selector: '#item-3-amount-hint',
      }),
    ).toBeTruthy()
    const preview = screen.getByRole('region', { name: 'Each person’s part' })
    expect(within(preview).getByText(/^Alice: share .*2\.34$/)).toBeTruthy()
    expect(within(preview).getByText(/^Bob: paid .*27\.00, share .*22\.33$/)).toBeTruthy()
    expect(within(preview).getByText(/^Cara: share .*2\.33$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const everyone = ['alice', 'bob', 'cara']
    expect(call.mock.calls[0]?.[3]).toEqual({
      id: expect.any(String),
      groupId: 'house1',
      kind: 'expense',
      date: '2026-10-19',
      description: 'Groceries',
      category: 'groceries',
      payers: [{ personId: 'bob', cents: 2700 }],
      items: [
        { name: 'Milk', amountCents: 400, split: { mode: 'equal', personIds: everyone } },
        { name: 'Bread', amountCents: 500, split: { mode: 'equal', personIds: everyone } },
        { name: 'Beer', amountCents: 2000, split: { mode: 'equal', personIds: ['bob'] } },
        { name: 'Discount', amountCents: -200, split: { mode: 'equal', personIds: everyone } },
      ],
    })
    // The answer's items are kept: the expense opens without reading them again.
    await waitFor(() => expect(router.state.location.pathname).toBe('/transactions/x9'))
    expect(queryClient.getQueryData(['transaction', 'x9', 'items'])).toBe(stored)
  })

  it('splits an item by shares, with its own category', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await itemise()
    fillItem(1, 'Wine', '30')
    fireEvent.change(screen.getByLabelText('Item 1 category'), { target: { value: 'household' } })
    fireEvent.click(screen.getByRole('radio', { name: 'By shares' }))
    fireEvent.click(within(whoFor(1)).getByLabelText('Cara'))
    fireEvent.change(screen.getByLabelText('Alice’s shares of item 1'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Bob’s shares of item 1'), { target: { value: '1' } })
    expect(screen.queryByLabelText('Cara’s shares of item 1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as { items: unknown } | undefined
    expect(body?.items).toEqual([
      {
        name: 'Wine',
        amountCents: 3000,
        category: 'household',
        split: {
          mode: 'weights',
          weights: [
            { personId: 'alice', weight: 2 },
            { personId: 'bob', weight: 1 },
          ],
        },
      },
    ])
  })

  it('refunds one person when the items add up below zero', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await itemise()
    fireEvent.click(screen.getByLabelText('Several people paid'))
    fillItem(1, 'Returned kettle', '-30')
    expect(screen.getByLabelText('Refunded to')).toBeTruthy()
    expect(screen.queryByLabelText('Paid by')).toBeNull()
    expect(screen.queryByLabelText('Several people paid')).toBeNull()
    expect(screen.getByText(/^Total: -.*30\.00$/)).toBeTruthy()
    const preview = screen.getByRole('region', { name: 'Each person’s part' })
    expect(within(preview).getByText(/^Alice: paid -.*30\.00, share -.*10\.00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      payers: [{ personId: 'alice', cents: -3000 }],
      items: [{ name: 'Returned kettle', amountCents: -3000 }],
    })
  })

  it('refuses a discount that takes someone below zero (I-4), sending nothing', async () => {
    await itemise()
    fillItem(1, 'Beer', '20')
    fireEvent.click(within(whoFor(1)).getByLabelText('Alice'))
    fireEvent.click(within(whoFor(1)).getByLabelText('Cara'))
    fillItem(2, 'Big coupon', '15')
    fireEvent.click(screen.getByLabelText('Item 2 is a discount'))
    const message = 'A discount can’t make anyone’s part go below zero.'
    expect(screen.getByRole('status', { name: '' }).textContent).toBe(message)
    const focused = document.activeElement
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    // The refusal is an alert above the form; focus isn't sent to the items.
    expect(document.activeElement).toBe(focused)
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses an item without a name, amount or people, next to the item', async () => {
    await itemise()
    fillItem(1, 'Milk', '4')
    fillItem(2, '', 'lots')
    for (const name of ['Alice', 'Bob', 'Cara']) {
      fireEvent.click(within(whoFor(2)).getByLabelText(name))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const name = screen.getByLabelText('Item 2 name')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Required')).toBeTruthy()
    expect(screen.getByText('Enter an amount like 40.50')).toBeTruthy()
    const people = screen.getByText('Tick at least one person for this item.')
    expect(whoFor(2).getAttribute('aria-describedby')).toBe(people.id)
    expect(screen.getByLabelText('Item 1 name').getAttribute('aria-invalid')).toBe('false')
    // Fixed, the item's errors go as it's changed.
    fireEvent.click(within(whoFor(2)).getByLabelText('Bob'))
    await waitFor(() =>
      expect(screen.queryByText('Tick at least one person for this item.')).toBeNull(),
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses items that add up to zero, focusing Add item', async () => {
    await itemise()
    fillItem(1, 'Milk', '4')
    fillItem(2, 'Milk back', '-4')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('The items add up to 0.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add item' }))
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses items that add up to more than the limit, without breaking the page', async () => {
    await itemise()
    fillItem(1, 'Car', '99999999')
    fillItem(2, 'Boat', '99999999')
    expect(screen.getByText('Total: –')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(
      await screen.findByText(/^The items add up to more than .*100,000,000\.00\.$/),
    ).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('focuses the item’s first person when only its people are wrong', async () => {
    await itemise()
    fillItem(1, 'Milk', '4')
    fillItem(2, 'Bread', '5')
    for (const name of ['Alice', 'Bob', 'Cara']) {
      fireEvent.click(within(whoFor(2)).getByLabelText(name))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Tick at least one person for this item.')).toBeTruthy()
    expect(document.activeElement).toBe(within(whoFor(2)).getByLabelText('Alice'))
    expect(call).not.toHaveBeenCalled()
  })

  it('counts everyone across the items: at most 15 people', async () => {
    const many = Array.from({ length: 15 }, (_, n) =>
      housemate(`p${String(n).padStart(2, '0')}`, `Person ${n}`, '2026-01-01'),
    )
    mockGroups(house)
    mockRows([], [], [housemate('alice', 'Alice', '2026-01-01'), ...many])
    renderAt('/transactions/new?groupId=house1')
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Shop' } })
    fireEvent.click(screen.getByLabelText('Itemise this receipt'))
    fillItem(1, 'Cake', '16')
    fireEvent.click(within(whoFor(1)).getByLabelText('Person 0'))
    fillItem(2, 'Candles', '2')
    fireEvent.click(within(whoFor(2)).getByLabelText('Alice'))
    // Alice paid and has the cake; Person 0 has the candles: 16 people.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('At most 15 people can be in one expense.')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the amount and the items when switched off and on', async () => {
    call.mockResolvedValue(ok({ transaction: row('x9'), shares: [] }))
    await itemise()
    fillItem(1, 'Milk', '4')
    fireEvent.click(screen.getByLabelText('Itemise this receipt'))
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('90')
    expect(screen.queryByLabelText('Item 1 name')).toBeNull()
    fireEvent.click(screen.getByLabelText('Itemise this receipt'))
    expect((screen.getByLabelText('Item 1 name') as HTMLInputElement).value).toBe('Milk')
    fireEvent.click(screen.getByLabelText('Itemise this receipt'))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as Record<string, unknown>
    expect(body).toMatchObject({ totalCents: 9000 })
    expect(body).not.toHaveProperty('items')
  })

  it('moves focus to a new item’s name, and to Add item after a remove', async () => {
    await itemise()
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Item 2 name')))
    fireEvent.change(screen.getByLabelText('Item 2 name'), { target: { value: 'Bread' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 1' }))
    const add = screen.getByRole('button', { name: 'Add item' })
    expect(document.activeElement).toBe(add)
    expect((screen.getByLabelText('Item 1 name') as HTMLInputElement).value).toBe('Bread')
    expect(screen.queryByLabelText('Item 2 name')).toBeNull()
  })

  // CPU-bound, not waiting: each Add renders the whole form twice with every item so far, about
  // 900 item renders in React's dev build. About 4 s alone, up to 25 s with 3 full runs at once.
  it('stops at 30 items', { timeout: 30_000 }, async () => {
    await itemise()
    const add = screen.getByRole('button', { name: 'Add item' })
    for (let n = 1; n < 30; n++) fireEvent.click(add)
    // By id: label queries over 30 items are slow.
    expect(document.getElementById('item-29-name')).not.toBeNull()
    expect(add.getAttribute('aria-disabled')).toBe('true')
    const full = document.getElementById(add.getAttribute('aria-describedby') ?? '')
    expect(full?.textContent).toBe('A receipt can have at most 30 items.')
    fireEvent.click(add)
    expect(document.getElementById('item-30-name')).toBeNull()
  })
})

// The user's personal group (#402): Sam is its owner and only member (permissions.md).
const personal = {
  $id: 'me1',
  type: 'personal',
  name: 'Personal',
  ownerPersonId: 'pw',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

const ME = [
  { $id: 'm9', groupId: 'me1', personId: 'pw', displayName: 'Sam', role: 'admin' },
] as Members[]

describe('NewTransactionPage, personal income and expense (#402)', () => {
  it('offers Income and Expense, and none of the employer presets', async () => {
    mockGroups(personal)
    mockRows([], [], ME)
    renderAt('/transactions/new?groupId=me1')
    expect(await screen.findByRole('heading', { name: 'Add income or expense' })).toBeTruthy()
    const choices = within(await screen.findByRole('group', { name: 'What happened?' }))
    expect(choices.getAllByRole('radio')).toHaveLength(2)
    expect((choices.getByRole('radio', { name: /^Income/ }) as HTMLInputElement).checked).toBe(true)
    expect(choices.getByRole('radio', { name: /^Expense/ })).toBeTruthy()
    expect(screen.queryByLabelText(/I paid for them/)).toBeNull()
    // An optional category (functions-api.md#transactioninput), none by default.
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('')
  })

  it('offers no adjustment: there is nobody to adjust against', async () => {
    mockGroups(personal)
    mockRows([], [], ME)
    renderAt('/transactions/new?groupId=me1&kind=adjustment')
    expect(await screen.findByRole('heading', { name: 'Add income or expense' })).toBeTruthy()
    expect(await screen.findByRole('radio', { name: /^Income/ })).toBeTruthy()
    expect(screen.queryByLabelText('Who is owed more')).toBeNull()
    expect(screen.queryByRole('link', { name: /with an adjustment/ })).toBeNull()
  })

  it.each([
    ['Income', { kind: 'income' }],
    [
      'Expense',
      {
        kind: 'expense',
        payers: [{ personId: 'pw', cents: 1999 }],
        split: { mode: 'equal', personIds: ['pw'] },
      },
    ],
  ])('sends %s as the documented body, in cents, dated local today', async (label, parts) => {
    // 01:30 on the 19th in Sydney, still the 18th in UTC.
    vi.setSystemTime(HOUSE_NOW)
    mockGroups(personal)
    mockRows([], [], ME)
    call.mockResolvedValue(ok({ transaction: row('x5', { groupId: 'me1' }), shares: [] }))
    const { router } = renderAt('/transactions/new?groupId=me1')
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(`^${label}`) }))
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '19.99' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: ' Refund ' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'other' } })
    expect(screen.getByLabelText('Note (optional)').tagName).toBe('TEXTAREA')
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'ATO\nref 7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'POST', '/transactions'])
    expect(call.mock.calls[0]?.[3]).toEqual({
      id: expect.any(String),
      groupId: 'me1',
      date: '2026-10-19',
      description: 'Refund',
      totalCents: 1999,
      category: 'other',
      note: 'ATO\nref 7',
      ...parts,
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/transactions/x5'))
  })
})

describe('HistoryPage, the personal group (#402)', () => {
  const entries = [
    row('t2', { groupId: 'me1', kind: 'income', description: 'Refund', category: null }),
    row('t1', { groupId: 'me1', description: 'Groceries', date: '2026-10-17' }),
  ]

  it('lists its entries with its own kinds and Add, and no balance or invoices', async () => {
    mockGroups(personal)
    mockRows(entries, [], ME)
    renderAt('/transactions?groupId=me1')
    const list = await screen.findByRole('region', { name: 'Transactions' })
    const links = await within(list).findAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/transactions/t2',
      '/transactions/t1',
    ])
    // The DOM order stays description, details, amount, so a link's name is unchanged (#502).
    expect(links[1]?.textContent).toMatch(/^Groceries2026-10-17 · Expense · PostedA?\$40\.00$/)
    expect(within(list).getByText('2026-10-18 · Income · Posted')).toBeTruthy()
    expect(within(list).getByText('2026-10-17 · Expense · Posted')).toBeTruthy()
    expect(listCalls().find((params) => params.tableId === 'transactions')?.queries).toContain(
      Query.equal('groupId', 'me1'),
    )
    // ledger.md#transaction-kinds: a personal group's.
    const kinds = within(screen.getByLabelText('Kind')).getAllByRole('option')
    expect(kinds.map((option) => option.textContent)).toEqual([
      'All',
      'Expense',
      'Bill',
      'Income',
      'Adjustment',
    ])
    expect(screen.getByRole('link', { name: 'Add income or expense' }).getAttribute('href')).toBe(
      '/transactions/new?groupId=me1',
    )
    expect(screen.queryByRole('link', { name: 'Invoices' })).toBeNull()
    expect(screen.queryByText(/^Balance with/)).toBeNull()
  })

  it('opens on All groups (F-71), and offers the personal group to pick and filter', async () => {
    mockGroups(acme)
    vi.mocked(useGroups).mockReturnValue({ data: [acme, personal], isError: false } as never)
    mockRows(entries)
    renderAt('/transactions')
    await screen.findByRole('region', { name: 'Transactions' })
    const picker = screen.getByLabelText('Group') as HTMLSelectElement
    expect(picker.value).toBe('')
    expect(screen.queryByText('All square')).toBeNull()
    fireEvent.change(picker, { target: { value: 'me1' } })
    expect(await screen.findByRole('link', { name: 'Add income or expense' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'income' } })
    await waitFor(() =>
      expect(listCalls().at(-1)?.queries).toEqual(
        expect.arrayContaining([Query.equal('groupId', 'me1'), Query.equal('kind', 'income')]),
      ),
    )
  })
})

describe('NewTransactionPage, adjustment (#400)', () => {
  const ADJUST = '/transactions/new?groupId=g1&kind=adjustment'
  const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement

  it('sends who is owed more and who owes more as balancing shares, and refreshes the balances', async () => {
    mockGroups(acme)
    mockRows()
    call.mockResolvedValue(ok({ transaction: row('a1', { kind: 'adjustment' }), shares: [] }))
    const { router, queryClient } = renderAt(ADJUST)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    expect(screen.getByRole('heading', { level: 1, name: 'Add adjustment' })).toBeTruthy()
    // The worker is owed more by the employer, until changed.
    expect(((await screen.findByLabelText('Who is owed more')) as HTMLSelectElement).value).toBe(
      'pw',
    )
    expect(select('Who owes more').value).toBe('pe')
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '12.50' } })
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: ' Shift on 3 Oct was an hour short ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'POST', '/transactions'])
    expect(call.mock.calls[0]?.[3]).toEqual({
      id: expect.any(String),
      groupId: 'g1',
      kind: 'adjustment',
      date: '2026-10-18',
      description: 'Shift on 3 Oct was an hour short',
      totalCents: 1250,
      adjustment: {
        // Sorted by personId, as buildShares() stores them.
        shares: [
          { personId: 'pe', givenCents: 0, receivedCents: 1250 },
          { personId: 'pw', givenCents: 1250, receivedCents: 0 },
        ],
        reason: 'Shift on 3 Oct was an hour short',
      },
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/transactions/a1'))
    // The group's balances and history are read again. The next statement, a draft, is worked
    // out again when it's opened (statements.md core rule 1).
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.balances('g1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history', 'g1'] })
  })

  it('offers everyone in a house, and refuses one person on both sides, no amount and no reason', async () => {
    mockPersonId = 'alice'
    vi.setSystemTime(HOUSE_NOW)
    mockGroups(house, 'member')
    mockRows([], [], HOUSEMATES)
    renderAt('/transactions/new?groupId=house1&kind=adjustment')
    const owed = (await screen.findByLabelText('Who is owed more')) as HTMLSelectElement
    // Dan, who moved out, too: balances with him can still be put right.
    expect([...owed.options].map((option) => option.textContent)).toEqual([
      'Alice',
      'Bob',
      'Cara',
      'Dan',
    ])
    expect(owed.value).toBe('alice')
    expect(select('Who owes more').value).toBe('bob')
    fireEvent.change(select('Who owes more'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Pick someone other than who is owed more')).toBeTruthy()
    expect(screen.getByText('Enter an amount above 0')).toBeTruthy()
    expect(screen.getByText('Required')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    call.mockResolvedValue(
      ok({ transaction: row('a2', { groupId: 'house1', kind: 'adjustment' }), shares: [] }),
    )
    fireEvent.change(select('Who is owed more'), { target: { value: 'cara' } })
    fireEvent.change(select('Who owes more'), { target: { value: 'dan' } })
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'September power, split wrong' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      groupId: 'house1',
      // Local today in Sydney.
      date: '2026-10-19',
      totalCents: 3000,
      adjustment: {
        shares: [
          { personId: 'cara', givenCents: 3000, receivedCents: 0 },
          { personId: 'dan', givenCents: 0, receivedCents: 3000 },
        ],
      },
    })
  })

  it('refuses an amount that isn’t one, and a reason over 200 characters', async () => {
    mockGroups(acme)
    mockRows()
    renderAt(ADJUST)
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '4.005' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x'.repeat(201) } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Enter an amount like 40.50')).toBeTruthy()
    expect(screen.getByText('At most 200 characters')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('shows the ledger’s refusal, keeps the ID for the retry, and warns of a duplicate on CONFLICT', async () => {
    mockGroups(acme)
    mockRows()
    call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Adjustment shares must balance' },
    })
    call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CONFLICT', message: 'A different transaction already has this ID.' },
    })
    renderAt(ADJUST)
    fireEvent.change(await screen.findByLabelText('Amount (AUD)'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Wrong rate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Adjustment shares must balance')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This may already have been saved from your last try. Check History before adding it again.',
      ),
    )
    const [first, second] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).toBe(first)
  })

  it('links between the expense form and the adjustment form', async () => {
    mockGroups(acme)
    mockRows()
    const { router } = renderAt('/transactions/new?groupId=g1')
    fireEvent.click(
      await screen.findByRole('link', { name: 'Correct a final invoice with an adjustment' }),
    )
    expect(await screen.findByLabelText('Who is owed more')).toBeTruthy()
    expect(router.state.location.search).toBe('?groupId=g1&kind=adjustment')
    fireEvent.click(screen.getByRole('link', { name: 'Add an expense or payment instead' }))
    expect(await screen.findByText('I paid for them (reimbursable)')).toBeTruthy()
    cleanup()
    mockPersonId = 'alice'
    mockGroups(house, 'member')
    mockRows([], [], HOUSEMATES)
    renderAt('/transactions/new?groupId=house1')
    expect(
      await screen.findByRole('link', { name: 'Correct a final divide with an adjustment' }),
    ).toBeTruthy()
  })

  it('has no form for a viewer, a non-owner in an employer group, an archived group or a house of one', async () => {
    const none = async (text: string) => {
      expect(await screen.findByText(text)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
      expect(screen.queryByRole('link', { name: /instead$/ })).toBeNull()
      cleanup()
    }
    mockGroups(acme, 'viewer')
    mockRows()
    renderAt(ADJUST)
    await none('You can see this group’s history but no longer add to it.')
    mockGroups({ ...acme, ownerPersonId: 'pe' })
    renderAt(ADJUST)
    await none('Only the person this group pays adds expenses and payments here.')
    mockGroups({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt(ADJUST)
    await none('This group is archived. You can see its history but not change it.')
    mockPersonId = 'alice'
    mockGroups(house, 'admin')
    mockRows([], [], [housemate('alice', 'Alice', '2026-01-01')])
    renderAt('/transactions/new?groupId=house1&kind=adjustment')
    expect(
      await screen.findByText(
        'An adjustment is between two people, and you’re the only one in this group.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    // An expense can still be added there.
    expect(screen.getByRole('link', { name: 'Add an expense instead' })).toBeTruthy()
  })
})

describe('HistoryPage', () => {
  it.each([
    [71500, /^Acme owes you .*715\.00$/],
    [-2050, /^You owe Acme .*20\.50$/],
    [0, /^All square$/],
    // A balance can pass the amount cap.
    [20_000_000_000, /^Acme owes you .*200,000,000\.00$/],
  ])('words a net of %i from the viewer’s side', async (net, text) => {
    mockGroups(acme, 'admin', net)
    mockRows()
    renderAt('/transactions?groupId=g1')
    expect(await screen.findByText(text)).toBeTruthy()
  })

  it('words it from the employer’s side when the employer views it', async () => {
    mockPersonId = 'pe'
    mockGroups(acme, 'viewer', 71500)
    mockRows()
    renderAt('/transactions?groupId=g1')
    expect(await screen.findByText(/^You owe Sam .*715\.00$/)).toBeTruthy()
  })

  it('says nothing about the balance until it knows whose side to word it from', async () => {
    mockPersonId = ''
    mockGroups(acme, 'admin', 71500)
    mockRows()
    renderAt('/transactions?groupId=g1')
    expect(await screen.findByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('All square')).toBeNull()
  })

  it('ignores dates in a hand-edited link that aren’t dates', async () => {
    mockGroups(acme)
    mockRows()
    renderAt('/transactions?groupId=g1&from=2026-02-30&to=yesterday')
    await screen.findByRole('region', { name: 'Transactions' })
    const queries = listCalls().find((params) => params.tableId === 'transactions')?.queries ?? []
    expect(
      queries.some((q) => q.includes('"date"') && /greaterThanEqual|lessThanEqual/.test(q)),
    ).toBe(false)
  })

  it('ignores an unknown kind or category in a hand-edited link', async () => {
    mockGroups(acme)
    mockRows()
    renderAt('/transactions?groupId=g1&kind=foo&category=bar')
    await screen.findByRole('region', { name: 'Transactions' })
    const queries = listCalls().find((params) => params.tableId === 'transactions')?.queries ?? []
    expect(queries).not.toContain(Query.equal('kind', 'foo'))
    expect(queries).not.toContain(Query.equal('category', 'bar'))
    expect(queries.some((q) => q.includes('"method":"equal"') && /"kind"|"category"/.test(q))).toBe(
      false,
    )
    expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('')
  })

  it('lists the history newest first, links each row, and pages with a cursor', async () => {
    mockGroups(acme)
    const page1 = Array.from({ length: 25 }, (_, i) => row(`t${String(i).padStart(2, '0')}`))
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      if (tableId === 'members') return { total: 2, rows: MEMBERS }
      const rows = queries.some((q) => q.includes('cursorAfter'))
        ? [row('t99', { description: 'Older' })]
        : page1
      return { total: rows.length, rows }
    }) as never)
    renderAt('/transactions?groupId=g1')
    const list = await screen.findByRole('region', { name: 'Transactions' })
    expect(within(list).getAllByRole('link')).toHaveLength(25)
    expect(within(list).getAllByRole('link')[0]?.getAttribute('href')).toBe('/transactions/t00')
    const first = listCalls().find((params) => params.tableId === 'transactions')
    expect(first?.queries).toEqual(
      expect.arrayContaining([
        Query.equal('groupId', 'g1'),
        Query.orderDesc('date'),
        Query.orderDesc('$id'),
        Query.limit(25),
      ]),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await within(list).findByRole('link', { name: /^Older/ })).toBeTruthy()
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(26))
    expect(listCalls().at(-1)?.queries).toContain(Query.cursorAfter('t24'))
    // Only the columns a row shows, not inputJson.
    expect(first?.queries).toContain(
      Query.select(['$id', 'groupId', 'kind', 'status', 'date', 'description', 'totalCents']),
    )
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('keeps Load more focusable while it loads, and loads the next page once', async () => {
    mockGroups(acme)
    const page1 = Array.from({ length: 25 }, (_, i) => row(`t${String(i).padStart(2, '0')}`))
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      if (tableId === 'members') return { total: 2, rows: MEMBERS }
      // The next page never answers.
      if (queries.some((q) => q.includes('cursorAfter'))) return new Promise(() => {})
      return { total: page1.length, rows: page1 }
    }) as never)
    renderAt('/transactions?groupId=g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    const loading = await screen.findByRole('button', { name: 'Loading…' })
    expect(loading.getAttribute('aria-disabled')).toBe('true')
    loading.focus()
    expect(document.activeElement).toBe(loading)
    fireEvent.click(loading)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const nextPages = listCalls().filter((params) =>
      params.queries.some((q) => q.includes('cursorAfter')),
    )
    expect(nextPages).toHaveLength(1)
  })

  it('filters by kind, category and dates, in the query', async () => {
    mockGroups(acme)
    mockRows()
    renderAt('/transactions?groupId=g1')
    fireEvent.change(await screen.findByLabelText('Kind'), { target: { value: 'payment' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } })
    await waitFor(() => {
      expect(listCalls().at(-1)?.queries).toEqual(
        expect.arrayContaining([
          Query.equal('kind', 'payment'),
          Query.equal('category', 'work'),
          Query.greaterThanEqual('date', '2026-10-01'),
          Query.lessThanEqual('date', '2026-10-31'),
        ]),
      )
    })
  })

  it('keeps a kind picked just before a search, before the page has rendered it', async () => {
    mockGroups(acme)
    mockRows()
    const { router } = renderAt('/transactions?groupId=g1')
    const kind = await screen.findByLabelText('Kind')
    // Outside act(), as a person's events are: the router renders each change in a transition,
    // so the search comes before the page has rendered the kind.
    kind.dispatchEvent(createEvent.change(kind, { target: { value: 'payment' } }))
    const search = screen.getByLabelText('Search descriptions')
    search.dispatchEvent(createEvent.change(search, { target: { value: 'rent' } }))
    await waitFor(() => expect(router.state.location.search).toContain('q=rent'))
    expect(new URLSearchParams(router.state.location.search).get('kind')).toBe('payment')
  })

  it('keeps a group picked just before a kind, before the page has rendered it', async () => {
    mockGroups(acme)
    mockRows()
    const { router } = renderAt('/transactions')
    const group = await screen.findByLabelText('Group')
    group.dispatchEvent(createEvent.change(group, { target: { value: 'g1' } }))
    const kind = screen.getByLabelText('Kind')
    kind.dispatchEvent(createEvent.change(kind, { target: { value: 'payment' } }))
    await waitFor(() => expect(router.state.location.search).toContain('kind=payment'))
    expect(new URLSearchParams(router.state.location.search).get('groupId')).toBe('g1')
  })

  it('offers Add to those who keep the records, but not to a viewer or in an archived group', async () => {
    mockGroups(acme)
    mockRows()
    renderAt('/transactions?groupId=g1')
    expect(
      (await screen.findByRole('link', { name: 'Add expense or payment' })).getAttribute('href'),
    ).toBe('/transactions/new?groupId=g1')
    expect(screen.getByRole('link', { name: 'Invoices' }).getAttribute('href')).toBe(
      '/groups/g1/statements',
    )
    cleanup()
    // An admin who isn't the group's owner: the form would refuse them, so no link.
    mockPersonId = 'pe'
    mockGroups(acme, 'admin')
    renderAt('/transactions?groupId=g1')
    await screen.findByText('All square')
    expect(screen.queryByRole('link', { name: 'Add expense or payment' })).toBeNull()
    mockPersonId = 'pw'
    cleanup()
    mockGroups(acme, 'viewer')
    renderAt('/transactions?groupId=g1')
    await screen.findByText('All square')
    expect(screen.queryByRole('link', { name: 'Add expense or payment' })).toBeNull()
    cleanup()
    mockGroups({ ...acme, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/transactions?groupId=g1')
    expect(
      await screen.findByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add expense or payment' })).toBeNull()
    // Its balance and history still show.
    expect(await screen.findByText('All square')).toBeTruthy()
  })
})

describe('HistoryPage, across groups (F-71)', () => {
  // The creator's label for Jo, whom the app names the pair by (#145). In its own currency.
  const pair = {
    $id: 'pair1',
    type: 'pair',
    name: 'Joanna',
    ownerPersonId: 'pw',
    currency: 'NZD',
    timezone: 'Pacific/Auckland',
    archivedAt: null,
  } as Groups
  // As useGroups lists them, by their own names.
  const GROUPS = [acme, pair, personal, house]
  const MEMBERS_OF: Record<string, Members[]> = {
    g1: MEMBERS,
    house1: HOUSEMATES,
    pair1: [
      { $id: 'm7', groupId: 'pair1', personId: 'pw', displayName: 'Sam', role: 'admin' },
      { $id: 'm8', groupId: 'pair1', personId: 'jo', displayName: 'Jo', role: 'admin' },
    ] as Members[],
    me1: ME,
  }
  const COLUMNS = Query.select([
    '$id',
    'groupId',
    'kind',
    'status',
    'date',
    'description',
    'totalCents',
  ])
  const NEWEST = [Query.orderDesc('date'), Query.orderDesc('$id'), Query.limit(25)]

  /** The values of a call's `equal` on `attribute`. */
  function equalTo(queries: string[], attribute: string): unknown[] | undefined {
    return queries
      .map((query) => JSON.parse(query) as { method: string; attribute: string; values: unknown[] })
      .find((query) => query.method === 'equal' && query.attribute === attribute)?.values
  }

  /**
   * The user is in every group of `GROUPS`. listRows answers members by group, and shares and
   * transactions with `shares` and `transactions` of the call's queries.
   */
  function mockAll(
    transactions: (queries: string[]) => Transactions[] = () => [],
    shares: (queries: string[]) => object[] = () => [],
  ) {
    mockGroups(acme)
    vi.mocked(useGroups).mockReturnValue({ data: GROUPS, isError: false } as never)
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      const rows =
        tableId === 'members'
          ? (MEMBERS_OF[String(equalTo(queries, 'groupId')?.[0])] ?? [])
          : tableId === 'shares'
            ? shares(queries)
            : transactions(queries)
      return { total: rows.length, rows }
    }) as never)
  }

  /** Each listRows call's queries on one table. */
  const calls = (tableId: string) =>
    listCalls()
      .filter((params) => params.tableId === tableId)
      .map((params) => params.queries)

  const options = (label: string) =>
    within(screen.getByLabelText(label))
      .getAllByRole('option')
      .map((option) => option.textContent)

  it('opens on All groups: every group’s rows, each with its group’s name, and every kind', async () => {
    mockAll(() => [
      row('t4'),
      row('t3', { groupId: 'pair1', kind: 'loan', description: 'Concert tickets' }),
      row('t2', { groupId: 'house1', kind: 'bill', description: 'Power' }),
      row('t1', { groupId: 'me1', kind: 'income', description: 'Refund', date: '2026-10-17' }),
    ])
    renderAt('/transactions')
    const list = await screen.findByRole('region', { name: 'Transactions' })
    // Each row's group is on a line of its own, so its status line still fits at 375 px.
    const rowOf = (id: string) =>
      within(
        within(list)
          .getAllByRole('link')
          .find((link) => link.getAttribute('href') === `/transactions/${id}`) as HTMLElement,
      )
    expect(rowOf('t4').getByText('2026-10-18 · Expense · Posted')).toBeTruthy()
    expect(rowOf('t4').getByText('Acme')).toBeTruthy()
    expect(await rowOf('t3').findByText('Jo')).toBeTruthy()
    expect(rowOf('t3').getByText('2026-10-18 · Loan · Posted')).toBeTruthy()
    expect(within(list).getByText('NZ$40.00')).toBeTruthy()
    expect(rowOf('t2').getByText('2026-10-18 · Bill · Posted')).toBeTruthy()
    expect(rowOf('t2').getByText('The flat')).toBeTruthy()
    expect(rowOf('t1').getByText('2026-10-17 · Income · Posted')).toBeTruthy()
    expect(rowOf('t1').getByText('Personal')).toBeTruthy()
    // Wraps on a phone, so a long one isn't cut off at 320 px, and keeps to one line from md (#539).
    for (const text of ['Power', 'The flat']) {
      const classes = rowOf('t2')
        .getByText(text)
        .closest('[class~="md:truncate"]')
        ?.className.split(' ')
      expect(classes, text).toContain('break-words')
      expect(classes, text).not.toContain('truncate')
    }
    // One read of every group, which doesn't move when the pair's name arrives.
    expect(calls('transactions')).toEqual([
      [Query.equal('groupId', ['g1', 'pair1', 'me1', 'house1']), COLUMNS, ...NEWEST],
    ])
    expect((screen.getByLabelText('Group') as HTMLSelectElement).value).toBe('')
    expect(options('Group')).toEqual(['All groups', 'Acme', 'Jo', 'Personal', 'The flat'])
    expect(options('Kind')).toEqual([
      'All',
      'Shift',
      'Expense',
      'Bill',
      'Payment',
      'Loan',
      'Income',
      'Adjustment',
    ])
    // No one group's balance, Add link or people.
    expect(screen.queryByRole('heading', { name: /^Balance with/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /^(Add|Record)/ })).toBeNull()
    expect(screen.queryByLabelText('Person')).toBeNull()
  })

  it.each([
    [
      'house1',
      'Add expense',
      '/transactions/new?groupId=house1',
      ['Expense', 'Bill', 'Payment', 'Loan', 'Adjustment'],
      false,
    ],
    [
      'pair1',
      'Record money lent or borrowed',
      '/people/pair1',
      ['Expense', 'Bill', 'Payment', 'Loan', 'Adjustment'],
      false,
    ],
    [
      'me1',
      'Add income or expense',
      '/transactions/new?groupId=me1',
      ['Expense', 'Bill', 'Income', 'Adjustment'],
      false,
    ],
    [
      'g1',
      'Add expense or payment',
      '/transactions/new?groupId=g1',
      ['Shift', 'Expense', 'Payment', 'Adjustment'],
      true,
    ],
  ])(
    'gives %s its own kinds and Add link, and a balance only to an employer',
    async (groupId, add, href, kinds, balance) => {
      mockAll(() => [row('t1', { groupId })])
      renderAt(`/transactions?groupId=${groupId}`)
      expect((await screen.findByRole('link', { name: add })).getAttribute('href')).toBe(href)
      expect(screen.getAllByRole('link', { name: /^(Add|Record)/ })).toHaveLength(1)
      expect((screen.getByLabelText('Group') as HTMLSelectElement).value).toBe(groupId)
      expect(options('Kind')).toEqual(['All', ...kinds])
      expect(Boolean(screen.queryByRole('heading', { name: /^Balance with/ }))).toBe(balance)
      // One group's rows don't repeat its name.
      expect(await screen.findByText('2026-10-18 · Expense · Posted')).toBeTruthy()
    },
  )

  it('offers a house’s Add only to its admins and members, and none in an archived one', async () => {
    mockAll()
    vi.mocked(useMyMember).mockReturnValue({ data: { role: 'viewer' }, isError: false } as never)
    renderAt('/transactions?groupId=house1')
    await screen.findByRole('region', { name: 'Transactions' })
    expect(screen.queryByRole('link', { name: 'Add expense' })).toBeNull()
    cleanup()
    mockAll()
    vi.mocked(useGroups).mockReturnValue({
      data: [{ ...house, archivedAt: '2026-10-01T00:00:00.000Z' }],
      isError: false,
    } as never)
    renderAt('/transactions?groupId=house1')
    expect(
      await screen.findByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add expense' })).toBeNull()
    expect(options('Group')).toEqual(['All groups', 'The flat (archived)'])
  })

  it('searches the description: in the URL trimmed, as Query.contains with the other filters', async () => {
    mockAll()
    const { router } = renderAt('/transactions?groupId=g1&kind=expense')
    const field = (await screen.findByLabelText('Search descriptions')) as HTMLInputElement
    fireEvent.change(field, { target: { value: '  Hardware shop ' } })
    // The field keeps what's typed, so a space between words can be typed.
    expect(field.value).toBe('  Hardware shop ')
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe('Hardware shop')
    await waitFor(() =>
      expect(calls('transactions').at(-1)).toEqual([
        Query.equal('groupId', 'g1'),
        Query.equal('kind', 'expense'),
        Query.contains('description', 'Hardware shop'),
        COLUMNS,
        ...NEWEST,
      ]),
    )
    fireEvent.change(field, { target: { value: '   ' } })
    expect(new URLSearchParams(router.state.location.search).has('q')).toBe(false)
    await waitFor(() =>
      expect(calls('transactions').at(-1)).toEqual([
        Query.equal('groupId', 'g1'),
        Query.equal('kind', 'expense'),
        COLUMNS,
        ...NEWEST,
      ]),
    )
    cleanup()
    // From a link, under All groups: trimmed, and blank is no search.
    renderAt('/transactions?q=%20Power%20')
    expect(((await screen.findByLabelText('Search descriptions')) as HTMLInputElement).value).toBe(
      'Power',
    )
    await waitFor(() =>
      expect(calls('transactions').at(-1)).toEqual([
        Query.equal('groupId', ['g1', 'pair1', 'me1', 'house1']),
        Query.contains('description', 'Power'),
        COLUMNS,
        ...NEWEST,
      ]),
    )
    cleanup()
    renderAt('/transactions?groupId=me1&q=%20%20')
    await screen.findByRole('region', { name: 'Transactions' })
    expect(calls('transactions').at(-1)).toEqual([
      Query.equal('groupId', 'me1'),
      COLUMNS,
      ...NEWEST,
    ])
    // Never `search`: the description has no full-text index.
    expect(
      calls('transactions')
        .flat()
        .some((query) => query.includes('"search"')),
    ).toBe(false)
  })

  it('offers the person filter in one group only, with its members by name', async () => {
    mockAll()
    renderAt('/transactions?person=pw')
    // Under All groups, a person in the link is ignored.
    await screen.findByRole('region', { name: 'Transactions' })
    expect(screen.queryByLabelText('Person')).toBeNull()
    expect(calls('shares')).toEqual([])
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'house1' } })
    await screen.findByLabelText('Person')
    await waitFor(() =>
      expect(options('Person')).toEqual(['Everyone', 'Alice', 'Bob', 'Cara', 'Dan']),
    )
  })

  it('reads a person’s shares a page at a time, then those transactions by ID with the other filters', async () => {
    mockAll(
      () => [row('t2', { description: 'Van supplies' }), row('t1')],
      () => [
        { $id: 's2', transactionId: 't2' },
        { $id: 's1', transactionId: 't1' },
      ],
    )
    const { router } = renderAt(
      '/transactions?groupId=g1&kind=expense&category=work&q=Supp&from=2026-10-01&to=2026-10-31',
    )
    const person = await screen.findByLabelText('Person')
    await within(person).findByRole('option', { name: 'Acme' })
    fireEvent.change(person, { target: { value: 'pe' } })
    expect(new URLSearchParams(router.state.location.search).get('person')).toBe('pe')
    const list = await screen.findByRole('region', { name: 'Transactions' })
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(2))
    expect(calls('shares')).toEqual([
      [
        Query.equal('groupId', ['g1']),
        Query.equal('personId', 'pe'),
        Query.greaterThanEqual('date', '2026-10-01'),
        Query.lessThanEqual('date', '2026-10-31'),
        Query.select(['$id', 'transactionId']),
        ...NEWEST,
      ],
    ])
    expect(calls('transactions').at(-1)).toEqual([
      Query.equal('$id', ['t2', 't1']),
      Query.equal('kind', 'expense'),
      Query.equal('category', 'work'),
      Query.contains('description', 'Supp'),
      COLUMNS,
      ...NEWEST,
    ])
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    cleanup()
    listRows.mockClear()
    // From a link: it waits for the members, rather than list everyone's rows first.
    renderAt('/transactions?groupId=g1&person=pe')
    await waitFor(() => expect(screen.getAllByRole('link', { name: /supplies/i })).toHaveLength(2))
    expect(calls('transactions').every((queries) => equalTo(queries, '$id'))).toBe(true)
  })

  it('makes no transactions call for a page of shares with no IDs', async () => {
    mockAll(() => [row('t1')])
    renderAt('/transactions?groupId=g1&person=pe')
    expect(await screen.findByText('Nothing here yet.')).toBeTruthy()
    expect(calls('shares')).toHaveLength(1)
    expect(calls('transactions')).toEqual([])
  })

  it('carries on past a page the filters emptied, while the shares have more', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => ({
      $id: `s${String(i).padStart(2, '0')}`,
      transactionId: `t${String(i).padStart(2, '0')}`,
    }))
    mockAll(
      // Only page 2's transaction is a payment.
      (queries) =>
        equalTo(queries, '$id')?.includes('t25')
          ? [row('t25', { kind: 'payment', description: 'October pay' })]
          : [],
      (queries) =>
        queries.includes(Query.cursorAfter('s24')) ? [{ $id: 's25', transactionId: 't25' }] : page1,
    )
    renderAt('/transactions?groupId=g1&person=pe&kind=payment')
    expect(
      await screen.findByText('None of the latest entries match. Load more to look further back.'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('link', { name: /^October pay/ })).toBeTruthy()
    // The cursor is the last share's, not a transaction's.
    expect(calls('shares').at(-1)).toContain(Query.cursorAfter('s24'))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('ignores a ?person= who isn’t a member, and a ?groupId= that isn’t the user’s', async () => {
    mockAll()
    renderAt('/transactions?groupId=g1&person=stranger')
    await screen.findByRole('region', { name: 'Transactions' })
    expect((screen.getByLabelText('Person') as HTMLSelectElement).value).toBe('')
    expect(calls('shares')).toEqual([])
    expect(calls('transactions').at(-1)).toContain(Query.equal('groupId', 'g1'))
    cleanup()
    renderAt('/transactions?groupId=nope')
    await screen.findByRole('region', { name: 'Transactions' })
    expect((screen.getByLabelText('Group') as HTMLSelectElement).value).toBe('')
    expect(calls('transactions').at(-1)).toContain(
      Query.equal('groupId', ['g1', 'pair1', 'me1', 'house1']),
    )
    expect(calls('transactions').flat()).not.toContain(Query.equal('groupId', 'nope'))
  })

  it('drops the person, and a kind the next group doesn’t have, on picking another group', async () => {
    mockAll()
    const { router } = renderAt('/transactions?groupId=house1&person=stranger&kind=bill')
    await screen.findByLabelText('Person')
    const search = () => new URLSearchParams(router.state.location.search)
    // An employer has no bills.
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'g1' } })
    expect(search().get('groupId')).toBe('g1')
    expect(search().get('person')).toBeNull()
    expect(search().get('kind')).toBeNull()
    // A kind both have stays.
    fireEvent.change(await screen.findByLabelText('Kind'), { target: { value: 'expense' } })
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'house1' } })
    expect(search().get('kind')).toBe('expense')
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: '' } })
    expect(search().get('groupId')).toBeNull()
    expect(search().get('kind')).toBe('expense')
    // The next group's own kinds decide: a house has loans, an employer doesn't.
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'loan' } })
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'house1' } })
    expect(search().get('kind')).toBe('loan')
  })

  it('offers no person in the personal group, whose owner is its only member', async () => {
    mockAll()
    renderAt('/transactions?groupId=me1&person=pw')
    await screen.findByRole('region', { name: 'Transactions' })
    expect(screen.queryByLabelText('Person')).toBeNull()
    expect(calls('shares')).toEqual([])
    expect(calls('transactions').at(-1)).toContain(Query.equal('groupId', 'me1'))
  })

  /** A void in `groupId` through the app's own mutation, on the page's query client. */
  async function voidIn(queryClient: QueryClient, groupId: string) {
    call.mockResolvedValue(
      ok({ transaction: row('t1', { groupId, status: 'void' }), shares: [], items: [] }),
    )
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useVoidTransaction('t1'), { wrapper })
    await act(() => result.current.mutateAsync({ reason: 'Twice' }))
  }

  /** What Realtime refreshes for one row event (lib/realtime.ts). */
  async function realtimeEvent(queryClient: QueryClient, payload: object) {
    await act(async () => {
      for (const queryKey of staleKeys({ payload }))
        await queryClient.invalidateQueries({ queryKey })
    })
  }

  it('reads All groups again after a write in any group, and on its Realtime event', async () => {
    mockAll(() => [row('t1', { groupId: 'house1' })])
    const { queryClient } = renderAt('/transactions')
    await screen.findByRole('link', { name: /^Supplies/ })
    let before = calls('transactions').length
    await voidIn(queryClient, 'house1')
    await waitFor(() => expect(calls('transactions').length).toBeGreaterThan(before))
    before = calls('transactions').length
    await realtimeEvent(queryClient, { $tableId: 'transactions', $id: 't1', groupId: 'house1' })
    await waitFor(() => expect(calls('transactions').length).toBeGreaterThan(before))
  })

  it('reads a person’s shares again after a write in the group, and on its Realtime events', async () => {
    mockAll(
      () => [row('t1', { groupId: 'house1' })],
      () => [{ $id: 's1', transactionId: 't1' }],
    )
    const { queryClient } = renderAt('/transactions?groupId=house1&person=alice')
    await screen.findByRole('link', { name: /^Supplies/ })
    let before = calls('shares').length
    await voidIn(queryClient, 'house1')
    await waitFor(() => expect(calls('shares').length).toBeGreaterThan(before))
    before = calls('shares').length
    await realtimeEvent(queryClient, { $tableId: 'transactions', $id: 't1', groupId: 'house1' })
    await waitFor(() => expect(calls('shares').length).toBeGreaterThan(before))
    // A merge changes shares no transaction row shows, and sets the group's `rev`.
    before = calls('shares').length
    await realtimeEvent(queryClient, { $tableId: 'groups', $id: 'house1' })
    await waitFor(() => expect(calls('shares').length).toBeGreaterThan(before))
  })
})

describe('TransactionPage', () => {
  it('shows a house expense’s split, each part by name, and links the house', async () => {
    mockPersonId = 'alice'
    mockGroups(house)
    mockRows(
      [],
      [
        { $id: 's1', personId: 'alice', givenCents: 9000, receivedCents: 3000 },
        { $id: 's2', personId: 'bob', givenCents: 0, receivedCents: 3000 },
        { $id: 's3', personId: 'cara', givenCents: 0, receivedCents: 3000 },
      ],
      HOUSEMATES,
    )
    getRow.mockResolvedValue(
      row('t9', {
        groupId: 'house1',
        description: 'Groceries',
        category: 'groceries',
        totalCents: 9000,
        inputJson: JSON.stringify({
          payers: [{ personId: 'alice', cents: 9000 }],
          split: { mode: 'equal', personIds: ['alice', 'bob', 'cara'] },
        }),
      }) as never,
    )
    renderAt('/transactions/t9')
    const split = (await screen.findByText('Split')).nextElementSibling as HTMLElement
    expect(split.textContent).toBe('Equally between 3 people')
    expect(await screen.findByText(/^Alice: paid .*90\.00, for them .*30\.00$/)).toBeTruthy()
    expect(screen.getByText(/^Bob: for them .*30\.00$/)).toBeTruthy()
    const group = screen.getByText('Group').nextElementSibling as HTMLElement
    expect(within(group).getByRole('link', { name: 'The flat' }).getAttribute('href')).toBe(
      '/groups/house1',
    )
  })

  it('shows no Split row for an employer entry, or for a stored input without one', async () => {
    mockGroups(acme)
    mockRows()
    getRow.mockResolvedValue(
      row('t1', {
        inputJson: JSON.stringify({ split: { mode: 'equal', personIds: ['pe'] } }),
      }) as never,
    )
    renderAt('/transactions/t1')
    expect(await screen.findByText('Group')).toBeTruthy()
    expect(screen.queryByText('Split')).toBeNull()
    cleanup()
    mockGroups(house)
    mockRows([], [], HOUSEMATES)
    getRow.mockResolvedValue(row('t2', { groupId: 'house1', inputJson: '{"bill":{}}' }) as never)
    renderAt('/transactions/t2')
    expect(await screen.findByText('Group')).toBeTruthy()
    expect(screen.queryByText('Split')).toBeNull()
    cleanup()
    getRow.mockResolvedValue(
      row('t3', { groupId: 'house1', inputJson: '{"split":{"mode":"days"}}' }) as never,
    )
    renderAt('/transactions/t3')
    expect(await screen.findByText('Group')).toBeTruthy()
    expect(screen.queryByText('Split')).toBeNull()
  })

  it.each([
    ['exact', 'By amounts'],
    ['percent', 'By percentages'],
    ['weights', 'By shares'],
  ])('words a %s split “%s”', async (mode, text) => {
    mockGroups(house)
    mockRows([], [], HOUSEMATES)
    getRow.mockResolvedValue(
      row('t4', { groupId: 'house1', inputJson: JSON.stringify({ split: { mode } }) }) as never,
    )
    renderAt('/transactions/t4')
    expect(((await screen.findByText('Split')).nextElementSibling as HTMLElement).textContent).toBe(
      text,
    )
  })

  const shares = [
    { $id: 's1', personId: 'pw', givenCents: 4000, receivedCents: 0 },
    { $id: 's2', personId: 'pe', givenCents: 0, receivedCents: 4000 },
  ]

  it('shows the transaction, its note and who paid, and voids it with a reason', async () => {
    mockGroups(acme)
    mockRows([], shares)
    getRow.mockResolvedValue(row('t1') as never)
    call.mockResolvedValue(
      ok({ transaction: row('t1', { status: 'void', voidReason: 'Twice' }), shares: [] }),
    )
    const { queryClient } = renderAt('/transactions/t1')
    const cancel = vi.spyOn(queryClient, 'cancelQueries')
    expect(await screen.findByRole('heading', { name: 'Supplies' })).toBeTruthy()
    expect(screen.getByText(/^A?\$40\.00$/)).toBeTruthy()
    expect(screen.getByText('From the hardware shop')).toBeTruthy()
    expect(await screen.findByText(/^Sam: paid .*40\.00$/)).toBeTruthy()
    // Long names wrap at 375 px.
    expect(screen.getByText(/^Sam: paid/).className).toContain('break-words')
    expect(screen.getByText(/^Acme: for them .*40\.00$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    expect(await screen.findByText('Say why, for example “Entered twice”.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Reason for voiding'), { target: { value: ' Twice ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/void', {
        reason: 'Twice',
      }),
    )
    expect(await screen.findByText('Void. Reason: Twice')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull()
    // Only the row's own query is cancelled, never its shares under the same prefix.
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['transaction', 't1'], exact: true })
    // So does a long reason.
    expect(screen.getByText('Void. Reason: Twice').className).toContain('break-words')
  })

  it('names a pair group by its other member, with no link (#149)', async () => {
    // The other member (MEMBERS' pe, 'Acme') added the viewer, Sam, so the group's own name is
    // the viewer's.
    mockGroups({ ...acme, type: 'pair', name: 'Sam' } as Groups)
    mockRows()
    getRow.mockResolvedValue(row('t1') as never)
    renderAt('/transactions/t1')
    const group = (await screen.findByText('Group')).nextElementSibling as HTMLElement
    await waitFor(() => expect(group.textContent).toBe('Acme'))
    expect(within(group).queryByRole('link')).toBeNull()
  })

  it('offers Void to a member on a row they added, and refreshes balances, history and calendar', async () => {
    mockGroups(acme, 'member')
    mockRows([], shares)
    getRow.mockResolvedValue(row('t1') as never)
    call.mockResolvedValue(ok({ transaction: row('t1', { status: 'void' }), shares: [] }))
    const { queryClient } = renderAt('/transactions/t1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.change(await screen.findByLabelText('Reason for voiding'), {
      target: { value: 'Twice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['balances', 'g1'] }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history', 'g1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] })
  })

  it('keeps Void focusable while it starts, and starts it once', async () => {
    mockGroups(acme)
    mockRows([], shares)
    getRow.mockResolvedValue(row('t1') as never)
    const { queryClient } = renderAt('/transactions/t1')
    // Held as it starts: once it shows the row as void, the form is gone.
    const cancel = vi.spyOn(queryClient, 'cancelQueries').mockReturnValue(new Promise(() => {}))
    fireEvent.change(await screen.findByLabelText('Reason for voiding'), {
      target: { value: 'Twice' },
    })
    const button = screen.getByRole('button', { name: 'Void' })
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'))
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(fireEvent.submit(button.closest('form') as HTMLFormElement)).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(call).not.toHaveBeenCalled()
  })

  it('shows the note of a stored input the template schema doesn’t model, such as a bill’s', async () => {
    mockGroups(acme)
    mockRows([], shares)
    getRow.mockResolvedValue(
      row('t1', {
        kind: 'bill',
        inputJson: JSON.stringify({
          bill: { status: 'due', dueOn: '2026-11-01' },
          extra: 1,
          note: 'Pay by Friday',
        }),
      }) as never,
    )
    renderAt('/transactions/t1')
    expect(await screen.findByText('Pay by Friday')).toBeTruthy()
  })

  it('shows a shift’s hours and rate, and says the worker earned it', async () => {
    mockGroups(acme)
    mockRows(
      [],
      [
        { $id: 's1', personId: 'pw', givenCents: 12500, receivedCents: 0 },
        { $id: 's2', personId: 'pe', givenCents: 0, receivedCents: 12500 },
      ],
    )
    getRow.mockResolvedValue(
      row('t1', {
        kind: 'shift',
        totalCents: 12500,
        inputJson: JSON.stringify({ shift: { minutes: 330, rateCents: 2500 } }),
      }) as never,
    )
    renderAt('/transactions/t1')
    expect(await screen.findByText(/^5 h 30 min at .*25\.00 an hour$/)).toBeTruthy()
    expect(await screen.findByText(/^Sam: earned .*125\.00$/)).toBeTruthy()
    expect(screen.getByText(/^Acme: owes .*125\.00$/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Who earned it, and who owes it' })).toBeTruthy()
  })

  it.each([
    [480, /^8 h at /],
    [45, /^45 min at /],
  ])('drops a zero part from %i shift minutes', async (minutes, text) => {
    mockGroups(acme)
    mockRows([], [])
    getRow.mockResolvedValue(
      row('t1', {
        kind: 'shift',
        totalCents: 100,
        inputJson: JSON.stringify({ shift: { minutes, rateCents: 2500 } }),
      }) as never,
    )
    renderAt('/transactions/t1')
    expect(await screen.findByText(text)).toBeTruthy()
  })

  it('shows no shift line for a running timer, or for an entry that isn’t a shift', async () => {
    mockGroups(acme)
    mockRows([], shares)
    const input = JSON.stringify({ shift: { minutes: 0, rateCents: 2500 } })
    getRow.mockResolvedValue(
      row('t1', { kind: 'shift', status: 'running', inputJson: input }) as never,
    )
    renderAt('/transactions/t1')
    expect(await screen.findByText('Timer running')).toBeTruthy()
    expect(screen.queryByText(/an hour$/)).toBeNull()
    cleanup()
    mockGroups(acme)
    getRow.mockResolvedValue(row('t1', { kind: 'expense', inputJson: input }) as never)
    renderAt('/transactions/t1')
    await screen.findByText('Posted')
    expect(screen.queryByText(/an hour$/)).toBeNull()
  })

  it('reloads the row and the group when a void is refused because it was locked meanwhile', async () => {
    mockGroups(acme)
    mockRows([], shares)
    getRow.mockResolvedValue(row('t1') as never)
    call.mockResolvedValue({ ok: false, error: { code: 'LOCKED', message: 'It’s locked.' } })
    const { queryClient } = renderAt('/transactions/t1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.change(await screen.findByLabelText('Reason for voiding'), {
      target: { value: 'Twice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    expect(await screen.findByText('It’s locked.')).toBeTruthy()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transaction', 't1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['group', 'g1'] })
  })

  it('says “received” for the person a payment went to', async () => {
    mockGroups(acme)
    mockRows(
      [],
      [
        { $id: 's1', personId: 'pe', givenCents: 50000, receivedCents: 0 },
        { $id: 's2', personId: 'pw', givenCents: 0, receivedCents: 50000 },
      ],
    )
    getRow.mockResolvedValue(row('t1', { kind: 'payment', totalCents: 50000 }) as never)
    renderAt('/transactions/t1')
    expect(await screen.findByText(/^Sam: received .*500\.00$/)).toBeTruthy()
    expect(screen.getByText(/^Acme: paid .*500\.00$/)).toBeTruthy()
  })

  it('words an adjustment’s shares as the change to each balance (#400)', async () => {
    mockGroups(acme)
    mockRows(
      [],
      [
        { $id: 's1', personId: 'pe', givenCents: 0, receivedCents: 1250 },
        { $id: 's2', personId: 'pw', givenCents: 1250, receivedCents: 0 },
      ],
    )
    getRow.mockResolvedValue(row('t1', { kind: 'adjustment', totalCents: 1250 }) as never)
    renderAt('/transactions/t1')
    expect(await screen.findByRole('heading', { name: 'Whose balance it changes' })).toBeTruthy()
    expect(screen.getByText(/^Sam: is owed .*12\.50 more$/)).toBeTruthy()
    expect(screen.getByText(/^Acme: owes .*12\.50 more$/)).toBeTruthy()
  })

  it('puts the row back, with the error and the reason, when voiding fails', async () => {
    mockGroups(acme)
    mockRows([], shares)
    getRow.mockResolvedValue(row('t1') as never)
    let reject!: (value: Result<unknown>) => void
    call.mockReturnValue(
      new Promise((r) => {
        reject = r
      }),
    )
    renderAt('/transactions/t1')
    fireEvent.change(await screen.findByLabelText('Reason for voiding'), {
      target: { value: 'Twice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    expect(await screen.findByText('Void. Reason: Twice')).toBeTruthy()
    // Not LOCKED or ARCHIVED, which reload the row anyway: this shows the rollback itself.
    await act(async () =>
      reject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong.' } }),
    )
    expect(await screen.findByText('Something went wrong.')).toBeTruthy()
    expect(screen.getByText('Posted')).toBeTruthy()
    expect((screen.getByLabelText('Reason for voiding') as HTMLInputElement).value).toBe('Twice')
  })

  it('offers receipts only on a row that can still change (#162)', async () => {
    const archived = { ...acme, archivedAt: '2026-10-01T00:00:00.000Z' }
    const cases: [Partial<Transactions>, boolean, Groups, Members['role']][] = [
      [{}, true, acme, 'admin'],
      [{ statementId: 'st1' }, false, acme, 'admin'],
      [{ status: 'void' }, false, acme, 'admin'],
      [{ status: 'running', kind: 'shift' }, false, acme, 'admin'],
      [{}, false, archived, 'admin'],
      [{}, false, acme, 'viewer'],
      [{ createdBy: 'pe' }, false, acme, 'member'],
    ]
    for (const [extra, offered, group, role] of cases) {
      mockGroups(group, role)
      mockRows([], shares)
      getRow.mockResolvedValue(row('t1', extra) as never)
      renderAt('/transactions/t1')
      expect(await screen.findByRole('heading', { name: 'Supplies' })).toBeTruthy()
      await screen.findByText('Group')
      // This test's user isn't verified, so an offer is the prompt to verify.
      expect(Boolean(screen.queryByText('Verify your email to add receipts.'))).toBe(offered)
      cleanup()
    }
  })

  it('has no Void in an archived group, on a final invoice or divide, for a viewer, or for another member’s row', async () => {
    const cases: [Groups, Members['role'], Partial<Transactions>, string | null][] = [
      [
        { ...acme, archivedAt: '2026-10-01T00:00:00.000Z' },
        'admin',
        {},
        'This group is archived. You can see its history but not change it.',
      ],
      [acme, 'admin', { statementId: 'st1' }, 'It’s on a final invoice, so it can’t be changed.'],
      // A house's final statement is a divide (#545).
      [house, 'admin', { statementId: 'st1' }, 'It’s on a final divide, so it can’t be changed.'],
      [acme, 'viewer', {}, null],
      [acme, 'member', { createdBy: 'pe' }, null],
    ]
    for (const [group, role, extra, notice] of cases) {
      mockGroups(group, role)
      mockRows([], shares)
      getRow.mockResolvedValue(row('t1', extra) as never)
      renderAt('/transactions/t1')
      expect(await screen.findByRole('heading', { name: 'Supplies' })).toBeTruthy()
      await screen.findByText('Posted')
      if (notice) expect(screen.getByText(notice)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Void' })).toBeNull()
      cleanup()
    }
  })

  it('lists an itemised expense’s items in order, and says so in the Split row', async () => {
    mockPersonId = 'alice'
    mockGroups(house)
    const everyone = ['alice', 'bob', 'cara']
    const stored = [
      { name: 'Milk', amountCents: 400, split: { mode: 'equal', personIds: everyone } },
      { name: 'Beer', amountCents: 2000, split: { mode: 'equal', personIds: ['bob'] } },
      {
        name: 'Wine',
        amountCents: 3000,
        split: {
          mode: 'weights',
          weights: [
            { personId: 'alice', weight: 2 },
            { personId: 'bob', weight: 1 },
          ],
        },
      },
      { name: 'Discount', amountCents: -200, split: { mode: 'equal', personIds: everyone } },
    ]
    mockRows(
      [],
      [],
      HOUSEMATES,
      stored.map((item, position) => ({
        $id: `i${position}`,
        position,
        name: item.name,
        amountCents: item.amountCents,
        splitJson: JSON.stringify(item.split),
      })),
    )
    getRow.mockResolvedValue(
      row('t9', {
        groupId: 'house1',
        description: 'Groceries',
        totalCents: 5200,
        // As the ledger stores it: items are rows of their own, never in inputJson.
        inputJson: JSON.stringify({ payers: [{ personId: 'bob', cents: 5200 }] }),
      }) as never,
    )
    renderAt('/transactions/t9')
    const split = (await screen.findByText('Split')).nextElementSibling as HTMLElement
    expect(split.textContent).toBe('Itemised (4 items)')
    const items = await screen.findByRole('region', { name: 'Items' })
    await waitFor(() =>
      expect(
        within(items)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        expect.stringMatching(/^Milk: .*4\.00, for Alice, Bob and Cara$/),
        expect.stringMatching(/^Beer: .*20\.00, for Bob$/),
        expect.stringMatching(/^Wine: .*30\.00, by shares, for Alice and Bob$/),
        expect.stringMatching(/^Discount: -.*2\.00, for Alice, Bob and Cara$/),
      ]),
    )
    const query = listCalls().find((call) => call.tableId === 'items')?.queries
    expect(query).toEqual([
      Query.equal('transactionId', 't9'),
      Query.orderAsc('position'),
      Query.limit(100),
    ])
  })

  it('shows no Items for an expense without item rows, and keeps its split', async () => {
    mockGroups(house)
    mockRows([], [], HOUSEMATES)
    getRow.mockResolvedValue(
      row('t9', {
        groupId: 'house1',
        inputJson: JSON.stringify({ split: { mode: 'equal', personIds: ['alice'] } }),
      }) as never,
    )
    renderAt('/transactions/t9')
    const split = (await screen.findByText('Split')).nextElementSibling as HTMLElement
    await waitFor(() => expect(listCalls().some((call) => call.tableId === 'items')).toBe(true))
    expect(split.textContent).toBe('Equally between 1 person')
    expect(screen.queryByRole('region', { name: 'Items' })).toBeNull()
  })

  it('reads the items of a bill too', async () => {
    mockGroups(house)
    mockRows([], [], HOUSEMATES, [
      { $id: 'i0', position: 0, name: 'Line rental', amountCents: 6000, splitJson: '{}' },
    ])
    getRow.mockResolvedValue(row('t9', { groupId: 'house1', kind: 'bill' }) as never)
    renderAt('/transactions/t9')
    const items = await screen.findByRole('region', { name: 'Items' })
    expect(within(items).getByRole('listitem').textContent).toMatch(/^Line rental: .*60\.00$/)
  })

  it.each(['shift', 'payment', 'loan'] as const)('reads no items for a %s', async (kind) => {
    mockGroups(acme)
    mockRows()
    getRow.mockResolvedValue(row('t1', { kind }) as never)
    renderAt('/transactions/t1')
    expect(await screen.findByText('Group')).toBeTruthy()
    await act(async () => {})
    expect(listCalls().some((call) => call.tableId === 'items')).toBe(false)
  })

  it('says so when the items can’t be read', async () => {
    mockGroups(house)
    mockRows([], [], HOUSEMATES)
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
      if (tableId === 'items') throw new Error('offline')
      return { total: 0, rows: tableId === 'members' ? HOUSEMATES : [] }
    }) as never)
    getRow.mockResolvedValue(row('t9', { groupId: 'house1' }) as never)
    renderAt('/transactions/t9')
    expect(
      await screen.findByText(
        'We couldn’t load this expense’s items. Reload the page to try again.',
      ),
    ).toBeTruthy()
  })
})

describe('TransactionPage, personal income and expense (#402)', () => {
  const income = row('t1', {
    groupId: 'me1',
    kind: 'income',
    description: 'Refund',
    category: null,
    totalCents: 1999,
    inputJson: '{}',
  })
  // The ledger's share for it: the owner gives and gets the total (ledger.md#transaction-kinds).
  const mine = [{ $id: 's1', personId: 'pw', givenCents: 1999, receivedCents: 1999 }]

  it('shows it without a who-paid list, and links the personal history', async () => {
    mockGroups(personal)
    mockRows([], mine, ME)
    getRow.mockResolvedValue(income as never)
    const { queryClient } = renderAt('/transactions/t1')
    const group = (await screen.findByText('Group')).nextElementSibling as HTMLElement
    expect(within(group).getByRole('link', { name: 'Personal' }).getAttribute('href')).toBe(
      '/transactions?groupId=me1',
    )
    expect(screen.getByText('Income')).toBeTruthy()
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(queryClient.getQueryData(['transaction', 't1', 'shares'])).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Who paid, and who it was for' })).toBeNull()
    expect(screen.queryByText(/^Sam: paid/)).toBeNull()
  })

  it('voids it with a reason, as other kinds', async () => {
    mockGroups(personal)
    mockRows([], mine, ME)
    getRow.mockResolvedValue(income as never)
    call.mockResolvedValue(
      ok({ transaction: { ...income, status: 'void', voidReason: 'Twice' }, shares: [] }),
    )
    const { queryClient } = renderAt('/transactions/t1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.change(await screen.findByLabelText('Reason for voiding'), {
      target: { value: 'Twice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/t1/void', {
        reason: 'Twice',
      }),
    )
    expect(await screen.findByText('Void. Reason: Twice')).toBeTruthy()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history', 'me1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['balances', 'me1'] })
  })
})
