import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useBalances, useGroup, useGroups, useMyMember } from '../groups/use-groups'
import { useProfile } from '../profile/use-profile'
import { peopleRoutes } from './routes'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
// The viewer's person: the lender (p1) by default; some tests view as Sam (p2).
let mockPersonId = 'p1'
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: mockPersonId } }),
}))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn() }))
vi.mock('../groups/use-groups', () => ({
  useGroups: vi.fn(),
  useGroup: vi.fn(),
  useMyMember: vi.fn(),
  useBalances: vi.fn(),
}))

const listRows = vi.mocked(tablesDB.listRows)
const call = vi.mocked(callFunction)

// 22:00 UTC on 18 October: already the 19th in Sydney.
const NOW = new Date('2026-10-18T22:00:00.000Z')

const pair = {
  $id: 'g1',
  type: 'pair',
  name: 'Sam',
  ownerPersonId: 'p1',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

function members(samStatus: Members['status'] = 'placeholder'): Members[] {
  return [
    {
      $id: 'm1',
      groupId: 'g1',
      personId: 'p1',
      displayName: 'Alex',
      role: 'admin',
      status: 'active',
    },
    {
      $id: 'm2',
      groupId: 'g1',
      personId: 'p2',
      displayName: 'Sam',
      role: 'admin',
      status: samStatus,
    },
  ] as Members[]
}

function row(id: string, extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'loan',
    status: 'posted',
    date: '2026-10-10',
    description: 'Lent',
    totalCents: 5000,
    createdBy: 'p1',
    ...extra,
  } as Transactions
}

/** The group and its balance: `net` is Alex's (p1); Sam's is the opposite. */
function mockGroup(net: number, extra: Partial<Groups> = {}, role: Members['role'] = 'admin') {
  const group = { ...pair, ...extra }
  vi.mocked(useGroups).mockReturnValue({ data: [group], isError: false } as never)
  vi.mocked(useGroup).mockReturnValue({ data: group, isError: false } as never)
  vi.mocked(useMyMember).mockReturnValue({ data: { role }, isError: false } as never)
  vi.mocked(useBalances).mockReturnValue({
    data: {
      people: [
        { personId: 'p1', netCents: net },
        { personId: 'p2', netCents: -net },
      ],
      transfers: [],
    },
    isError: false,
  } as never)
}

/** listRows answers members with `memberRows` and transactions with `history`. */
function mockRows(history: Transactions[] = [], memberRows = members()) {
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    const rows = tableId === 'members' ? memberRows : history
    return { total: rows.length, rows }
  }) as never)
}

function renderAt(path: string) {
  const router = createMemoryRouter([peopleRoutes, { path: '*', element: null }], {
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

function input(label: string | RegExp) {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** The body of the only ledger call. */
function sent() {
  expect(call).toHaveBeenCalledTimes(1)
  return call.mock.calls[0]?.[3] as Record<string, unknown> & { id: string }
}

beforeEach(() => {
  mockPersonId = 'p1'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('NewPairPage', () => {
  beforeEach(() => {
    vi.mocked(useProfile).mockReturnValue({ data: { currency: 'AUD' }, isError: false } as never)
  })

  it('creates a pair group with the counterpart, then opens it', async () => {
    call.mockResolvedValue(ok({ group: { ...pair, $id: 'new1' }, members: [] }))
    const { router, queryClient } = renderAt('/people/new')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    expect(input('Currency').value).toBe('AUD')
    type('Name', ' Sam ')
    type('Mobile number (optional)', '+61 400 000 000')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/people/new1'))
    const body = sent()
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['groups', 'POST', '/groups'])
    expect(body).toStrictEqual({
      id: body.id,
      type: 'pair',
      name: 'Sam',
      currency: 'AUD',
      counterpart: { displayName: 'Sam', phone: '+61 400 000 000' },
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
  })

  it('says a person with no email or phone can’t be linked later', () => {
    renderAt('/people/new')
    expect(screen.getByText(/can’t be linked to this if they sign up later/)).toBeTruthy()
    type('Email (optional)', 'sam@example.com')
    expect(screen.queryByText(/can’t be linked/)).toBeNull()
  })

  it('shows errors inline and sends nothing', async () => {
    renderAt('/people/new')
    type('Email (optional)', 'not an email')
    type('Currency', 'dollars')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(screen.getByText('Enter an email like sam@example.com')).toBeTruthy()
    expect(screen.getByText('Enter a 3-letter code like AUD')).toBeTruthy()
    expect(input('Name').getAttribute('aria-invalid')).toBe('true')
    expect(call).not.toHaveBeenCalled()
  })

  it('retries with the same id after an error', async () => {
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    renderAt('/people/new')
    type('Name', 'Sam')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Try again.')).toBeTruthy()
    call.mockResolvedValueOnce(ok({ group: pair, members: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const [first, second] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).toBe(first)
  })
})

describe('PairPage', () => {
  it.each([
    ['p1', 5000, /^Sam owes you .*50\.00$/],
    ['p2', 5000, /^You owe Alex .*50\.00$/],
    ['p1', -2000, /^You owe Sam .*20\.00$/],
    ['p2', -2000, /^Alex owes you .*20\.00$/],
    ['p1', 0, /^All square$/],
  ])('words the balance from %s’s side (Alex’s net %i)', async (viewer, net, text) => {
    mockPersonId = viewer
    mockGroup(net)
    mockRows([], members('active'))
    renderAt('/people/g1')
    const balance = await screen.findByRole('region', { name: 'Balance' })
    expect(within(balance).getByText(text)).toBeTruthy()
    expect(useBalances).toHaveBeenCalledWith('g1')
  })

  it('labels a counterpart who hasn’t joined', async () => {
    mockGroup(0)
    mockRows()
    renderAt('/people/g1')
    expect(await screen.findByText('Not joined yet')).toBeTruthy()
  })

  it('doesn’t label one who has joined', async () => {
    mockGroup(0)
    mockRows([], members('active'))
    renderAt('/people/g1')
    await screen.findByRole('region', { name: 'Balance' })
    expect(screen.queryByText('Not joined yet')).toBeNull()
  })

  it.each([
    ['I lent Sam money', 'p1', 'p2'],
    ['I borrowed from Sam', 'p2', 'p1'],
  ])(
    'sends “%s” as a loan, dated today in the group’s time zone',
    async (label, lender, borrower) => {
      mockGroup(0)
      mockRows()
      call.mockResolvedValue(ok({ transaction: row('x1'), shares: [] }))
      renderAt('/people/g1')
      fireEvent.click(await screen.findByLabelText(label))
      expect(input('Date').value).toBe('2026-10-19')
      type('Amount (AUD)', '50')
      type('Note (optional)', 'For the concert')
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(await screen.findByText('Added.')).toBeTruthy()
      const body = sent()
      expect(body).toStrictEqual({
        id: body.id,
        groupId: 'g1',
        date: '2026-10-19',
        description: label.startsWith('I lent') ? 'Lent' : 'Borrowed',
        totalCents: 5000,
        note: 'For the concert',
        kind: 'loan',
        payers: [{ personId: lender, cents: 5000 }],
        split: { mode: 'equal', personIds: [borrower] },
      })
      // Ready for the next one, with a new id.
      expect(input('Amount (AUD)').value).toBe('')
      call.mockClear()
      type('Amount (AUD)', '5')
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(sent().id).not.toBe(body.id)
    },
  )

  it('prefills a repayment from the balance: the one who owes pays it all', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(ok({ transaction: row('x1', { kind: 'payment' }), shares: [] }))
    renderAt('/people/g1')
    fireEvent.click(await screen.findByLabelText('Money was paid back'))
    expect(input('Who paid back?').value).toBe('them')
    expect(input('Amount (AUD)').value).toBe('50.00')
    // A part repayment.
    type('Amount (AUD)', '30')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Added.')
    const body = sent()
    expect(body).toStrictEqual({
      id: body.id,
      groupId: 'g1',
      date: '2026-10-19',
      description: 'Repaid',
      totalCents: 3000,
      kind: 'payment',
      payment: { fromPersonId: 'p2', toPersonId: 'p1' },
    })
    expect(body).not.toHaveProperty('payers')
  })

  it('prefills the user repaying when they owe, and follows a changed direction', async () => {
    mockGroup(-2000)
    mockRows()
    renderAt('/people/g1')
    fireEvent.click(await screen.findByLabelText('Money was paid back'))
    expect(input('Who paid back?').value).toBe('me')
    expect(input('Amount (AUD)').value).toBe('20.00')
    type('Who paid back?', 'them')
    // Sam owes nothing, so there's nothing to prefill.
    expect(input('Amount (AUD)').value).toBe('')
  })

  it('warns, without refusing, when a repayment is more than what’s owed', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(ok({ transaction: row('x1', { kind: 'payment' }), shares: [] }))
    renderAt('/people/g1')
    fireEvent.click(await screen.findByLabelText('Money was paid back'))
    expect(screen.queryByText(/more than/)).toBeNull()
    type('Amount (AUD)', '60')
    expect(screen.getByText(/^That’s more than Sam owes you \(.*50\.00\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Added.')
    expect(sent().totalCents).toBe(6000)
  })

  it('retries an entry with the same id, and warns rather than duplicating on CONFLICT', async () => {
    mockGroup(0)
    mockRows()
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    renderAt('/people/g1')
    await screen.findByLabelText('Amount (AUD)')
    type('Amount (AUD)', '50')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Try again.')).toBeTruthy()
    call.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: 'Taken.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText(/may already have been saved/)).toBeTruthy()
    const [first, second] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).toBe(first)
  })

  it('says when nothing is owed the way a repayment goes', async () => {
    mockGroup(0)
    mockRows()
    renderAt('/people/g1')
    fireEvent.click(await screen.findByLabelText('Money was paid back'))
    type('Amount (AUD)', '10')
    expect(screen.getByText(/^Nothing is owed that way right now/)).toBeTruthy()
  })

  it('offers a retry when the balance can’t be read', async () => {
    mockGroup(0)
    const refetch = vi.fn()
    vi.mocked(useBalances).mockReturnValue({ data: undefined, isError: true, refetch } as never)
    mockRows()
    renderAt('/people/g1')
    const balance = await screen.findByRole('region', { name: 'Balance' })
    expect(within(balance).getByText('Not available yet')).toBeTruthy()
    fireEvent.click(within(balance).getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  it('refuses a missing or bad amount inline and sends nothing', async () => {
    mockGroup(0)
    mockRows()
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    type('Amount (AUD)', '12.345')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Enter an amount like 40.50')).toBeTruthy()
    expect(input('Amount (AUD)').getAttribute('aria-describedby')).toContain('amount-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('lists the history newest first on idx_group_date, each linking to its page', async () => {
    mockGroup(5000)
    mockRows([
      row('t2', { kind: 'payment', description: 'Repaid', date: '2026-10-12', totalCents: 1000 }),
      row('t1', { status: 'void', voidReason: 'Typo' }),
    ])
    renderAt('/people/g1')
    const history = await screen.findByRole('region', { name: 'History' })
    const links = within(history).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/transactions/t2',
      '/transactions/t1',
    ])
    expect(links[0]?.textContent).toMatch(/Repaid.*2026-10-12 · Payment · Posted.*10\.00$/)
    expect(links[1]?.textContent).toMatch(/Lent.*Loan · Void/)
    const queries = listRows.mock.calls
      .map(([params]) => params as unknown as { tableId: string; queries: string[] })
      .find((params) => params.tableId === 'transactions')?.queries
    expect(queries).toEqual(
      expect.arrayContaining([Query.equal('groupId', 'g1'), Query.orderDesc('date')]),
    )
  })

  it('shows no form in an archived group, or to a viewer', async () => {
    mockGroup(0, { archivedAt: '2026-10-01T00:00:00.000Z' })
    mockRows()
    renderAt('/people/g1')
    await screen.findByRole('region', { name: 'Balance' })
    expect(screen.getByText(/archived/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    cleanup()
    mockGroup(0, {}, 'viewer')
    renderAt('/people/g1')
    await screen.findByRole('region', { name: 'Balance' })
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  it('says when the group isn’t a lend & borrow one', async () => {
    mockGroup(0, { type: 'employer' })
    mockRows()
    renderAt('/people/g1')
    expect(await screen.findByText('This isn’t a lend & borrow group.')).toBeTruthy()
  })
})

describe('PeoplePage', () => {
  it('lists only pair groups, each named for the other person, with the balance', async () => {
    mockPersonId = 'p2'
    mockGroup(5000)
    vi.mocked(useGroups).mockReturnValue({
      data: [pair, { ...pair, $id: 'g9', type: 'employer', name: 'Acme' }],
      isError: false,
    } as never)
    mockRows([], members('active'))
    renderAt('/people')
    const link = await screen.findByRole('link', { name: /You owe Alex/ })
    expect(link.getAttribute('href')).toBe('/people/g1')
    // Sam sees Alex, not the name Alex gave the group.
    await waitFor(() => expect(link.textContent).toMatch(/^Alex/))
    expect(screen.queryByText('Acme')).toBeNull()
    expect(screen.getByRole('link', { name: 'New lend & borrow' }).getAttribute('href')).toBe(
      '/people/new',
    )
  })

  it('waits for the viewer’s person before naming the other one or the balance', async () => {
    mockPersonId = ''
    mockGroup(5000)
    mockRows([], members('active'))
    renderAt('/people')
    expect(await screen.findByText('Loading balance')).toBeTruthy()
    await waitFor(() => expect(listRows).toHaveBeenCalled())
    expect(screen.queryByText(/owes|owe|All square/)).toBeNull()
    expect(screen.queryByText('Alex')).toBeNull()
  })

  it('says when there’s no one yet', () => {
    vi.mocked(useGroups).mockReturnValue({ data: [], isError: false } as never)
    renderAt('/people')
    expect(screen.getByText(/No one yet/)).toBeTruthy()
  })
})
