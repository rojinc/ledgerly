import type { Groups, Profiles } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException, Query } from 'appwrite'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tablesDB } from '../../lib/appwrite'
import { useCurrentUser } from '../auth/use-current-user'
import { useGroups } from '../groups/use-groups'
import { usePerson, useProfile } from '../profile/use-profile'
import { download, fileUrl } from './export-data'
import { ExportPage, fileName } from './export-page'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn(), usePerson: vi.fn() }))
// Pair names have their own tests (#145): here a group is shown by its name.
vi.mock('../groups/use-group-name', () => ({
  useGroupName: (group: Groups) => (group.type === 'pair' ? 'Alex' : group.name),
  useSortedByName: (groups: Groups[]) => [...groups].sort((a, b) => a.name.localeCompare(b.name)),
}))
vi.mock('./export-data', async (original) => ({
  ...(await original<typeof import('./export-data')>()),
  download: vi.fn(),
  fileUrl: vi.fn(),
}))

const listRows = vi.mocked(tablesDB.listRows)
const getRow = vi.mocked(tablesDB.getRow)
const saved = vi.mocked(download)

// The files the page offered as links, by their `blob:<n>` URL.
let made: string[] = []

const TRANSACTION_COLUMNS = [
  '$id',
  'groupId',
  'date',
  'status',
  'kind',
  'description',
  'category',
  'totalCents',
]
const SHARE_COLUMNS = ['$id', 'transactionId', 'personId', 'groupId', 'givenCents', 'receivedCents']
const MEMBER_COLUMNS = ['$id', 'groupId', 'personId', 'displayName']

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

/** The group's `rev` as each read sees it, then `last` from there on. */
function revs(...seen: string[]) {
  const last = seen.at(-1)
  getRow.mockImplementation((async () => ({ $id: 'g1', rev: seen.shift() ?? last })) as never)
}

/** Appwrite's answer when a cursor's row was deleted between pages. */
const lostCursor = () => new AppwriteException('Cursor not found', 400, 'general_cursor_not_found')

function calls(): Params[] {
  return listRows.mock.calls.map(([params]) => params as unknown as Params)
}

/** The lines of the CSV offered as the link `name`. */
function linkLines(name: string): string[] {
  const href = screen.getByRole('link', { name }).getAttribute('href') ?? ''
  const csv = made[Number(href.replace('blob:', ''))] ?? ''
  return csv.slice(1, -2).split('\r\n')
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

function renderPage({ strict = false } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ExportPage />
    </QueryClientProvider>,
    // The app runs in StrictMode, which mounts each effect twice.
    { wrapper: strict ? StrictMode : undefined },
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
  made = []
  vi.mocked(fileUrl).mockImplementation((csv) => `blob:${made.push(csv) - 1}`)
  Object.assign(URL, { revokeObjectURL: vi.fn() })
  revs('r1')
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
          Query.select(TRANSACTION_COLUMNS),
          Query.orderAsc('date'),
          Query.limit(100),
        ],
      },
      {
        databaseId: 'main',
        tableId: 'shares',
        queries: [
          Query.equal('transactionId', ['t1', 't2']),
          Query.select(SHARE_COLUMNS),
          Query.limit(100),
        ],
      },
      {
        databaseId: 'main',
        tableId: 'members',
        queries: [Query.equal('groupId', 'g1'), Query.select(MEMBER_COLUMNS), Query.limit(100)],
      },
    ])
    // The group's `rev` before and after: the same, so one read.
    expect(getRow.mock.calls).toEqual([
      [
        {
          databaseId: 'main',
          tableId: 'groups',
          rowId: 'g1',
          queries: [Query.select(['$id', 'rev'])],
        },
      ],
      [
        {
          databaseId: 'main',
          tableId: 'groups',
          rowId: 'g1',
          queries: [Query.select(['$id', 'rev'])],
        },
      ],
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
      Query.select(TRANSACTION_COLUMNS),
      Query.orderAsc('date'),
      Query.limit(100),
    ])
    // No transactions: no shares to read.
    expect(calls().map((params) => params.tableId)).toEqual(['transactions', 'members'])
  })

  it.each([
    ['2026-10-02', '2026-10-01', 'From', 'The start must be on or before the end'],
    ['', '2026-10-01', 'From', 'Enter a date'],
    ['2026-10-01', '', 'To', 'Enter a date'],
  ])('refuses %j to %j on %s, and reads nothing', (from, to, field, message) => {
    renderPage()
    fireEvent.change(screen.getByLabelText('From'), { target: { value: from } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: to } })
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    const input = screen.getByLabelText(field)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(document.getElementById(`${input.id}-error`)?.textContent).toBe(message)
    const other = screen.getByLabelText(field === 'From' ? 'To' : 'From')
    expect(other.getAttribute('aria-invalid')).toBe('false')
    expect(listRows).not.toHaveBeenCalled()
  })

  it('focuses From when both dates are wrong, and takes a one-day range', async () => {
    mockTables({})
    renderPage()
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(document.activeElement).toBe(screen.getByLabelText('From'))
    expect(screen.getByLabelText('To').getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByText('Downloaded acme-cafe-2026-10-01-to-2026-10-01.csv.')
  })

  it('reads again when the group changed during the read', async () => {
    revs('r1', 'r2')
    let reads = 0
    listRows.mockImplementation((async ({ tableId }: Params) => {
      if (tableId !== 'transactions') return { total: 0, rows: [] }
      reads += 1
      const rows = [transaction(`t${reads}`, { description: `Read ${reads}` })]
      return { total: 1, rows }
    }) as never)
    renderPage()
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'g1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByText(/^Downloaded/)
    expect(getRow).toHaveBeenCalledTimes(4)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(savedLines('flat-2-14-2026-01-01-to-2026-10-26.csv')[1]).toContain('Read 2')
  })

  it('gives up when the group changes on each of 3 reads', async () => {
    revs('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7')
    mockTables({})
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We couldn’t make the file. Check your connection and try again.',
    )
    expect(getRow).toHaveBeenCalledTimes(6)
    expect(saved).not.toHaveBeenCalled()
  })

  it('reads again from the start when a cursor is lost', async () => {
    const many = Array.from({ length: 101 }, (_, index) => transaction(`t${index}`))
    let lost = false
    listRows.mockImplementation((async ({ tableId, queries }: Params) => {
      if (tableId !== 'transactions') return { total: 0, rows: [] }
      const after = queries.some((query) => query.includes('cursorAfter'))
      if (after && !lost) {
        lost = true
        throw lostCursor()
      }
      const rows = after ? many.slice(100) : many.slice(0, 100)
      return { total: rows.length, rows }
    }) as never)
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByText(/^Downloaded/)
    expect(calls().filter((params) => params.tableId === 'transactions')).toHaveLength(4)
    expect(savedLines('acme-cafe-2026-01-01-to-2026-10-25.csv')).toHaveLength(102)
  })

  it('gives up after 3 lost cursors, and never reads again on other errors', async () => {
    listRows.mockRejectedValue(lostCursor())
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByRole('alert')
    expect(listRows).toHaveBeenCalledTimes(3)
    // A 404 (the group is gone) or another 400 can't be fixed by reading again.
    for (const error of [
      new AppwriteException('Not found', 404, 'row_not_found'),
      new AppwriteException('Bad query', 400, 'general_query_invalid'),
    ]) {
      listRows.mockClear()
      listRows.mockRejectedValue(error)
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
      await waitFor(() => expect(listRows).toHaveBeenCalled())
      await screen.findByRole('button', { name: 'Download CSV' })
      expect(listRows).toHaveBeenCalledTimes(1)
    }
  })

  it('shares one budget of 3 reads between lost cursors and a changing group', async () => {
    revs('r1', 'r2', 'r3', 'r4', 'r5', 'r6')
    let lost = false
    listRows.mockImplementation((async () => {
      if (!lost) {
        lost = true
        throw lostCursor()
      }
      return { total: 0, rows: [] }
    }) as never)
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByRole('alert')
    // One lost cursor, then two reads the group changed under: 3 reads, not 3 of each.
    expect(getRow).toHaveBeenCalledTimes(5)
    expect(saved).not.toHaveBeenCalled()
  })

  it('names the file as the app names the group, a pair by its other member', async () => {
    vi.mocked(useGroups).mockReturnValue({
      data: [group('g3', 'Sam', { type: 'pair' })],
    } as never)
    mockTables({})
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(await screen.findByText('Downloaded alex-2026-01-01-to-2026-10-26.csv.')).toBeTruthy()
    expect(saved.mock.calls[0]?.[0]).toBe('alex-2026-01-01-to-2026-10-26.csv')
  })

  it('reads every page of members past 100', async () => {
    const people = Array.from({ length: 150 }, (_, index) => ({
      $id: `m${index}`,
      personId: `p${index}`,
      displayName: `Person ${index}`,
    }))
    listRows.mockImplementation((async ({ tableId, queries }: Params) => {
      if (tableId !== 'members') return { total: 0, rows: [] }
      const rows = queries.includes(Query.cursorAfter('m99'))
        ? people.slice(100)
        : people.slice(0, 100)
      return { total: rows.length, rows }
    }) as never)
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    await screen.findByText(/^Downloaded/)
    expect(calls().filter((params) => params.tableId === 'members')).toHaveLength(2)
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
    expect(listRows).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe(
      'We couldn’t make the file. Check your connection and try again.',
    )
    expect(saved).not.toHaveBeenCalled()
  })
})

describe('ExportPage: your data', () => {
  it('offers profile.csv and my-records.csv as links, with only your own shares', async () => {
    mockTables({
      shares: [
        { groupId: 'g1', transactionId: 't1', personId: 'p1', givenCents: 0, receivedCents: 2253 },
        // A group no longer in the list (left on their own): left out.
        { groupId: 'g9', transactionId: 't9', personId: 'p1', givenCents: 5, receivedCents: 0 },
      ],
      transactions: [transaction('t1'), transaction('t9', { groupId: 'g9' })],
    })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    const status = await screen.findByText('Your files are ready. Download each one:')
    expect(status.closest('[role="status"]')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'profile.csv' }).getAttribute('download')).toBe(
      'profile.csv',
    )
    expect(calls()).toEqual([
      {
        databaseId: 'main',
        tableId: 'shares',
        queries: [
          Query.equal('personId', 'p1'),
          Query.select(SHARE_COLUMNS),
          Query.orderAsc('date'),
          Query.limit(100),
        ],
      },
      {
        databaseId: 'main',
        tableId: 'transactions',
        queries: [
          Query.equal('$id', ['t1', 't9']),
          Query.select(TRANSACTION_COLUMNS),
          Query.limit(100),
        ],
      },
    ])
    expect(linkLines('my-records.csv')).toEqual([
      'group,groupType,date,kind,description,category,currency,total,given,received,net',
      'Flat 2/14,house,2026-10-05,expense,Groceries,groceries,AUD,45.05,0.00,22.53,-22.53',
    ])
    expect(linkLines('profile.csv')).toEqual([
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
    expect(saved).not.toHaveBeenCalled()
  })

  it('names a pair group by its other member, as the app does', async () => {
    vi.mocked(useGroups).mockReturnValue({
      data: [group('g3', 'Sam', { type: 'pair' }), flat],
    } as never)
    mockTables({
      shares: [
        { groupId: 'g3', transactionId: 't1', personId: 'p1', givenCents: 0, receivedCents: 100 },
      ],
      transactions: [transaction('t1', { groupId: 'g3' })],
      // The user's own row last: their own name must never win.
      members: [
        { groupId: 'g3', personId: 'p2', displayName: 'Alex' },
        { groupId: 'g3', personId: 'p1', displayName: 'Sam' },
      ],
    })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await screen.findByText('Your files are ready. Download each one:')
    expect(calls().at(-1)?.queries).toEqual([
      Query.equal('groupId', ['g3']),
      Query.select(MEMBER_COLUMNS),
      Query.limit(100),
    ])
    expect(linkLines('my-records.csv')[1]).toMatch(/^Alex,pair,/)
  })

  it.each([
    ['that don’t parse', '{'],
    ['that the schema refuses', JSON.stringify({ abn: '1' })],
    ['that aren’t there', null],
  ])('leaves out business details %s', async (_case, businessJson) => {
    vi.mocked(useProfile).mockReturnValue({ data: { ...profile, businessJson } } as never)
    mockTables({})
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await screen.findByText('Your files are ready. Download each one:')
    expect(linkLines('profile.csv').some((line) => line.startsWith('business.'))).toBe(false)
  })

  it('lets go of the last files when new ones are made', async () => {
    mockTables({})
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await screen.findByText('Your files are ready. Download each one:')
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:0'))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
    await screen.findByText('Your files are ready. Download each one:')
    expect(screen.getByRole('link', { name: 'profile.csv' }).getAttribute('href')).toBe('blob:2')
  })

  it('reads your shares again when a cursor is lost', async () => {
    const shares = Array.from({ length: 101 }, (_, index) => ({
      $id: `s${index}`,
      transactionId: 't1',
      personId: 'p1',
      groupId: 'g1',
      givenCents: 100,
      receivedCents: 0,
    }))
    let lost = false
    listRows.mockImplementation((async ({ tableId, queries }: Params) => {
      if (tableId === 'transactions') return { total: 1, rows: [transaction('t1')] }
      if (tableId !== 'shares') return { total: 0, rows: [] }
      const after = queries.some((query) => query.includes('cursorAfter'))
      if (after && !lost) {
        lost = true
        throw lostCursor()
      }
      const rows = after ? shares.slice(100) : shares.slice(0, 100)
      return { total: rows.length, rows }
    }) as never)
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await screen.findByText('Your files are ready. Download each one:')
    expect(calls().filter((params) => params.tableId === 'shares')).toHaveLength(4)
    expect(linkLines('my-records.csv')).toHaveLength(102)
  })

  it('gives up on your shares after 3 lost cursors', async () => {
    listRows.mockRejectedValue(lostCursor())
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We couldn’t make the files. Check your connection and try again.',
    )
    expect(listRows).toHaveBeenCalledTimes(3)
  })

  it('makes no files once the page is left', async () => {
    let finish!: (value: unknown) => void
    listRows.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)) as never)
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await waitFor(() => expect(listRows).toHaveBeenCalledTimes(1))
    cleanup()
    await act(async () => finish({ total: 0, rows: [] }))
    expect(fileUrl).not.toHaveBeenCalled()
  })

  it('makes the files in StrictMode, as the app runs', async () => {
    mockTables({})
    renderPage({ strict: true })
    fireEvent.click(screen.getByRole('button', { name: 'Make my files' }))
    await screen.findByText('Your files are ready. Download each one:')
  })

  it('says why it waits, and when the files can’t be made', async () => {
    vi.mocked(usePerson).mockReturnValue({ data: undefined } as never)
    renderPage()
    const button = screen.getByRole('button', { name: 'Make my files' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Loading your details…')
    fireEvent.click(button)
    expect(listRows).not.toHaveBeenCalled()
    cleanup()
    vi.mocked(usePerson).mockReturnValue({ data: undefined, isError: true } as never)
    renderPage()
    expect(
      screen.getByText('We couldn’t load your details. Reload the page to try again.'),
    ).toBeTruthy()
    cleanup()
    vi.mocked(usePerson).mockReturnValue({ data: { displayName: 'Sam Lee' } } as never)
    listRows.mockRejectedValue(new Error('offline'))
    renderPage()
    const ready = screen.getByRole('button', { name: 'Make my files' })
    expect(ready.hasAttribute('aria-describedby')).toBe(false)
    fireEvent.click(ready)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We couldn’t make the files. Check your connection and try again.',
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('ExportPage: groups', () => {
  it('says so when the groups can’t be loaded, and why your data waits', () => {
    vi.mocked(useGroups).mockReturnValue({ data: undefined, isError: true } as never)
    renderPage()
    expect(screen.getAllByRole('alert')[0]?.textContent).toBe(
      'We couldn’t load your groups. Reload the page to try again.',
    )
    expect(screen.queryByLabelText('Group')).toBeNull()
    expect(
      screen.getByText('We couldn’t load your details. Reload the page to try again.'),
    ).toBeTruthy()
  })

  it('offers no group export when there are no groups', () => {
    vi.mocked(useGroups).mockReturnValue({ data: [] } as never)
    renderPage()
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Make my files' })).toBeTruthy()
  })
})

describe('fileName', () => {
  it('keeps letters of any script, drops accents, and falls back to “group”', () => {
    expect(fileName('Flat 2/14')).toBe('flat-2-14')
    expect(fileName('Café Night')).toBe('cafe-night')
    expect(fileName('Crème brûlée')).toBe('creme-brulee')
    expect(fileName('東京旅行')).toBe('東京旅行')
    expect(fileName('Ｃａｆé')).toBe('cafe')
    expect(fileName('!!!')).toBe('group')
  })

  it('keeps the marks that are part of a word outside Latin', () => {
    expect(fileName('नमस्ते घर')).toBe('नमस्ते-घर')
    expect(fileName('สวัสดี')).toBe('สวัสดี')
    expect(fileName('Café नमस्ते')).toBe('cafe-नमस्ते')
    // Korean, typed or pasted decomposed, comes out as whole syllables.
    expect(fileName('한국 집')).toBe('한국-집')
    expect(fileName('한국'.normalize('NFD'))).toBe('한국')
    // Only Latin accents come off a Latin letter; marks alone aren't a name.
    expect(fileName('aा')).toBe('aा')
    expect(fileName('İstanbul')).toBe('istanbul')
    expect(fileName('\u0301\u0301')).toBe('group')
  })

  it('cuts by code point where the browser has no Intl.Segmenter', () => {
    const segmenter = Intl.Segmenter
    Object.assign(Intl, { Segmenter: undefined })
    try {
      expect(fileName('𠀀'.repeat(61))).toBe('𠀀'.repeat(60))
      expect(fileName('नमस्ते')).toBe('नमस्ते')
    } finally {
      Object.assign(Intl, { Segmenter: segmenter })
    }
  })

  it('keeps 60 characters at most, without a dash at the end', () => {
    expect(fileName('a'.repeat(70))).toBe('a'.repeat(60))
    expect(fileName(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59))
    expect(fileName(`-${'a'.repeat(60)}`)).toBe('a'.repeat(60))
    // A letter outside the BMP counts once and isn't cut in half.
    expect(fileName('𠀀'.repeat(61))).toBe('𠀀'.repeat(60))
    // A syllable, or a letter with its vowel sign, counts once and isn't split.
    expect(fileName('한'.repeat(61))).toBe('한'.repeat(60))
    expect(fileName('की'.repeat(61))).toBe('की'.repeat(60))
  })
})

describe('download and fileUrl', () => {
  it('saves the CSV through a link, and lets go of it a minute later', async () => {
    const real = await vi.importActual<typeof import('./export-data')>('./export-data')
    const created = vi.fn((_blob: Blob) => 'blob:x')
    const revoked = vi.fn()
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    real.download('a.csv', 'x')
    expect(click).toHaveBeenCalledTimes(1)
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe('a.csv')
    expect(link.href).toBe('blob:x')
    expect(created.mock.calls[0]?.[0].type).toBe('text/csv;charset=utf-8')
    vi.advanceTimersByTime(59_999)
    expect(revoked).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revoked).toHaveBeenCalledWith('blob:x')
  })
})
