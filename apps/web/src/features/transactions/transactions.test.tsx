import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useBalances, useGroup, useGroups, useMyMember } from '../groups/use-groups'
import { transactionRoutes } from './routes'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
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

/** listRows answers members with MEMBERS, shares with `shares`, transactions with `history`. */
function mockRows(history: Transactions[] = [], shares: object[] = []) {
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    const rows = tableId === 'members' ? MEMBERS : tableId === 'shares' ? shares : history
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

describe('HistoryPage', () => {
  it.each([
    [71500, /^Acme owes you .*715\.00$/],
    [-2050, /^You owe Acme .*20\.50$/],
    [0, /^All square$/],
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

describe('TransactionPage', () => {
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

  it('has no Void in an archived group, on a final invoice, for a viewer, or for another member’s row', async () => {
    const cases: [Groups, Members['role'], Partial<Transactions>, string | null][] = [
      [
        { ...acme, archivedAt: '2026-10-01T00:00:00.000Z' },
        'admin',
        {},
        'This group is archived. You can see its history but not change it.',
      ],
      [acme, 'admin', { statementId: 'st1' }, 'It’s on a final invoice, so it can’t be changed.'],
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
})
