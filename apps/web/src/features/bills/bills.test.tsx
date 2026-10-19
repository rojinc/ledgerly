import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
const getRow = vi.mocked(tablesDB.getRow)
const listRows = vi.mocked(tablesDB.listRows)

// 22:00 UTC on 18 October: already the 19th in Sydney, still the 18th in New York.
const NOW = new Date('2026-10-18T22:00:00.000Z')

const personal = {
  $id: 'g1',
  type: 'personal',
  name: 'Personal',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

function mockGroup(group: Groups = personal) {
  vi.mocked(useGroup).mockReturnValue({ data: group, isError: false } as never)
}

function bill(id: string, extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'bill',
    status: 'due',
    date: '2026-10-25',
    dueOn: '2026-10-25',
    description: 'Phone',
    category: 'phone',
    totalCents: 4550,
    // As the ledger stores it: the status, due date, category and total are columns.
    inputJson: JSON.stringify({ bill: {} }),
    statementId: null,
    voidReason: null,
    createdBy: 'p1',
    ...extra,
  } as Transactions
}

/** listRows answers the due query with `due`, the paid one with `paid`, schedules with `recurring`. */
function mockLists(due: Transactions[], paid: Transactions[] = [], recurring: object[] = []) {
  listRows.mockImplementation((async ({
    tableId,
    queries,
  }: {
    tableId: string
    queries: string[]
  }) => {
    const rows =
      tableId === 'schedules'
        ? recurring
        : queries.includes(Query.equal('status', 'due'))
          ? due
          : paid
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

function view(transaction: Transactions): Result<unknown> {
  return ok({ transaction, shares: [], items: [] })
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
  mockGroup()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('BillsPage', () => {
  it('lists due bills soonest first, saying “Overdue” in words for one due before today', async () => {
    mockLists([
      bill('b1', { date: '2026-10-18', dueOn: '2026-10-18', description: 'Gas' }),
      bill('b2', { description: 'Phone' }),
    ])
    renderAt('/bills')
    const due = within(await screen.findByRole('region', { name: 'Due' }))
    const links = await due.findAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/bills/b1', '/bills/b2'])
    // The 18th is yesterday in Sydney, the group's zone, whatever the browser's.
    expect(links[0]?.textContent).toMatch(/^GasOverdue · was due (18 Oct|Oct 18,) 2026.*45\.50$/)
    expect(links[1]?.textContent).toMatch(/^PhoneDue (25 Oct|Oct 25,) 2026.*45\.50$/)
  })

  it('sorts due bills by their due date', async () => {
    // Listed by date, as the query orders them; the due dates say otherwise.
    mockLists([
      bill('b2', { date: '2026-10-25', dueOn: '2026-10-25', description: 'Phone' }),
      bill('b1', { date: '2026-10-30', dueOn: '2026-10-21', description: 'Late dated' }),
    ])
    renderAt('/bills')
    const due = within(await screen.findByRole('region', { name: 'Due' }))
    const links = await due.findAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/bills/b1', '/bills/b2'])
  })

  it('takes today in the group’s own time zone for “Overdue”', async () => {
    // Still the 18th in New York: a bill due today isn't overdue yet.
    mockGroup({ ...personal, timezone: 'America/New_York' })
    mockLists([bill('b1', { date: '2026-10-18', dueOn: '2026-10-18', description: 'Gas' })])
    renderAt('/bills')
    const due = within(await screen.findByRole('region', { name: 'Due' }))
    expect((await due.findByRole('link')).textContent).toMatch(/^GasDue (18 Oct|Oct 18,) 2026/)
    expect(screen.queryByText(/Overdue/)).toBeNull()
  })

  it('reads due and paid bills on idx_group_status_date, paid ones from 3 months back', async () => {
    mockLists([], [bill('p1', { status: 'posted', date: '2026-10-02', description: 'Rent' })])
    renderAt('/bills')
    const paid = within(await screen.findByRole('region', { name: 'Paid in the last 3 months' }))
    expect((await paid.findByRole('link')).textContent).toMatch(/^RentPaid (2 Oct|Oct 2,) 2026/)
    expect(screen.getByText('Nothing due.')).toBeTruthy()
    const queries = listRows.mock.calls.map(
      ([params]) => (params as unknown as { queries: string[] }).queries,
    )
    expect(queries).toContainEqual([
      Query.equal('groupId', 'g1'),
      Query.equal('status', 'due'),
      Query.equal('kind', 'bill'),
      Query.orderAsc('date'),
      Query.orderAsc('$id'),
      Query.limit(100),
    ])
    expect(queries).toContainEqual([
      Query.equal('groupId', 'g1'),
      Query.equal('status', 'posted'),
      Query.equal('kind', 'bill'),
      Query.greaterThanEqual('date', '2026-07-19'),
      Query.orderDesc('date'),
      Query.orderDesc('$id'),
      Query.limit(100),
    ])
  })

  it('reads every page with a cursor', async () => {
    const page = Array.from({ length: 100 }, (_, index) => bill(`b${index}`))
    listRows.mockImplementation((async ({ queries }: { queries: string[] }) => {
      if (!queries.includes(Query.equal('status', 'due'))) return { total: 0, rows: [] }
      const next = queries.includes(Query.cursorAfter('b99'))
      return next ? { total: 101, rows: [bill('b100')] } : { total: 101, rows: page }
    }) as never)
    renderAt('/bills')
    const due = within(await screen.findByRole('region', { name: 'Due' }))
    await waitFor(() => expect(due.getAllByRole('link')).toHaveLength(101))
  })

  it('links to New bill, and says when the bills can’t be loaded', async () => {
    listRows.mockRejectedValue(new Error('offline'))
    renderAt('/bills')
    expect(screen.getByRole('link', { name: 'New bill' }).getAttribute('href')).toBe('/bills/new')
    expect(await screen.findByText('We couldn’t load the bills that are due.')).toBeTruthy()
    expect(screen.getByText('We couldn’t load the paid bills.')).toBeTruthy()
  })
})

describe('NewBillPage', () => {
  it('sends an unpaid bill as due on its due date, then opens it', async () => {
    call.mockImplementation(async (_fn, _method, _path, body) =>
      view(bill((body as { id: string }).id)),
    )
    getRow.mockResolvedValue(bill('b1') as never)
    const { router } = renderAt('/bills/new')
    // Today in Sydney.
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-10-19')
    type('Description', ' Phone ')
    type('Category', 'phone')
    type('Amount (AUD)', '45.50')
    type('Due date', '2026-10-25')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'POST', '/transactions'])
    expect(sentBody()).toStrictEqual({
      id: sentBody().id,
      groupId: 'g1',
      kind: 'bill',
      description: 'Phone',
      category: 'phone',
      totalCents: 4550,
      date: '2026-10-25',
      bill: { status: 'due', dueOn: '2026-10-25' },
    })
    await waitFor(() => expect(router.state.location.pathname).toBe(`/bills/${sentBody().id}`))
  })

  it('sends a bill already paid as paid, on the day it was paid', async () => {
    call.mockResolvedValue(view(bill('b1', { status: 'posted' })))
    renderAt('/bills/new')
    type('Description', 'Rent')
    type('Amount (AUD)', '400')
    fireEvent.click(screen.getByLabelText('Already paid'))
    expect(screen.queryByLabelText('Due date')).toBeNull()
    type('Paid on', '2026-10-15')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody()).toStrictEqual({
      id: sentBody().id,
      groupId: 'g1',
      kind: 'bill',
      description: 'Rent',
      totalCents: 40000,
      date: '2026-10-15',
      bill: { status: 'paid' },
    })
  })

  it.each([
    ['', 'Required'],
    ['lots', 'Enter an amount like 45.50'],
    ['0', 'Enter an amount above 0'],
  ])('refuses the amount %j inline and sends nothing', async (amount, message) => {
    renderAt('/bills/new')
    type('Description', 'Phone')
    type('Amount (AUD)', amount)
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    expect((await screen.findByText(message)).id).toBe('amount-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('needs a description and a due date', async () => {
    renderAt('/bills/new')
    type('Amount (AUD)', '10')
    type('Due date', '')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    expect((await screen.findAllByText('Required')).map((error) => error.id).sort()).toEqual([
      'description-error',
      'dueOn-error',
    ])
    expect(call).not.toHaveBeenCalled()
  })

  it('retries with the same id after an error', async () => {
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    call.mockImplementationOnce(async (_fn, _method, _path, body) =>
      view(bill((body as { id: string }).id)),
    )
    getRow.mockResolvedValue(bill('b1') as never)
    renderAt('/bills/new')
    type('Description', 'Phone')
    type('Amount (AUD)', '45.50')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(sentBody(1).id).toBe(sentBody(0).id)
  })

  it('opens the bill saved by an earlier try when a retry with changes gets CONFLICT', async () => {
    call.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'A different transaction already has this ID.' },
    })
    getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
      bill(rowId, { description: 'As first sent' })) as never)
    const { router, queryClient } = renderAt('/bills/new')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    type('Description', 'Phone')
    type('Amount (AUD)', '46')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/bills/${sentBody().id}`))
    expect(await screen.findByRole('heading', { level: 1, name: 'As first sent' })).toBeTruthy()
    expect(screen.getByText(/already added by an earlier try/)).toBeTruthy()
    // Shown on this visit only.
    await waitFor(() => expect(router.state.location.state).toBeNull())
    expect(screen.getByText(/already added by an earlier try/)).toBeTruthy()
    // The lost answer's refresh never ran.
    for (const queryKey of [['bills', 'g1'], ['balances', 'g1'], ['history', 'g1'], ['calendar']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey })
    }
  })

  it.each<[string, Partial<Transactions> | 'missing']>([
    ['no row with the ID (a write clash)', 'missing'],
    ['someone else’s row', { createdBy: 'p2' }],
    ['a row that isn’t a bill', { kind: 'expense' }],
  ])('shows the CONFLICT for %s', async (_, found) => {
    call.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Someone else changed this at the same time.' },
    })
    if (found === 'missing') getRow.mockRejectedValue(new Error('not found'))
    else
      getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
        bill(rowId, found)) as never)
    const { router } = renderAt('/bills/new')
    type('Description', 'Phone')
    type('Amount (AUD)', '46')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone else changed this at the same time.',
    )
    expect(router.state.location.pathname).toBe('/bills/new')
  })

  it('keeps Add bill focusable while saving, and ignores a second submit', async () => {
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/bills/new')
    type('Description', 'Phone')
    type('Amount (AUD)', '45.50')
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }))
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving.getAttribute('aria-disabled')).toBe('true')
    expect(saving.hasAttribute('disabled')).toBe(false)
    fireEvent.click(saving)
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('BillPage', () => {
  it('marks a due bill paid on local today in the group’s time zone', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    call.mockResolvedValue(view(bill('b1', { status: 'posted', date: '2026-10-19' })))
    const { queryClient } = renderAt('/bills/b1')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    expect(await screen.findByText(/^Due (25 Oct|Oct 25,) 2026\.$/)).toBeTruthy()
    expect((screen.getByLabelText('Paid on') as HTMLInputElement).value).toBe('2026-10-19')
    const button = screen.getByRole('button', { name: 'Mark paid' })
    button.focus()
    fireEvent.click(button)
    expect(await screen.findByText('Marked paid.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/b1/post', {
      date: '2026-10-19',
    })
    expect(screen.getByText(/^Paid (19 Oct|Oct 19,) 2026\.$/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark paid' })).toBeNull()
    // Its button went: focus is on the heading, not lost.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Phone' }))
    // The lists, balance, history and calendar reload.
    for (const queryKey of [['bills', 'g1'], ['balances', 'g1'], ['history', 'g1'], ['calendar']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey })
    }
  })

  it('marks it paid on another day, and shows the error when it’s refused', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'The date is too far ahead.' },
    })
    renderAt('/bills/b1')
    await screen.findByLabelText('Paid on')
    type('Paid on', '2026-10-17')
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The date is too far ahead.')
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/b1/post', {
      date: '2026-10-17',
    })
    // Read again: it may have been paid meanwhile.
    await waitFor(() => expect(getRow).toHaveBeenCalledTimes(2))
  })

  it('says a bill due before today is overdue', async () => {
    getRow.mockResolvedValue(bill('b1', { date: '2026-10-18', dueOn: '2026-10-18' }) as never)
    renderAt('/bills/b1')
    expect(await screen.findByText(/^Overdue: it was due (18 Oct|Oct 18,) 2026\.$/)).toBeTruthy()
  })

  it('changes a due bill with a PATCH of the same id, keeping it due', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    call.mockResolvedValue(view(bill('b1', { totalCents: 5000, dueOn: '2026-10-28' })))
    renderAt('/bills/b1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change this bill' }))
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('45.50')
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-10-25')
    expect(screen.queryByLabelText('Already paid')).toBeNull()
    type('Amount (AUD)', '50')
    type('Due date', '2026-10-28')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['ledger', 'PATCH', '/transactions/b1'])
    expect(sentBody()).toStrictEqual({
      id: 'b1',
      groupId: 'g1',
      kind: 'bill',
      description: 'Phone',
      category: 'phone',
      totalCents: 5000,
      date: '2026-10-28',
      bill: { status: 'due', dueOn: '2026-10-28' },
    })
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('moves focus to the form’s heading when Change this bill opens it', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    renderAt('/bills/b1')
    const button = await screen.findByRole('button', { name: 'Change this bill' })
    button.focus()
    fireEvent.click(button)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Change this bill' }),
    )
  })

  it('reads the bill again when a change is refused, as it may have been paid meanwhile', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Mark a due bill as paid with “post”.' },
    })
    renderAt('/bills/b1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change this bill' }))
    type('Amount (AUD)', '50')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Mark a due bill as paid/)).toBeTruthy()
    await waitFor(() => expect(getRow).toHaveBeenCalledTimes(2))
  })

  it('keeps the split, note and billing period it doesn’t show when changing a bill', async () => {
    const split = { mode: 'equal', personIds: ['p1'] }
    getRow.mockResolvedValue(
      bill('b1', {
        inputJson: JSON.stringify({
          split,
          note: 'Account 123',
          bill: { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
        }),
      }) as never,
    )
    call.mockResolvedValue(view(bill('b1')))
    renderAt('/bills/b1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change this bill' }))
    type('Description', 'Phone and internet')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(sentBody()).toMatchObject({
      description: 'Phone and internet',
      split,
      note: 'Account 123',
      bill: {
        status: 'due',
        dueOn: '2026-10-25',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      },
    })
  })

  it('moves focus to the heading when the change is cancelled', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    renderAt('/bills/b1')
    fireEvent.click(await screen.findByRole('button', { name: 'Change this bill' }))
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.click(cancel)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Phone' }))
  })

  it('skips a bill with a reason, needing one first', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    call.mockResolvedValue(view(bill('b1', { status: 'void', voidReason: 'Paid by Sam' })))
    renderAt('/bills/b1')
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this bill' }))
    expect(await screen.findByText('Say why, for example “Paid by someone else”.')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    type('Reason for skipping', ' Paid by Sam ')
    fireEvent.click(screen.getByRole('button', { name: 'Skip this bill' }))
    expect(await screen.findByText('Skipped. Reason: Paid by Sam')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('ledger', 'POST', '/transactions/b1/void', {
      reason: 'Paid by Sam',
    })
    expect(screen.queryByRole('button', { name: 'Skip this bill' })).toBeNull()
  })

  it('shows the error and reads the bill again when skipping fails', async () => {
    getRow.mockResolvedValue(bill('b1') as never)
    call.mockResolvedValue({ ok: false, error: { code: 'LOCKED', message: 'It’s locked.' } })
    renderAt('/bills/b1')
    await screen.findByLabelText('Reason for skipping')
    type('Reason for skipping', 'Dup')
    fireEvent.click(screen.getByRole('button', { name: 'Skip this bill' }))
    expect((await screen.findByRole('alert')).textContent).toBe('It’s locked.')
    await waitFor(() => expect(getRow).toHaveBeenCalledTimes(2))
  })

  it('offers nothing to do on a paid bill', async () => {
    getRow.mockResolvedValue(bill('b1', { status: 'posted', date: '2026-10-15' }) as never)
    renderAt('/bills/b1')
    expect(await screen.findByText(/^Paid (15 Oct|Oct 15,) 2026\.$/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says when the row isn’t a bill, or can’t be loaded', async () => {
    getRow.mockResolvedValue(bill('b1', { kind: 'expense' }) as never)
    renderAt('/bills/b1')
    expect(await screen.findByText('This isn’t a bill.')).toBeTruthy()
    cleanup()
    getRow.mockRejectedValue(new Error('not found'))
    renderAt('/bills/b2')
    expect(
      await screen.findByText('We couldn’t load this bill. Reload the page to try again.'),
    ).toBeTruthy()
  })
})
