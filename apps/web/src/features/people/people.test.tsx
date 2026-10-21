import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
// Whether the viewer's email is verified: some reminder tests view it unverified.
let mockVerified = true
vi.mock('../auth/use-current-user', () => ({
  useCurrentUser: () => ({ data: { $id: 'u1', emailVerification: mockVerified } }),
}))
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
  mockVerified = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  sessionStorage.clear()
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

  it('says which key links them when they sign up later', () => {
    renderAt('/people/new')
    expect(screen.getByText(/can’t be linked to this if they sign up later/)).toBeTruthy()
    type('Email (optional)', 'sam@example.com')
    expect(screen.queryByText(/can’t be linked/)).toBeNull()
    expect(
      screen.getByText(
        'Once they join with this email, they’ll see what you’ve recorded together.',
      ),
    ).toBeTruthy()
    // With both, only one is used.
    type('Mobile number (optional)', '+61 400 000 000')
    expect(
      screen.getByText(
        'Once they join, they’ll see what you’ve recorded together. Only one of them is used: the email, unless only the number already belongs to someone. The other isn’t saved.',
      ),
    ).toBeTruthy()
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

  it('keeps Create focusable while saving, and sends once', async () => {
    call.mockReturnValue(new Promise(() => {}) as never)
    renderAt('/people/new')
    type('Name', 'Sam')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving.getAttribute('aria-disabled')).toBe('true')
    saving.focus()
    expect(document.activeElement).toBe(saving)
    fireEvent.click(saving)
    expect(fireEvent.submit(saving.closest('form') as HTMLFormElement)).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(call).toHaveBeenCalledTimes(1)
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
      expect(input('Note (optional)').tagName).toBe('TEXTAREA')
      type('Note (optional)', 'For the concert\nand the train')
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(await screen.findByText('Added.')).toBeTruthy()
      const body = sent()
      expect(body).toStrictEqual({
        id: body.id,
        groupId: 'g1',
        date: '2026-10-19',
        description: label.startsWith('I lent') ? 'Lent' : 'Borrowed',
        totalCents: 5000,
        note: 'For the concert\nand the train',
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
    const { queryClient } = renderAt('/people/g1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await screen.findByLabelText('Amount (AUD)')
    type('Amount (AUD)', '50')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Try again.')).toBeTruthy()
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.balances('g1') })
    // An earlier try was saved though its answer was lost: show what's stored, and move on.
    call.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: 'Taken.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText(/may already have been saved/)).toBeTruthy()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.balances('g1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history', 'g1'] })
    call.mockResolvedValueOnce(ok({ transaction: row('x2'), shares: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Added.')).toBeTruthy()
    const [first, second, third] = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(second).toBe(first)
    expect(third).not.toBe(first)
  })

  it('keeps focus on Add while saving and after, and sends once', async () => {
    mockGroup(0)
    mockRows()
    let resolve!: (value: Result<unknown>) => void
    call.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    renderAt('/people/g1')
    await screen.findByLabelText('Amount (AUD)')
    type('Amount (AUD)', '50')
    const add = screen.getByRole('button', { name: 'Add' })
    add.focus()
    fireEvent.click(add)
    await waitFor(() => expect(add.getAttribute('aria-disabled')).toBe('true'))
    expect(document.activeElement).toBe(add)
    fireEvent.click(add)
    resolve(ok({ transaction: row('x1'), shares: [] }))
    expect(await screen.findByText('Added.')).toBeTruthy()
    expect(document.activeElement).toBe(add)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('reloads the group when an entry is refused as ARCHIVED', async () => {
    mockGroup(0)
    mockRows()
    call.mockResolvedValue({ ok: false, error: { code: 'ARCHIVED', message: 'Archived.' } })
    const { queryClient } = renderAt('/people/g1')
    queryClient.setQueryData(queryKeys.group('g1'), pair)
    await screen.findByLabelText('Amount (AUD)')
    type('Amount (AUD)', '50')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByRole('alert')
    expect(queryClient.getQueryState(queryKeys.group('g1'))?.isInvalidated).toBe(true)
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

  it('keeps Load more focusable while it loads, and loads the next page once', async () => {
    mockGroup(0)
    const page1 = Array.from({ length: 25 }, (_, i) => row(`t${String(i).padStart(2, '0')}`))
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      if (tableId === 'members') return { total: 2, rows: members() }
      // The next page never answers.
      if (queries.some((q) => q.includes('cursorAfter'))) return new Promise(() => {})
      return { total: page1.length, rows: page1 }
    }) as never)
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    const loading = await screen.findByRole('button', { name: 'Loading…' })
    expect(loading.getAttribute('aria-disabled')).toBe('true')
    loading.focus()
    expect(document.activeElement).toBe(loading)
    fireEvent.click(loading)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const nextPages = listRows.mock.calls.filter(([params]) =>
      (params as unknown as { queries: string[] }).queries.some((q) => q.includes('cursorAfter')),
    )
    expect(nextPages).toHaveLength(1)
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

  it('sorts people by the name shown, not the group’s own name (#147 O11)', async () => {
    mockPersonId = 'p2'
    mockGroup(0)
    // Sam (p2) is in two pairs, each named after Sam by its creator: Zed's and Alex's.
    vi.mocked(useGroups).mockReturnValue({
      data: [
        { ...pair, $id: 'g2', name: 'Sam' },
        { ...pair, $id: 'g1', name: 'Sam' },
      ],
      isError: false,
    } as never)
    const zeds = [
      { ...members('active')[1], $id: 'm3', groupId: 'g2' },
      { ...members()[0], $id: 'm4', groupId: 'g2', personId: 'p3', displayName: 'Zed' },
    ] as Members[]
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      const rows =
        tableId !== 'members'
          ? []
          : queries.some((query) => query.includes('"g2"'))
            ? zeds
            : members('active')
      return { total: rows.length, rows }
    }) as never)
    renderAt('/people')
    await waitFor(() =>
      expect(
        screen.getAllByRole('link', { name: /Alex|Zed/ }).map((link) => link.getAttribute('href')),
      ).toEqual(['/people/g1', '/people/g2']),
    )
  })

  it('says when there’s no one yet', () => {
    vi.mocked(useGroups).mockReturnValue({ data: [], isError: false } as never)
    renderAt('/people')
    expect(screen.getByText(/No one yet/)).toBeTruthy()
  })
})

describe('PairPage: send a reminder (#266)', () => {
  const button = () => screen.queryByRole('button', { name: 'Send a reminder' })
  // The news is in the status region, so it's read out.
  const sentNews = () =>
    waitFor(() =>
      expect(
        screen.getAllByRole('status').some((node) => node.textContent === 'Reminder sent.'),
      ).toBe(true),
    )

  async function openForm() {
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Send a reminder' }))
    const heading = screen.getByRole('heading', { name: 'Remind Sam what they owe' })
    expect(document.activeElement).toBe(heading)
  }

  function refused(code: string, message: string): Result<unknown> {
    return { ok: false, error: { code, message } } as Result<unknown>
  }

  it.each([
    ['nothing is owed', () => mockGroup(0)],
    ['you owe them', () => mockGroup(-5000)],
    ['the group is archived', () => mockGroup(5000, { archivedAt: '2026-10-01T00:00:00.000Z' })],
    ['you’re a viewer', () => mockGroup(5000, {}, 'viewer')],
  ])('isn’t offered when %s', async (_case, setUp) => {
    setUp()
    mockRows()
    renderAt('/people/g1')
    await screen.findByText('History')
    expect(button()).toBeNull()
  })

  it('sends to the address typed, which starts empty, then says so and closes', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(ok({ sentAt: NOW.toISOString() }))
    await openForm()
    const field = input('Their email address')
    expect(field.value).toBe('')
    expect(document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Use an address you added them with.',
    )
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await sentNews()).toBeTruthy()
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/reminders', {
      id: expect.any(String),
      groupId: 'g1',
      email: 'sam@example.com',
    })
    expect(screen.queryByLabelText('Their email address')).toBeNull()
    expect(document.activeElement).toBe(button())
  })

  it('keeps the id across a retry after an error, and makes a new one after a success', async () => {
    mockGroup(5000)
    mockRows()
    call
      .mockResolvedValueOnce(refused('INTERNAL', 'We couldn’t send the reminder. Try again later.'))
      .mockResolvedValueOnce(ok({ sentAt: NOW.toISOString() }))
      .mockResolvedValueOnce(ok({ sentAt: NOW.toISOString() }))
    await openForm()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We couldn’t send the reminder. Try again later.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await sentNews()
    fireEvent.click(screen.getByRole('button', { name: 'Send a reminder' }))
    // A new reminder: the last one's news goes.
    expect(screen.queryByText('Reminder sent.')).toBeNull()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3))
    const ids = call.mock.calls.map(([, , , body]) => (body as { id: string }).id)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('keeps the id after an error when the form is closed and opened again', async () => {
    mockGroup(5000)
    mockRows()
    call
      .mockResolvedValueOnce(refused('INTERNAL', 'We couldn’t send the reminder. Try again later.'))
      .mockResolvedValueOnce(ok({ sentAt: NOW.toISOString() }))
    await openForm()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send a reminder' }))
    // A fresh form, but the same reminder: the first may have been saved though it wasn't sent.
    expect(screen.queryByRole('alert')).toBeNull()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await sentNews()
    const ids = call.mock.calls.map(([, , , body]) => (body as { id: string }).id)
    expect(ids).toEqual([ids[0], ids[0]])
  })

  it.each([
    ['sessionStorage', () => {}],
    [
      'memory, where storage is blocked',
      () => {
        for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
          vi.spyOn(Storage.prototype, method).mockImplementation(() => {
            throw new DOMException('Blocked', 'SecurityError')
          })
        }
      },
    ],
  ])(
    'keeps the id after an error when the page is left and opened again (%s)',
    async (_where, storage) => {
      storage()
      mockGroup(5000)
      mockRows()
      call
        .mockResolvedValueOnce(
          refused('INTERNAL', 'We couldn’t send the reminder. Try again later.'),
        )
        .mockResolvedValueOnce(ok({ sentAt: NOW.toISOString() }))
        .mockResolvedValueOnce(ok({ sentAt: NOW.toISOString() }))
      const send = async () => {
        await openForm()
        type('Their email address', 'sam@example.com')
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      }
      await send()
      await screen.findByRole('alert')
      // Away and back (or a reload): the section unmounts, and the reminder is still unsent.
      cleanup()
      await send()
      await sentNews()
      // Sent, so the next one is a new reminder.
      cleanup()
      await send()
      await waitFor(() => expect(call).toHaveBeenCalledTimes(3))
      const ids = call.mock.calls.map(([, , , body]) => (body as { id: string }).id)
      expect(ids[1]).toBe(ids[0])
      expect(ids[2]).not.toBe(ids[0])
    },
  )

  it('clears the last error when Send is pressed again', async () => {
    mockGroup(5000)
    mockRows()
    const answers: ((result: Result<unknown>) => void)[] = []
    call.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    await openForm()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // The form checks the address first, so the call starts a moment after the click.
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0]?.(refused('VALIDATION_FAILED', 'Use an address you added them with.'))
    await waitFor(() =>
      expect(input('Their email address').getAttribute('aria-invalid')).toBe('true'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Sending…' })
    expect(input('Their email address').getAttribute('aria-invalid')).not.toBe('true')
    answers[1]?.(refused('INTERNAL', 'Something went wrong.'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Sending…' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    [
      'RATE_LIMITED',
      'Too many reminders.',
      'alert',
      'You’ve sent a reminder recently. Try again in a few days.',
    ],
    ['INTERNAL', 'Something went wrong.', 'alert', 'Something went wrong.'],
    ['ARCHIVED', 'This group is archived.', 'alert', 'This group is archived.'],
    [
      'VALIDATION_FAILED',
      "That isn't an address this group has for them. Use one you added them with.",
      'field',
      "That isn't an address this group has for them. Use one you added them with.",
    ],
  ])('shows %s, and keeps the form open', async (code, message, where, shown) => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(refused(code, message))
    await openForm()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    if (where === 'alert') {
      expect((await screen.findByRole('alert')).textContent).toMatch(shown)
    } else {
      await waitFor(() =>
        expect(input('Their email address').getAttribute('aria-invalid')).toBe('true'),
      )
      expect(document.getElementById('reminderEmail-error')?.textContent).toBe(shown)
      expect(document.activeElement).toBe(input('Their email address'))
    }
    expect(screen.getByLabelText('Their email address')).toBeTruthy()
    expect(screen.queryByText('Reminder sent.')).toBeNull()
  })

  it('checks the address before sending, and sends once while busy', async () => {
    mockGroup(5000)
    mockRows()
    let answer!: (result: Result<unknown>) => void
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // The form checks the address a moment after the click.
    await waitFor(() =>
      expect(document.getElementById('reminderEmail-error')?.textContent).toBe(
        'Enter their email address',
      ),
    )
    expect(document.activeElement).toBe(input('Their email address'))
    type('Their email address', 'sam')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(document.getElementById('reminderEmail-error')?.textContent).toBe(
        'Enter an email address like name@example.com',
      ),
    )
    expect(call).not.toHaveBeenCalled()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const busy = await screen.findByRole('button', { name: 'Sending…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(busy)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(cancel)
    expect(call).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Their email address')).toBeTruthy()
    answer(ok({ sentAt: NOW.toISOString() }))
    await sentNews()
    // A second send would start a moment after its click, so count again once it's all done.
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('treats an address of only spaces as empty', async () => {
    mockGroup(5000)
    mockRows()
    await openForm()
    type('Their email address', '   ')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(document.getElementById('reminderEmail-error')?.textContent).toBe(
        'Enter their email address',
      ),
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('reloads the group when the reminder is refused as ARCHIVED', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue({ ok: false, error: { code: 'ARCHIVED', message: 'Archived.' } })
    const { queryClient } = renderAt('/people/g1')
    const reload = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('button', { name: 'Send a reminder' }))
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('alert')
    expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.group('g1') })
  })

  it('asks an unverified sender to verify their email when refused as FORBIDDEN', async () => {
    mockVerified = false
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(refused('FORBIDDEN', 'Verify your email address first.'))
    await openForm()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^Verify your email address before sending reminders\. .*banner at the top of the page/,
    )
  })

  it('shows why, and reloads the group and role, when a verified sender is refused as FORBIDDEN', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(refused('FORBIDDEN', 'Your role in this group can’t do this.'))
    const { queryClient } = renderAt('/people/g1')
    const reload = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('button', { name: 'Send a reminder' }))
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your role in this group can’t do this.',
    )
    expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.group('g1') })
    expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.myMember('g1', 'p1') })
  })

  it('reloads the balance when the address is refused', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(refused('VALIDATION_FAILED', 'Nothing is owed to you in this group.'))
    const { queryClient } = renderAt('/people/g1')
    const reload = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('button', { name: 'Send a reminder' }))
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.balances('g1') }))
  })

  it('is offered to a member too', async () => {
    mockGroup(5000, {}, 'member')
    mockRows()
    renderAt('/people/g1')
    expect(await screen.findByRole('button', { name: 'Send a reminder' })).toBeTruthy()
  })

  it('starts fresh on another pair’s page', async () => {
    mockGroup(5000)
    mockRows()
    call.mockResolvedValue(ok({ sentAt: NOW.toISOString() }))
    // g2 first, so its rows are cached and going back to it shows it at once, without loading.
    mockGroup(5000, { $id: 'g2' })
    const { router } = renderAt('/people/g2')
    await screen.findByRole('button', { name: 'Send a reminder' })
    mockGroup(5000)
    await act(() => router.navigate('/people/g1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Send a reminder' }))
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await sentNews()
    mockGroup(5000, { $id: 'g2' })
    await act(() => router.navigate('/people/g2'))
    expect(screen.queryByText('Reminder sent.')).toBeNull()
  })

  it('closes on Cancel, with focus back on the button', async () => {
    mockGroup(5000)
    mockRows()
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Their email address')).toBeNull()
    expect(document.activeElement).toBe(button())
  })
})

describe('PairPage: settings (#403)', () => {
  const settings = () => screen.queryByRole('region', { name: 'Settings' })

  function refused(code: string, message: string): Result<unknown> {
    return { ok: false, error: { code, message } } as Result<unknown>
  }

  it('lets the creator rename them, and the group with them, then shows the new name', async () => {
    mockGroup(0)
    mockRows()
    call.mockImplementation((async (_fn: string, _method: string, path: string) => {
      if (path === '/groups/g1') return ok({ ...pair, name: 'Samantha' })
      mockRows(
        [],
        members().map((one) => (one.$id === 'm2' ? { ...one, displayName: 'Samantha' } : one)),
      )
      return ok({ ...members()[1], displayName: 'Samantha' })
    }) as never)
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change their name' }))
    expect(document.activeElement).toBe(input('Their name'))
    expect(input('Their name').value).toBe('Sam')
    // One form at a time.
    expect(screen.queryByRole('button', { name: 'Invite by email' })).toBeNull()
    type('Their name', 'Samantha')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Samantha' })).toBeTruthy()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls.map((one) => one.slice(0, 4))).toEqual([
      ['groups', 'PATCH', '/groups/g1/members/m2', { displayName: 'Samantha' }],
      // The group's own name is the creator's label for Sam, which invite emails use.
      ['groups', 'PATCH', '/groups/g1', { name: 'Samantha' }],
    ])
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Change their name' }),
      ),
    )
  })

  it('lets the other person rename the creator, leaving the group’s name, the creator’s label', async () => {
    mockPersonId = 'p2'
    mockGroup(0)
    mockRows([], members('active'))
    call.mockResolvedValue(ok({ ...members()[0], displayName: 'Alexandra' }))
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change their name' }))
    expect(input('Their name').value).toBe('Alex')
    type('Their name', 'Alexandra')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Their name')).toBeNull())
    expect(call.mock.calls.map((one) => one.slice(0, 4))).toEqual([
      ['groups', 'PATCH', '/groups/g1/members/m1', { displayName: 'Alexandra' }],
    ])
  })

  it('sends only the group’s rename again after it alone failed', async () => {
    mockGroup(0)
    mockRows()
    call.mockImplementation((async (_fn: string, _method: string, path: string) => {
      if (path === '/groups/g1') return refused('CONFLICT', 'Someone else changed this. Try again.')
      mockRows(
        [],
        members().map((one) => (one.$id === 'm2' ? { ...one, displayName: 'Samantha' } : one)),
      )
      return ok({ ...members()[1], displayName: 'Samantha' })
    }) as never)
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change their name' }))
    type('Their name', 'Samantha')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone else changed this. Try again.',
    )
    await screen.findByRole('heading', { level: 1, name: 'Samantha' })
    call.mockClear()
    call.mockResolvedValue(ok({ ...pair, name: 'Samantha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Their name')).toBeNull())
    expect(call.mock.calls.map((one) => one.slice(0, 4))).toEqual([
      ['groups', 'PATCH', '/groups/g1', { name: 'Samantha' }],
    ])
  })

  it('sends nothing when the name is unchanged, or empty', async () => {
    mockGroup(0)
    mockRows()
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change their name' }))
    type('Their name', '')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(document.getElementById(`${input('Their name').id}-error`)?.textContent).toBe(
        'Required',
      ),
    )
    // Trimmed, it's the name they have.
    type('Their name', 'Sam ')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Their name')).toBeNull())
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the form with the refusal, and Cancel waits for a save under way', async () => {
    mockGroup(0)
    mockRows()
    let answer: (result: Result<unknown>) => void = () => {}
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change their name' }))
    type('Their name', 'Samantha')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Saving…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('Their name')).toBeTruthy()
    answer(refused('FORBIDDEN', 'Your role in this group can’t do this.'))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your role in this group can’t do this.',
    )
    expect(call).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Their name')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change their name' }))
  })

  it('invites them by email while they haven’t joined', async () => {
    mockGroup(0)
    mockRows()
    const SENT = { sentAt: NOW.toISOString(), expiresAt: '2026-11-01T22:00:00.000Z' }
    call.mockResolvedValue(ok(SENT))
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Invite by email' }))
    expect(screen.getByRole('form', { name: 'Invite Sam by email' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Change their name' })).toBeNull()
    type('Their email address', 'sam@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const news = `Invite sent. It expires on ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(SENT.expiresAt))}.`
    expect(await screen.findByText(news)).toBeTruthy()
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/invites', {
      groupId: 'g1',
      memberId: 'm2',
      email: 'sam@example.com',
    })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Invite by email' }))
    // A new invite: the last one's news goes.
    fireEvent.click(screen.getByRole('button', { name: 'Invite by email' }))
    expect(screen.queryByText(news)).toBeNull()
  })

  it('offers no invite once they’ve joined', async () => {
    mockGroup(0)
    mockRows([], members('active'))
    renderAt('/people/g1')
    expect(await screen.findByRole('button', { name: 'Change their name' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite by email' })).toBeNull()
  })

  it('focuses the heading when a refusal shows the pair was archived meanwhile', async () => {
    mockGroup(0)
    mockRows()
    call.mockImplementation((async () => {
      // The other person archived it: the refusal's reload brings the pair as it is now (rows
      // changed since, so the page reads the mocked group again).
      mockGroup(0, { archivedAt: '2026-10-18T21:00:00.000Z' })
      mockRows(
        [],
        members().map((one) => ({ ...one, $updatedAt: '2026-10-18T21:00:00.000Z' })),
      )
      return refused('ARCHIVED', 'This group is archived, so it can no longer be changed.')
    }) as never)
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change their name' }))
    type('Their name', 'Samantha')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(settings()).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('leaves focus alone when the page opens with Settings', async () => {
    mockGroup(0)
    mockRows()
    renderAt('/people/g1')
    expect(await screen.findByRole('region', { name: 'Settings' })).toBeTruthy()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone when Settings appear as the role loads', async () => {
    // As in the app: the caller's role arrives after the page's first render.
    mockGroup(0)
    vi.mocked(useMyMember).mockReturnValue({ data: undefined, isError: false } as never)
    mockRows()
    const { queryClient } = renderAt('/people/g1')
    await screen.findByText('Loading…')
    vi.mocked(useMyMember).mockReturnValue({ data: { role: 'admin' }, isError: false } as never)
    // A refetch with changed rows re-renders the page, which reads the role again.
    mockRows(
      [],
      members().map((one) => ({ ...one, $updatedAt: '2026-10-18T21:00:00.000Z' })),
    )
    await queryClient.invalidateQueries({ queryKey: queryKeys.members('g1') })
    expect(await screen.findByRole('region', { name: 'Settings' })).toBeTruthy()
    expect(document.activeElement).toBe(document.body)
  })

  it('sends focus to Change their name when Sam joined while the invite was open', async () => {
    mockGroup(0)
    mockRows()
    const { queryClient } = renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Invite by email' }))
    mockRows([], members('active'))
    await queryClient.invalidateQueries({ queryKey: queryKeys.members('g1') })
    await waitFor(() => expect(screen.queryByText('Not joined yet')).toBeNull())
    // The form stays for them to finish with.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Invite by email' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change their name' }))
  })

  it('names the pair by Sam in the archive dialog, and by Alex for Sam', async () => {
    const { showModal, close } = HTMLDialogElement.prototype
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open')
    }
    try {
      // The group's own name is Alex's label for Sam: Sam mustn't be asked to archive "Sam".
      mockPersonId = 'p2'
      mockGroup(0)
      mockRows([], members('active'))
      renderAt('/people/g1')
      const region = await screen.findByRole('region', { name: 'Archive group' })
      fireEvent.click(within(region).getByRole('button', { name: 'Archive group' }))
      const dialog = screen.getByRole('alertdialog')
      expect(within(dialog).getByText('Archive Alex?')).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    } finally {
      Object.assign(HTMLDialogElement.prototype, { showModal, close })
    }
  })

  it('archives the pair, then focuses the heading', async () => {
    const { showModal, close } = HTMLDialogElement.prototype
    // jsdom has no modal dialogs (employer-form.test.tsx has the full stand-in).
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open')
    }
    try {
      mockGroup(0)
      mockRows()
      call.mockResolvedValue(ok({ ...pair, archivedAt: '2026-10-18T22:00:00.000Z' }))
      renderAt('/people/g1')
      const region = await screen.findByRole('region', { name: 'Archive group' })
      fireEvent.click(within(region).getByRole('button', { name: 'Archive group' }))
      expect(within(screen.getByRole('alertdialog')).getByText('Archive Sam?')).toBeTruthy()
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive group' }),
      )
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })),
      )
      expect(call).toHaveBeenCalledWith('groups', 'POST', '/groups/g1/archive')
    } finally {
      Object.assign(HTMLDialogElement.prototype, { showModal, close })
    }
  })

  it.each([
    ['to a viewer', () => mockGroup(0, {}, 'viewer')],
    ['to a member', () => mockGroup(0, {}, 'member')],
    ['in an archived pair', () => mockGroup(0, { archivedAt: '2026-10-01T00:00:00.000Z' })],
  ])('isn’t offered %s', async (_case, setUp) => {
    setUp()
    mockRows()
    renderAt('/people/g1')
    await screen.findByText('History')
    expect(settings()).toBeNull()
    expect(screen.queryByRole('region', { name: 'Archive group' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Invite by email' })).toBeNull()
  })
})

describe('PairPage: unarchive (#428)', () => {
  // jsdom has no modal dialogs (employer-form.test.tsx has the full stand-in).
  const { showModal, close } = HTMLDialogElement.prototype
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open')
    }
  })
  afterEach(() => {
    // An open dialog closes as it unmounts: before the stand-ins go.
    cleanup()
    Object.assign(HTMLDialogElement.prototype, { showModal, close })
  })

  const ARCHIVED = { archivedAt: '2026-10-01T00:00:00.000Z' }

  it('is offered next to the archived notice, to an admin only', async () => {
    mockGroup(0, ARCHIVED)
    mockRows()
    renderAt('/people/g1')
    const notice = await screen.findByText(/This group is archived/)
    expect(notice.nextElementSibling?.textContent).toBe('Unarchive group')
    cleanup()
    for (const role of ['member', 'viewer'] as const) {
      mockGroup(0, ARCHIVED, role)
      mockRows()
      renderAt('/people/g1')
      await screen.findByText(/This group is archived/)
      expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
      cleanup()
    }
    // Not in a pair that isn't archived.
    mockGroup(0)
    mockRows()
    renderAt('/people/g1')
    await screen.findByRole('region', { name: 'Settings' })
    expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
  })

  it('offers Delete group, never Unarchive, to the one left once no admin has joined (#486)', async () => {
    // Sam made the pair, made Alex a member, then deleted their account: Sam's row is kept, `left`.
    const sam = { ...members()[1], role: 'viewer', status: 'left' } as Members
    mockGroup(0, ARCHIVED, 'member')
    mockRows([], [{ ...members()[0], role: 'member' } as Members, sam])
    renderAt('/people/g1')
    const link = await screen.findByRole('link', { name: 'Delete group' })
    expect(link.getAttribute('href')).toBe('/groups/g1/delete')
    // The reason is read out with the link.
    const why = document.getElementById(link.getAttribute('aria-describedby') ?? '')
    expect(why?.textContent).toBe('This group has no admin any more, so you can delete it.')
    expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
    cleanup()
    // Sam is still an admin who has joined: nothing for Alex.
    mockGroup(0, ARCHIVED, 'member')
    mockRows([], [{ ...members()[0], role: 'member' } as Members, members('active')[1] as Members])
    renderAt('/people/g1')
    await screen.findByText(/This group is archived/)
    expect(screen.queryByRole('link', { name: 'Delete group' })).toBeNull()
  })

  it('names the pair by the other person, unarchives it, says so and focuses the heading', async () => {
    mockGroup(0, ARCHIVED)
    mockRows()
    call.mockImplementation((async () => {
      // The page reads the group as it is now: writable.
      mockGroup(0)
      return ok(pair)
    }) as never)
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive group' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Unarchive Sam?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unarchive group' }))
    expect(
      await screen.findByText('This group is unarchived, so it can be changed again.'),
    ).toBeTruthy()
    expect(call).toHaveBeenCalledWith('groups', 'POST', '/groups/g1/unarchive')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
    // Still said once the pair reads as unarchived.
    expect(screen.getByText('This group is unarchived, so it can be changed again.')).toBeTruthy()
  })

  it('shows the function’s refusal in the dialog', async () => {
    mockGroup(0, ARCHIVED)
    mockRows()
    call.mockResolvedValue({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Your role in this group can’t do this.' },
    })
    renderAt('/people/g1')
    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive group' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unarchive group' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Your role in this group can’t do this.',
    )
    expect(screen.getByText(/This group is archived/)).toBeTruthy()
  })
})
