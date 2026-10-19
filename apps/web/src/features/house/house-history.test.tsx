import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Query } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { HISTORY_PAGE } from '../transactions/use-transactions'
import { HouseHistory } from './house-history'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))

const listRows = vi.mocked(tablesDB.listRows)

const HOUSE = { $id: 'g1', type: 'house', name: 'Flat', currency: 'AUD' } as Groups
const MEMBERS = [
  { personId: 'alice', displayName: 'Alice' },
  { personId: 'bob', displayName: 'Bob' },
  { personId: 'cara', displayName: 'Cara' },
] as Members[]

function row(id: string, extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: id,
    groupId: 'g1',
    kind: 'expense',
    status: 'posted',
    date: '2026-10-18',
    description: `Expense ${id}`,
    totalCents: 4000,
    ...extra,
  } as Transactions
}

type Share = { $id: string; transactionId: string; personId: string }

/** listRows answers transactions page by page, and shares from `payers`. */
function mockRows(pages: Transactions[][], payers: Share[] = []) {
  const queue = [...pages]
  listRows.mockImplementation((async ({
    tableId,
    queries,
  }: {
    tableId: string
    queries: string[]
  }) => {
    if (tableId === 'shares') {
      const ids = (JSON.parse(queries[0] ?? '{}') as { values: string[] }).values
      const rows = payers.filter((share) => ids.includes(share.transactionId))
      return { total: rows.length, rows }
    }
    const rows = queue.shift() ?? []
    return { total: rows.length, rows }
  }) as never)
}

function calls(tableId: string) {
  return listRows.mock.calls
    .map(([params]) => params as unknown as { tableId: string; queries: string[] })
    .filter((params) => params.tableId === tableId)
    .map((params) => params.queries)
}

function renderHistory(canAdd = false) {
  const router = createMemoryRouter(
    [{ path: '/', element: <HouseHistory group={HOUSE} members={MEMBERS} canAdd={canAdd} /> }],
    { initialEntries: ['/'] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Each row's two lines and amount, as read out. */
async function rowTexts() {
  const list = await screen.findByRole('list')
  return within(list)
    .getAllByRole('link')
    .map((link) => link.textContent?.replace(/A?\$/, '$'))
}

const FIRST_PAGE = [
  Query.equal('groupId', 'g1'),
  Query.select(['$id', 'groupId', 'kind', 'status', 'date', 'description', 'totalCents']),
  Query.orderDesc('date'),
  Query.orderDesc('$id'),
  Query.limit(HISTORY_PAGE),
]

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

describe('HouseHistory', () => {
  it.each(['UTC', 'Australia/Sydney'])(
    'shows each transaction with its date, payer, status and amount (device in %s)',
    async (zone) => {
      vi.stubEnv('TZ', zone)
      mockRows(
        [
          [
            row('t4', { kind: 'bill', status: 'due', date: '2026-11-01', description: 'Power' }),
            row('t3', { kind: 'bill', status: 'scheduled', date: '2026-10-25', description: '' }),
            row('t2', { status: 'void', description: 'Milk' }),
            row('t1', { description: 'Groceries', totalCents: 9050 }),
          ],
        ],
        [
          { $id: 's1', transactionId: 't1', personId: 'alice' },
          { $id: 's2', transactionId: 't1', personId: 'bob' },
        ],
      )
      renderHistory()
      await waitFor(async () =>
        expect(await rowTexts()).toEqual([
          expect.stringMatching(/^Power(1 Nov|Nov 1,) 2026 · Due (1 Nov|Nov 1,) 2026\$40\.00$/),
          // No description: the kind's label.
          expect.stringMatching(/^Bill(25 Oct|Oct 25,) 2026 · Scheduled\$40\.00$/),
          expect.stringMatching(/^Milk(18 Oct|Oct 18,) 2026 · Void\$40\.00$/),
          expect.stringMatching(/^Groceries(18 Oct|Oct 18,) 2026 · Paid by Alice and Bob\$90\.50$/),
        ]),
      )
      const links = within(screen.getByRole('list')).getAllByRole('link')
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/transactions/t4',
        '/transactions/t3',
        '/transactions/t2',
        '/transactions/t1',
      ])
    },
  )

  it('reads useHistory’s pages, then the payers of the rows shown', async () => {
    mockRows([[row('t2'), row('t1')]])
    renderHistory()
    await rowTexts()
    expect(calls('transactions')).toEqual([FIRST_PAGE])
    await waitFor(() =>
      expect(calls('shares')).toEqual([
        [
          Query.equal('transactionId', ['t2', 't1']),
          Query.notEqual('givenCents', 0),
          Query.select(['$id', 'transactionId', 'personId']),
          Query.limit(100),
        ],
      ]),
    )
  })

  it('shows more after a full page, and stops after a short one', async () => {
    const full = Array.from({ length: HISTORY_PAGE }, (_, i) => row(`t${100 - i}`))
    mockRows([full, [row('t0')]])
    renderHistory()
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('Expense t0')).toBeTruthy()
    expect(within(screen.getByRole('list')).getAllByRole('link')).toHaveLength(HISTORY_PAGE + 1)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    expect(calls('transactions')[1]).toEqual([
      ...FIRST_PAGE,
      Query.cursorAfter(`t${101 - HISTORY_PAGE}`),
    ])
  })

  it('says when there’s nothing yet, with Add expense for those who can add', async () => {
    mockRows([[]])
    renderHistory(true)
    expect(await screen.findByText(/^No expenses yet\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add expense' }).getAttribute('href')).toBe(
      '/transactions/new?groupId=g1',
    )
    expect(calls('shares')).toEqual([])
  })

  it('offers no Add expense to those who can’t add', async () => {
    mockRows([[]])
    renderHistory(false)
    expect((await screen.findByText(/^No expenses yet\./)).textContent).toBe('No expenses yet.')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('lists three payers as a list in words', async () => {
    mockRows(
      [[row('t1')]],
      ['alice', 'bob', 'cara'].map((personId, i) => ({
        $id: `s${i}`,
        transactionId: 't1',
        personId,
      })),
    )
    renderHistory()
    await waitFor(async () =>
      expect((await rowTexts())[0]).toMatch(/Paid by Alice, Bob,? and Cara/),
    )
  })

  it('reads each page’s payers once, and only that page’s', async () => {
    const full = Array.from({ length: HISTORY_PAGE }, (_, i) => row(`t${100 - i}`))
    mockRows([full, [row('t0')]])
    renderHistory()
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await screen.findByText('Expense t0')
    await waitFor(() => expect(calls('shares')).toHaveLength(2))
    expect(calls('shares')[1]?.[0]).toBe(Query.equal('transactionId', ['t0']))
  })

  it('reads a page’s payers past one read of 100 shares', async () => {
    // A full page of 25 expenses, each paid by all five housemates: 125 payer shares.
    const people = ['alice', 'bob', 'cara', 'dan', 'eve']
    const members = people.map((id) => ({
      personId: id,
      displayName: id.toUpperCase(),
    })) as Members[]
    const page = Array.from({ length: HISTORY_PAGE }, (_, i) =>
      row(`t${String(i).padStart(2, '0')}`),
    )
    const shares = page.flatMap((tx) =>
      people.map((personId) => ({ $id: `${tx.$id}-${personId}`, transactionId: tx.$id, personId })),
    )
    listRows.mockImplementation((async ({
      tableId,
      queries,
    }: {
      tableId: string
      queries: string[]
    }) => {
      if (tableId !== 'shares') return { total: page.length, rows: page }
      // As the database answers: by $id, at most `limit` rows after the cursor.
      const parsed = queries.map(
        (query) => JSON.parse(query) as { method: string; values: unknown[] },
      )
      const limit = parsed.find((query) => query.method === 'limit')?.values[0] as number
      const after = parsed.find((query) => query.method === 'cursorAfter')?.values[0] as
        | string
        | undefined
      const rows = shares
        .filter((share) => after === undefined || share.$id > after)
        .slice(0, limit)
      return { total: shares.length, rows }
    }) as never)
    const router = createMemoryRouter(
      [{ path: '/', element: <HouseHistory group={HOUSE} members={members} canAdd={false} /> }],
      { initialEntries: ['/'] },
    )
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    // The last expense's payers all come from the second read.
    await waitFor(async () =>
      expect((await rowTexts()).at(-1)).toMatch(/Paid by ALICE, BOB, CARA, DAN,? and EVE/),
    )
    expect(calls('shares').map((queries) => queries.at(-1))).toEqual([
      Query.limit(100),
      Query.cursorAfter(shares[99]?.$id as string),
    ])
  })

  it('still lists the rows when the payers can’t be read', async () => {
    mockRows([[row('t1')]])
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
      if (tableId === 'shares') throw new Error('offline')
      return { total: 1, rows: [row('t1')] }
    }) as never)
    renderHistory()
    await waitFor(() => expect(calls('shares')).toHaveLength(1))
    expect(await rowTexts()).toEqual([
      expect.stringMatching(/^Expense t1(18 Oct|Oct 18,) 2026\$40\.00$/),
    ])
    // Every posted row has a payer: say why none shows.
    expect(await screen.findByText('We couldn’t load who paid.')).toBeTruthy()
  })

  it('offers to try again when the history fails to load', async () => {
    listRows.mockRejectedValueOnce(new Error('offline'))
    renderHistory()
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t load the history.')
    mockRows([[row('t1')]])
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Expense t1')).toBeTruthy()
  })
})
