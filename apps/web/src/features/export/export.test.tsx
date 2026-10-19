import type { Groups, Profiles } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Query } from 'appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroups } from '../groups/use-groups'
import { usePerson, useProfile } from '../profile/use-profile'
import { download } from './export-data'
import { ExportPage } from './export-page'

vi.mock('../../lib/appwrite', () => ({ DATABASE_ID: 'main', tablesDB: { listRows: vi.fn() } }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn(), usePerson: vi.fn() }))
// Pair names have their own tests (#145): here a group is shown by its name.
vi.mock('../groups/use-group-name', () => ({
  useGroupName: (group: Groups) => group.name,
  useSortedByName: (groups: Groups[]) => [...groups].sort((a, b) => a.name.localeCompare(b.name)),
}))
vi.mock('./export-data', async (original) => ({
  ...(await original<typeof import('./export-data')>()),
  download: vi.fn(),
}))

const listRows = vi.mocked(tablesDB.listRows)
const saved = vi.mocked(download)

// Sunday 25 October in UTC, already Monday the 26th in Sydney.
const NOW = new Date('2026-10-25T13:30:00.000Z')

function group(id: string, name: string, extra: Partial<Groups> = {}): Groups {
  return {
    $id: id,
    name,
    type: 'house',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    archivedAt: null,
    ...extra,
  } as Groups
}

const flat = group('g1', 'Flat 2/14')
const cafe = group('g2', 'Acme Cafe', {
  type: 'employer',
  timezone: 'America/Los_Angeles',
  archivedAt: '2026-09-01T00:00:00.000Z',
})

const transaction = (id: string, extra: object = {}) => ({
  $id: id,
  groupId: 'g1',
  date: '2026-10-05',
  status: 'posted',
  kind: 'expense',
  description: 'Groceries',
  category: 'groceries',
  totalCents: 4505,
  ...extra,
})

type Params = { tableId: string; queries: string[] }

/** listRows answers each table with its rows, filtered by an `equal` on IDs where asked. */
function mockTables(tables: Record<string, object[]>) {
  listRows.mockImplementation((async ({ tableId }: Params) => {
    const rows = tables[tableId] ?? []
    return { total: rows.length, rows }
  }) as never)
}

function calls(): Params[] {
  return listRows.mock.calls.map(([params]) => params as unknown as Params)
}

/** The lines of the CSV saved as `name`. */
function savedLines(name: string): string[] {
  const csv = saved.mock.calls.find(([file]) => file === name)?.[1] ?? ''
  return csv.slice(1, -2).split('\r\n')
}

const profile = {
  $id: 'u1',
  personId: 'p1',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  currency: 'AUD',
  businessJson: JSON.stringify({ businessName: 'Sam Lee Cleaning' }),
  invoicePrefix: 'INV-',
  lastInvoiceNumber: 3,
  summaryFrequency: 'none',
  nextSummaryAt: null,
  hoursCapMinutes: null,
  hoursCapPeriod: null,
  hoursCapStartsOn: null,
} as Profiles

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ExportPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(useCurrentUser).mockReturnValue({
    data: { $id: 'u1', email: 'sam@example.com', phone: '' },
  } as never)
  vi.mocked(useGroups).mockReturnValue({ data: [flat, cafe] } as never)
  vi.mocked(useProfile).mockReturnValue({ data: profile } as never)
  vi.mocked(usePerson).mockReturnValue({ data: { displayName: 'Sam Lee' } } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('ExportPage: a group’s records', () => {
  it('downloads the group’s CSV for this year so far, in the group’s zone', async () => {
    mockTables({
      transactions: [transaction('t1'), transaction('t2', { status: 'void', totalCents: 990 })],
      shares: [
        { transactionId: 't1', personId: 'p1', givenCents: 4505, receivedCents: 2253 },
        { transactionId: 't1', personId: 'p2', givenCents: 0, receivedCents: 2252 },
      ],
      members: [
        { personId: 'p1', displayName: 'Sam' },
        { personId: 'p2', displayName: 'Alex' },
      ],
    })
    renderPage()
    // Sorted by name; archived groups can be exported too.
    const select = screen.getByLabelText('Group') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Acme Cafe (archived)',
      'Flat 2/14',
    ])
    fireEvent.change(select, { target: { value: 'g1' } })
    // Monday the 26th in Sydney.
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-01-01')
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-26')
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(
      await screen.findByText('Downloaded flat-2-14-2026-01-01-to-2026-10-26.csv.'),
    ).toBeTruthy()
    expect(calls()).toEqual([
      {
        databaseId: 'main',
        tableId: 'transactions',
        queries: [
          Query.equal('groupId', 'g1'),
          Query.greaterThanEqual('date', '2026-01-01'),
          Query.lessThanEqual('date', '2026-10-26'),
          Query.orderAsc('date'),
          Query.limit(100),
        ],
      },
      {
        databaseId: 'main',
        tableId: 'shares',
        queries: [Query.equal('transactionId', ['t1', 't2']), Query.limit(100)],
      },
      {
        databaseId: 'main',
        tableId: 'members',
        queries: [Query.equal('groupId', 'g1'), Query.limit(100)],
      },
    ])
    expect(savedLines('flat-2-14-2026-01-01-to-2026-10-26.csv')).toEqual([
      'date,status,kind,description,category,currency,total,person,given,received,net',
      '2026-10-05,posted,expense,Groceries,groceries,AUD,45.05,Sam,45.05,22.53,22.52',
      '2026-10-05,posted,expense,Groceries,groceries,AUD,45.05,Alex,0.00,22.52,-22.52',
      '2026-10-05,void,expense,Groceries,groceries,AUD,9.90,,,,',
    ])
  })

  it('uses the dates typed, in the first group by default', async () => {
    mockTables({})
    renderPage()
    // Acme Cafe sorts first: still the 25th in Los Angeles.
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-25')
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByText('Downloaded acme-cafe-2026-09-01-to-2026-09-30.csv.')
    expect(calls()[0]?.queries).toEqual([
      Query.equal('groupId', 'g2'),
      Query.greaterThanEqual('date', '2026-09-01'),
      Query.lessThanEqual('date', '2026-09-30'),
      Query.orderAsc('date'),
      Query.limit(100),
    ])
    // No transactions: no shares to read.
    expect(calls().map((params) => params.tableId)).toEqual(['transactions', 'members'])
  })

  it.each([
    ['2026-10-02', '2026-10-01', 'The start must be on or before the end'],
    ['', '2026-10-01', 'Enter both dates'],
  ])('refuses %j to %j and reads nothing', (from, to, message) => {
    renderPage()
    fireEvent.change(screen.getByLabelText('From'), { target: { value: from } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: to } })
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByLabelText('From').getAttribute('aria-invalid')).toBe('true')
    expect(listRows).not.toHaveBeenCalled()
  })

  it('reads every page, and the shares 100 transactions at a time', async () => {
    const many = Array.from({ length: 150 }, (_, index) => transaction(`t${index}`))
    listRows.mockImplementation((async ({ tableId, queries }: Params) => {
      if (tableId !== 'transactions') return { total: 0, rows: [] }
      const after = queries.some((query) => query.includes('cursorAfter'))
      const rows = after ? many.slice(100) : many.slice(0, 100)
      return { total: rows.length, rows }
    }) as never)
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByText(/^Downloaded/)
    const transactionCalls = calls().filter((params) => params.tableId === 'transactions')
    expect(transactionCalls[1]?.queries).toContain(Query.cursorAfter('t99'))
    const shareCalls = calls().filter((params) => params.tableId === 'shares')
    expect(shareCalls.map((params) => params.queries[0])).toEqual([
      Query.equal(
        'transactionId',
        many.slice(0, 100).map((row) => row.$id),
      ),
      Query.equal(
        'transactionId',
        many.slice(100).map((row) => row.$id),
      ),
    ])
  })

  it('says when the file can’t be made, and makes one file at a time', async () => {
    let fail!: (error: Error) => void
    listRows.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    const busy = await screen.findByRole('button', { name: 'Making the file…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(busy)
    expect(listRows).toHaveBeenCalledTimes(1)
    await act(async () => fail(new Error('offline')))
    expect(screen.getByRole('alert').textContent).toBe(
      'We couldn’t make the file. Check your connection and try again.',
    )
    expect(saved).not.toHaveBeenCalled()
  })
})

describe('ExportPage: your data', () => {
  it('downloads profile.csv and my-records.csv, with only your own shares', async () => {
    mockTables({
      shares: [
        { groupId: 'g1', transactionId: 't1', personId: 'p1', givenCents: 0, receivedCents: 2253 },
        // A group no longer in the list (left on their own): left out.
        { groupId: 'g9', transactionId: 't9', personId: 'p1', givenCents: 5, receivedCents: 0 },
      ],
      transactions: [transaction('t1'), transaction('t9', { groupId: 'g9' })],
    })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }))
    expect(await screen.findByText('Downloaded profile.csv and my-records.csv.')).toBeTruthy()
    expect(calls()).toEqual([
      {
        databaseId: 'main',
        tableId: 'shares',
        queries: [Query.equal('personId', 'p1'), Query.orderAsc('date'), Query.limit(100)],
      },
      {
        databaseId: 'main',
        tableId: 'transactions',
        queries: [Query.equal('$id', ['t1', 't9']), Query.limit(100)],
      },
    ])
    expect(savedLines('my-records.csv')).toEqual([
      'group,groupType,date,kind,description,category,currency,total,given,received,net',
      'Flat 2/14,house,2026-10-05,expense,Groceries,groceries,AUD,45.05,0.00,22.53,-22.53',
    ])
    expect(savedLines('profile.csv')).toEqual([
      'field,value',
      'name,Sam Lee',
      'email,sam@example.com',
      'timezone,Australia/Sydney',
      'region,AU-NSW',
      'currency,AUD',
      'invoicePrefix,INV-',
      'lastInvoiceNumber,3',
      'summaryFrequency,none',
      'business.businessName,Sam Lee Cleaning',
    ])
  })

  it('leaves out business details that don’t read', async () => {
    vi.mocked(useProfile).mockReturnValue({ data: { ...profile, businessJson: '{' } } as never)
    mockTables({})
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }))
    await screen.findByText(/^Downloaded profile/)
    expect(savedLines('profile.csv').some((line) => line.startsWith('business.'))).toBe(false)
  })

  it('waits for the profile, and says when the files can’t be made', async () => {
    vi.mocked(usePerson).mockReturnValue({ data: undefined } as never)
    renderPage()
    const button = screen.getByRole('button', { name: 'Download my data' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(listRows).not.toHaveBeenCalled()
    cleanup()
    vi.mocked(usePerson).mockReturnValue({ data: { displayName: 'Sam Lee' } } as never)
    listRows.mockRejectedValue(new Error('offline'))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We couldn’t make the files. Check your connection and try again.',
    )
    expect(saved).not.toHaveBeenCalled()
  })
})

describe('ExportPage: groups', () => {
  it('says so when the groups can’t be loaded, and still offers your data', () => {
    vi.mocked(useGroups).mockReturnValue({ data: undefined, isError: true } as never)
    renderPage()
    expect(screen.getByRole('alert').textContent).toBe(
      'We couldn’t load your groups. Reload the page to try again.',
    )
    expect(screen.queryByLabelText('Group')).toBeNull()
    expect(screen.getByRole('button', { name: 'Download my data' })).toBeTruthy()
  })
})

describe('download', () => {
  it('saves the CSV through a link, without uploading it', async () => {
    const real = await vi.importActual<typeof import('./export-data')>('./export-data')
    const created = vi.fn(() => 'blob:x')
    const revoked = vi.fn()
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.useRealTimers()
    real.download('a.csv', 'x')
    expect(click).toHaveBeenCalledTimes(1)
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe('a.csv')
    expect(link.href).toBe('blob:x')
    await waitFor(() => expect(revoked).toHaveBeenCalledWith('blob:x'))
  })
})
