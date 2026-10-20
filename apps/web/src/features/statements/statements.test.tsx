import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { formatNet } from '@ledgerly/core/money/format'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AppwriteException, Query } from 'appwrite'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { client, functions, tablesDB } from '../../lib/appwrite'
import { useGroup, useMyMember } from '../groups/use-groups'
import { readSnapshot } from './invoice-sections'
import { formatDate } from './invoice-view'
import { statementRoutes } from './routes'
import { finalizeTiming } from './use-statements'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  client: { config: { endpoint: 'https://appwrite.test/v1', project: 'p' }, call: vi.fn() },
  functions: { createExecution: vi.fn(), getExecution: vi.fn() },
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))
vi.mock('../../lib/api', async (actual) => ({
  ...(await actual<typeof import('../../lib/api')>()),
  callFunction: vi.fn(),
}))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'pw' } }) }))
vi.mock('../groups/use-groups', () => ({ useGroup: vi.fn(), useMyMember: vi.fn() }))

const call = vi.mocked(callFunction)
const listRows = vi.mocked(tablesDB.listRows)
const getRow = vi.mocked(tablesDB.getRow)
const createExecution = vi.mocked(functions.createExecution)
const getExecution = vi.mocked(functions.getExecution)
const clientCall = vi.mocked(client.call)

const acme = {
  $id: 'g1',
  type: 'employer',
  name: 'Acme',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

// The worker, Sam (pw), invoices Acme (pe) for October.
function snapshot(extra: object = {}): StatementSnapshot {
  // Plain strings for the dates: the schema parses them into LocalDate.
  return {
    version: 1,
    group: {
      id: 'g1',
      name: 'Acme',
      type: 'employer',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
    },
    period: { start: '2026-10-01', end: '2026-10-31' },
    issuer: {
      personId: 'pw',
      name: 'Sam',
      business: {
        businessName: 'Sam Cleaning',
        abn: '51824753556',
        bank: { accountName: 'Sam', bsb: '062000', accountNumber: '12345678' },
        invoiceNotes: 'Thanks!',
      },
    },
    recipient: { personId: 'pe', name: 'Acme', emails: ['delivered@resend.dev'] },
    // Sam's opening 10.00 + charges 260.00 − payment 155.00 = 115.00 due.
    people: [
      {
        personId: 'pe',
        name: 'Acme',
        openingCents: -1000,
        givenCents: 15500,
        receivedCents: 26000,
        closingCents: -11500,
      },
      {
        personId: 'pw',
        name: 'Sam',
        openingCents: 1000,
        givenCents: 26000,
        receivedCents: 15500,
        closingCents: 11500,
      },
    ],
    lines: [
      {
        transactionId: 't1',
        date: '2026-10-02',
        kind: 'shift',
        description: 'Morning shift',
        totalCents: 20000,
        shift: { minutes: 480, rateCents: 2500 },
        shares: [
          { personId: 'pw', givenCents: 20000, receivedCents: 0 },
          { personId: 'pe', givenCents: 0, receivedCents: 20000 },
        ],
      },
      {
        transactionId: 't2',
        date: '2026-10-05',
        kind: 'expense',
        description: 'Supplies',
        totalCents: 6000,
        shares: [
          { personId: 'pw', givenCents: 6000, receivedCents: 0 },
          { personId: 'pe', givenCents: 0, receivedCents: 6000 },
        ],
      },
      {
        transactionId: 't3',
        date: '2026-10-09',
        kind: 'payment',
        description: '',
        totalCents: 15500,
        shares: [
          { personId: 'pe', givenCents: 15500, receivedCents: 0 },
          { personId: 'pw', givenCents: 0, receivedCents: 15500 },
        ],
      },
      {
        transactionId: 't4',
        date: '2026-10-12',
        kind: 'expense',
        description: 'Mop on their card',
        totalCents: 3000,
        shares: [{ personId: 'pe', givenCents: 3000, receivedCents: 3000 }],
      },
    ],
    transfers: [],
    invoice: { balanceDueCents: 11500, paymentTermsDays: 14 },
    generatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  } as unknown as StatementSnapshot
}

function statement(id: string, extra: Partial<Statements> = {}, snap = snapshot()): Statements {
  return {
    $id: id,
    groupId: 'g1',
    type: 'invoice',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    status: 'draft',
    number: null,
    displayNumber: null,
    issuedOn: null,
    dueOn: null,
    snapshotJson: JSON.stringify(snap),
    pdfFileId: null,
    sentAt: null,
    finalizedBy: null,
    ...extra,
  } as Statements
}

const FINAL = {
  status: 'final',
  number: 7,
  displayNumber: 'INV-0007',
  issuedOn: '2026-11-03',
  dueOn: '2026-11-17',
  pdfFileId: 's1',
} as const

function mockGroup(role = 'admin', extra: Partial<Groups> = {}) {
  vi.mocked(useGroup).mockReturnValue({ data: { ...acme, ...extra }, isError: false } as never)
  vi.mocked(useMyMember).mockReturnValue({ data: { role }, isError: false } as never)
}

/** The stored statements: `getRow` answers from them, `listRows` lists them. */
let stored: Statements[] = []
function store(...rows: Statements[]) {
  stored = rows
  getRow.mockImplementation((async ({ rowId }: { rowId: string }) =>
    stored.find((row) => row.$id === rowId)) as never)
  listRows.mockImplementation((async () => ({ total: stored.length, rows: stored })) as never)
}

function ok(data: unknown): Result<unknown> {
  return { ok: true, data }
}

function renderAt(path: string) {
  const router = createMemoryRouter([statementRoutes, { path: '*', element: null }], {
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

beforeEach(() => {
  finalizeTiming.pollMs = 1
  finalizeTiming.polls = 75
  mockGroup()
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('StatementsPage', () => {
  it('lists the group’s invoices, latest period first, each linking to its page', async () => {
    store(
      statement('s2', { periodStart: '2026-11-01', periodEnd: '2026-11-30' }),
      statement('s1', { ...FINAL, sentAt: '2026-11-03T01:00:00.000Z' }),
      statement('s0', {
        ...FINAL,
        displayNumber: 'INV-0006',
        status: 'void',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      }),
    )
    renderAt('/groups/g1/statements')
    const links = await screen.findAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/groups/g1/statements/s2',
      '/groups/g1/statements/s1',
      '/groups/g1/statements/s0',
    ])
    // Dates in the browser's own style, never moved by its time zone.
    const nov = `${formatDate('2026-11-01')} – ${formatDate('2026-11-30')}`
    const oct = `${formatDate('2026-10-01')} – ${formatDate('2026-10-31')}`
    // A draft shows its balance due so far, too.
    expect(links[0]?.textContent).toMatch(new RegExp(`^Draft invoice${nov} · Draft.*115\\.00$`))
    expect(links[1]?.textContent).toMatch(new RegExp(`^INV-0007${oct} · Final · Sent.*115\\.00$`))
    expect(links[2]?.textContent).toMatch(/· Void/)
    const [params] = listRows.mock.calls[0] ?? []
    expect((params as unknown as { queries: string[] }).queries).toEqual(
      expect.arrayContaining([Query.equal('groupId', 'g1'), Query.orderDesc('periodStart')]),
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Invoices for Acme')
  })

  it('says when there are none yet', async () => {
    store()
    renderAt('/groups/g1/statements')
    expect(await screen.findByText(/No invoices yet/)).toBeTruthy()
  })

  it('shows a balance due past the amount cap', async () => {
    const big = snapshot({ invoice: { balanceDueCents: 20_000_000_000, paymentTermsDays: 14 } })
    store(statement('s1', FINAL, big))
    renderAt('/groups/g1/statements')
    expect((await screen.findByRole('link')).textContent).toMatch(/200,000,000\.00$/)
  })
})

describe('StatementPage: a draft', () => {
  it('refreshes the draft on open and shows it laid out like the PDF', async () => {
    store(statement('s1'))
    // The refresh finds a late shift.
    const refreshed = snapshot({ invoice: { balanceDueCents: 12000, paymentTermsDays: 14 } })
    let answer!: (value: Result<unknown>) => void
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderAt('/groups/g1/statements/s1')
    expect(await screen.findByText('Updating from your latest entries…')).toBeTruthy()
    answer(ok(statement('s1', {}, refreshed)))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/s1/refresh', undefined),
    )
    const invoice = await screen.findByRole('article', { name: 'Draft invoice' })
    await waitFor(() =>
      expect(within(invoice).getByText('Balance due').nextElementSibling?.textContent).toMatch(
        /120\.00$/,
      ),
    )
    expect(within(invoice).getByText('DRAFT INVOICE')).toBeTruthy()
    expect(within(invoice).getByText('Given when finalized')).toBeTruthy()
    expect(within(invoice).getByText('Sam Cleaning')).toBeTruthy()
    expect(within(invoice).getByText('ABN 51 824 753 556')).toBeTruthy()
    expect(
      within(invoice).getByText('Opening balance (from the previous invoice)').nextElementSibling
        ?.textContent,
    ).toMatch(/10\.00$/)

    const section = (name: string) =>
      within(invoice).getByRole('heading', { level: 3, name }).closest('section') as HTMLElement
    const rows = (name: string) =>
      within(section(name))
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent?.replace(/\s+/g, ' '))
    // Charges: the shift with its hours and rate, and the reimbursable expense.
    expect(rows('Work and charges')).toEqual([
      expect.stringMatching(
        new RegExp(`^${formatDate('2026-10-02')}Morning shift8 h at .*25\\.00/h.*200\\.00$`),
      ),
      expect.stringMatching(new RegExp(`^${formatDate('2026-10-05')}Supplies.*60\\.00$`)),
      expect.stringMatching(/^Total.*260\.00$/),
    ])
    // A payment, named by its kind when it has no description, as a negative amount.
    expect(rows('Payments received and deductions')).toEqual([
      expect.stringMatching(new RegExp(`^${formatDate('2026-10-09')}Payment.*-.*155\\.00$`)),
      expect.stringMatching(/^Total.*-.*155\.00$/),
    ])
    // On their card for work: listed, not charged.
    expect(rows('For your records')).toEqual([
      expect.stringMatching(new RegExp(`^${formatDate('2026-10-12')}Mop on their card.*30\\.00$`)),
    ])
    expect(within(section('How to pay')).getByText(/BSB 062-000, account 12345678/)).toBeTruthy()
    expect(within(section('Notes')).getByText('Thanks!')).toBeTruthy()
  })

  it('refreshes once, even when React runs the effect twice (StrictMode)', async () => {
    store(statement('s1'))
    call.mockResolvedValue(ok(statement('s1')))
    const router = createMemoryRouter([statementRoutes], {
      initialEntries: ['/groups/g1/statements/s1'],
    })
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    )
    await screen.findByRole('article', { name: 'Draft invoice' })
    await act(async () => {})
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('still shows the stored draft when the refresh fails', async () => {
    store(statement('s1'))
    call.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    renderAt('/groups/g1/statements/s1')
    expect(
      await screen.findByText(/We couldn’t update this draft, so it may be out of date/),
    ).toBeTruthy()
    expect(screen.getByRole('article', { name: 'Draft invoice' })).toBeTruthy()
  })

  it('reads the draft again when the refresh fails, as it may have changed anyway', async () => {
    store(statement('s1'))
    call.mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'Try again.' } })
    renderAt('/groups/g1/statements/s1')
    await screen.findByText(/We couldn’t update this draft/)
    await waitFor(() => expect(getRow).toHaveBeenCalledTimes(2))
  })

  it('doesn’t refresh a draft in an archived group, whose statements can’t change', async () => {
    mockGroup('admin', { archivedAt: '2026-11-01T00:00:00.000Z' })
    store(statement('s1'))
    renderAt('/groups/g1/statements/s1')
    await screen.findByRole('article', { name: 'Draft invoice' })
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
  })

  it('words How to pay as the PDF does, with or without bank details', async () => {
    const plain = snapshot({
      issuer: { personId: 'pw', name: 'Sam', business: {} },
      invoice: { balanceDueCents: 11500, paymentTermsDays: 0 },
    })
    store(statement('s1', FINAL, plain))
    renderAt('/groups/g1/statements/s1')
    const pay = (await screen.findByRole('heading', { level: 3, name: 'How to pay' })).closest(
      'section',
    ) as HTMLElement
    expect(pay.textContent).toBe(
      `How to payPayment terms: due on receipt. Please pay by ${formatDate('2026-11-17')}, with INV-0007 as the reference.`,
    )
  })

  it('shows an opening balance and balance due past the amount cap', async () => {
    const people = snapshot().people.map((person) =>
      person.personId === 'pw' ? { ...person, openingCents: 20_000_000_000 } : person,
    )
    const big = snapshot({
      people,
      invoice: { balanceDueCents: 20_000_011_500, paymentTermsDays: 14 },
    })
    store(statement('s1', FINAL, big))
    renderAt('/groups/g1/statements/s1')
    const opening = await screen.findByText('Opening balance (from the previous invoice)')
    expect(opening.nextElementSibling?.textContent).toMatch(/200,000,000\.00$/)
    expect(screen.getByText('Balance due').nextElementSibling?.textContent).toMatch(
      /200,000,115\.00$/,
    )
  })

  it.each([
    ['a Thai name', 'ร้าน Pty Ltd', true],
    // Noto Sans CJK has it (#270).
    ['a Chinese name', '张三 Pty Ltd', false],
    ['a Latin one', 'Café Ngọc', false],
  ])('warns when the PDF can’t show a character, for %s', async (_, name, warned) => {
    const recipient = { personId: 'pe', name, emails: ['delivered@resend.dev'] }
    store(statement('s1', {}, snapshot({ recipient })))
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/groups/g1/statements/s1')
    await screen.findByRole('article', { name: 'Draft invoice' })
    const warning = screen.queryByText(
      'Some characters in this invoice can’t be shown in the PDF yet. They’ll print as �.',
    )
    expect(warning !== null).toBe(warned)
  })

  it('says when nothing is owed, or the employer is in credit', async () => {
    store(
      statement('s1', {}, snapshot({ invoice: { balanceDueCents: -500, paymentTermsDays: 14 } })),
    )
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/groups/g1/statements/s1')
    expect(
      await screen.findByText(/You have a credit of .*5\.00, so there is nothing to pay\./),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'How to pay' })).toBeNull()
  })
})

describe('StatementPage: finalize', () => {
  beforeEach(() => {
    store(statement('s1'))
    // The refresh on open answers with the same draft.
    call.mockImplementation(async (_fn, _method, path) =>
      path.endsWith('/refresh') ? ok(stored[0]) : ok({}),
    )
    createExecution.mockResolvedValue({ $id: 'e1' } as never)
  })

  async function openFinalize() {
    const view = renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize…' }))
    expect(screen.getByText('Sending emails it to delivered@resend.dev.')).toBeTruthy()
    return view
  }

  it('finalizes and sends as an async execution, watching it until the row is final', async () => {
    getExecution
      .mockResolvedValueOnce({ status: 'processing' } as never)
      .mockImplementationOnce((async () => {
        store(statement('s1', { ...FINAL, sentAt: '2026-11-03T01:00:00.000Z' }))
        return { status: 'completed', responseStatusCode: 200, responseBody: '' }
      }) as never)
    await openFinalize()
    const button = screen.getByRole('button', { name: 'Finalize and send' })
    button.focus()
    fireEvent.click(button)
    expect(await screen.findByText('Finalizing… This can take up to a minute.')).toBeTruthy()
    // aria-disabled, not disabled, so a browser keeps focus on it while it works.
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(button)
    expect(await screen.findByText('Finalized as INV-0007 and sent.')).toBeTruthy()
    expect(createExecution).toHaveBeenCalledWith({
      functionId: 'statements',
      body: JSON.stringify({ send: true }),
      async: true,
      xpath: '/statements/s1/finalize',
      method: 'POST',
    })
    expect(getExecution).toHaveBeenCalledWith({ functionId: 'statements', executionId: 'e1' })
    expect(getExecution).toHaveBeenCalledTimes(2)
    // The panel's gone: focus is on the heading, which now has the number.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'INV-0007' }))
    expect(screen.getByRole('article', { name: 'Invoice INV-0007' })).toBeTruthy()
  })

  it('can finalize without sending', async () => {
    getExecution.mockImplementation((async () => {
      store(statement('s1', FINAL))
      return { status: 'completed', responseStatusCode: 200, responseBody: '' }
    }) as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize without sending' }))
    expect(await screen.findByText('Finalized as INV-0007.')).toBeTruthy()
    expect(createExecution).toHaveBeenCalledWith(
      expect.objectContaining({ body: '{"send":false}' }),
    )
  })

  it('stops and shows the server’s message when the execution fails', async () => {
    getExecution.mockResolvedValue({
      status: 'completed',
      responseStatusCode: 409,
      responseBody: JSON.stringify({
        ok: false,
        error: { code: 'CONFLICT', message: 'Finalize the earlier statement of this group first.' },
      }),
    } as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Finalize the earlier statement of this group first.',
    )
    // Still a draft, so it can be tried again.
    expect(screen.getByRole('button', { name: 'Finalize and send' })).toBeTruthy()
    expect(screen.queryByText('Finalizing… This can take up to a minute.')).toBeNull()
  })

  it('says it was finalized but not sent when only the email failed', async () => {
    getExecution.mockImplementation((async () => {
      store(statement('s1', FINAL))
      return {
        status: 'failed',
        responseStatusCode: 500,
        responseBody: JSON.stringify({
          ok: false,
          error: { code: 'INTERNAL', message: 'Something went wrong on our side. Try again.' },
        }),
      }
    }) as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect(
      await screen.findByText(
        'Finalized as INV-0007, but it wasn’t sent: Something went wrong on our side. Try again. Use Send to try again.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('says so plainly when a failed execution kept no response body', async () => {
    getExecution.mockImplementation((async () => {
      store(statement('s1', FINAL))
      return { status: 'failed', responseStatusCode: 500, responseBody: '' }
    }) as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect(
      await screen.findByText(
        'Finalized as INV-0007, but it wasn’t sent: The server stopped with an error. Use Send to try again.',
      ),
    ).toBeTruthy()
  })

  it('stops with a plain message when the session has ended', async () => {
    getExecution.mockRejectedValue(new AppwriteException('Unauthorized', 401))
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Please log in again.')
  })

  it('reads the statement again when the watch fails part way, as it may have changed', async () => {
    getExecution.mockRejectedValue(new Error('offline'))
    await openFinalize()
    const reads = getRow.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not reach the server. Check your connection and try again.',
    )
    await waitFor(() => expect(getRow.mock.calls.length).toBeGreaterThan(reads))
  })

  it('gives up waiting after the limit, without spinning forever', async () => {
    finalizeTiming.polls = 3
    getExecution.mockResolvedValue({ status: 'processing' } as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/taking longer than usual/)
    expect(getExecution).toHaveBeenCalledTimes(3)
  })

  it.each([
    [409, /an earlier invoice of this group must be finalized first/],
    [401, /^Please log in again\.$/],
    [403, /^Only an admin can finalize this invoice\.$/],
  ])('words an async refusal by its status code %i, as it keeps no body', async (code, text) => {
    getExecution.mockResolvedValue({
      status: 'completed',
      responseStatusCode: code,
      responseBody: '',
    } as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and send' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(text)
  })

  it('doesn’t say “wasn’t sent” after finalizing without sending', async () => {
    getExecution.mockImplementation((async () => {
      store(statement('s1', FINAL))
      return { status: 'failed', responseStatusCode: 500, responseBody: '' }
    }) as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize without sending' }))
    expect(
      await screen.findByText('Finalized as INV-0007. The server stopped with an error.'),
    ).toBeTruthy()
  })

  it('moves focus into the panel when it opens, and back to Finalize… on Cancel', async () => {
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize…' }))
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Finalize this invoice?' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Finalize…' }))
  })

  it('points to an earlier unfinished invoice instead of offering Finalize', async () => {
    store(statement('s2', { periodStart: '2026-11-01', periodEnd: '2026-11-30' }), statement('s1'))
    renderAt('/groups/g1/statements/s2')
    const link = await screen.findByRole('link', {
      name: `${formatDate('2026-10-01')} – ${formatDate('2026-10-31')}`,
    })
    expect(link.getAttribute('href')).toBe('/groups/g1/statements/s1')
    expect(screen.getByText(/^Finalize the earlier invoice first/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Finalize…' })).toBeNull()
  })

  it('offers Finalize again on a statement left finalizing, and says why', async () => {
    store(statement('s1', { status: 'finalizing', number: 7, displayNumber: 'INV-0007' }))
    renderAt('/groups/g1/statements/s1')
    expect(await screen.findByText(/^Finalizing didn’t finish/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Finalize…' })).toBeTruthy()
    // Not a draft, so it isn't refreshed.
    expect(call).not.toHaveBeenCalled()
  })

  it('offers no finalize to a member who isn’t an admin, or in an archived group', async () => {
    mockGroup('member')
    renderAt('/groups/g1/statements/s1')
    await screen.findByRole('article', { name: 'Draft invoice' })
    expect(screen.queryByRole('button', { name: 'Finalize…' })).toBeNull()
    cleanup()
    mockGroup('admin', { archivedAt: '2026-11-01T00:00:00.000Z' })
    renderAt('/groups/g1/statements/s1')
    await screen.findByRole('article', { name: 'Draft invoice' })
    expect(screen.queryByRole('button', { name: 'Finalize…' })).toBeNull()
  })
})

describe('StatementPage: a final invoice', () => {
  it('downloads the PDF through the SDK, so the session goes with it', async () => {
    store(statement('s1', FINAL))
    clientCall.mockResolvedValue(new ArrayBuffer(8))
    const createObjectURL = vi.fn(() => 'blob:pdf')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    const [method, url, , , type] = clientCall.mock.calls[0] ?? []
    expect([method, type]).toEqual(['get', 'arrayBuffer'])
    expect(String(url)).toMatch(
      /^https:\/\/appwrite\.test\/v1\/storage\/buckets\/statements\/files\/s1\/download\?/,
    )
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('INV-0007.pdf')
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf'), { timeout: 2000 })
    // A final invoice isn't refreshed.
    expect(call).not.toHaveBeenCalled()
  })

  it('sends again with POST /send', async () => {
    store(statement('s1', { ...FINAL, sentAt: '2026-11-03T01:00:00.000Z' }))
    call.mockResolvedValue(ok({ sentAt: '2026-11-04T01:00:00.000Z' }))
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Send again' }))
    expect(await screen.findByText('Sent.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/s1/send', undefined)
  })

  it('reloads the list of invoices after a send, so it shows the new state', async () => {
    store(statement('s1', FINAL))
    call.mockResolvedValue(ok({ sentAt: '2026-11-04T01:00:00.000Z' }))
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    const lists = listRows.mock.calls.length
    expect(await screen.findByText('Sent.')).toBeTruthy()
    await waitFor(() => expect(listRows.mock.calls.length).toBeGreaterThan(lists))
  })

  it('reads the invoice again when sending fails, and offers Send again if it went out', async () => {
    store(statement('s1', FINAL))
    call.mockImplementation(async () => {
      // It was sent, but the answer was lost.
      store(statement('s1', { ...FINAL, sentAt: '2026-11-03T01:00:00.000Z' }))
      return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong.' } }
    })
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong.')
    expect(await screen.findByRole('button', { name: 'Send again' })).toBeTruthy()
  })

  it('shows the server’s message when sending fails', async () => {
    store(statement('s1', FINAL))
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Add a billing email to the group first.' },
    })
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Add a billing email to the group first.',
    )
  })

  it('voids the latest final invoice with a reason, after confirming', async () => {
    store(
      statement('s1', FINAL),
      statement('s0', {
        ...FINAL,
        displayNumber: 'INV-0006',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      }),
    )
    call.mockResolvedValue(ok(statement('s1', { ...FINAL, status: 'void' })))
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Void…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Void invoice' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' Wrong rate ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Void invoice' }))
    expect(await screen.findByText('INV-0007 is void.')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/s1/void', {
      reason: 'Wrong rate',
    })
    expect(document.activeElement?.tagName).toBe('H1')
    // The panel went with the Void… button: it can't be sent again, or cancelled onto nothing.
    expect(screen.queryByRole('form', { name: 'Void INV-0007?' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Void invoice' })).toBeNull()
  })

  it('picks the latest final invoice past a later void one, and moves focus into Void', async () => {
    store(
      statement('s2', {
        ...FINAL,
        status: 'void',
        displayNumber: 'INV-0008',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
      }),
      statement('s1', FINAL),
    )
    renderAt('/groups/g1/statements/s1')
    const open = await screen.findByRole('button', { name: 'Void…' })
    fireEvent.click(open)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Void INV-0007?' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Void…' }))
  })

  it('keeps the PDF of a void invoice, with no other actions', async () => {
    store(statement('s1', { ...FINAL, status: 'void' }))
    renderAt('/groups/g1/statements/s1')
    expect(await screen.findByRole('button', { name: 'Download PDF' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Void…' })).toBeNull()
  })

  it('offers void only on the latest final invoice, and none of the admin actions to a member', async () => {
    store(
      statement('s1', FINAL),
      statement('s0', {
        ...FINAL,
        displayNumber: 'INV-0006',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      }),
    )
    renderAt('/groups/g1/statements/s0')
    await screen.findByRole('button', { name: 'Download PDF' })
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Void…' })).toBeNull()
    cleanup()
    mockGroup('member')
    renderAt('/groups/g1/statements/s1')
    await screen.findByRole('button', { name: 'Download PDF' })
    expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Void…' })).toBeNull()
  })
})

// A house of three, Alice (pa), Bob (pb) and Cara (pc), divides October (#166).
function divideSnapshot(extra: object = {}): StatementSnapshot {
  return {
    version: 1,
    group: {
      id: 'g1',
      name: 'The flat',
      type: 'house',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
    },
    period: { start: '2026-10-01', end: '2026-10-31' },
    // Alice paid the rent; Bob the groceries. Closings add up to 0.
    people: [
      {
        personId: 'pa',
        name: 'Alice',
        openingCents: 0,
        givenCents: 150000,
        receivedCents: 50900,
        closingCents: 99100,
      },
      {
        personId: 'pb',
        name: 'Bob',
        openingCents: -500,
        givenCents: 2700,
        receivedCents: 72339,
        closingCents: -70139,
      },
      {
        personId: 'pc',
        name: 'Cara',
        openingCents: 500,
        givenCents: 0,
        receivedCents: 29461,
        closingCents: -28961,
      },
    ],
    lines: [
      {
        transactionId: 't1',
        date: '2026-10-01',
        kind: 'bill',
        description: 'Rent',
        totalCents: 150000,
        shares: [
          { personId: 'pa', givenCents: 150000, receivedCents: 50000 },
          { personId: 'pb', givenCents: 0, receivedCents: 70000 },
          { personId: 'pc', givenCents: 0, receivedCents: 30000 },
        ],
      },
      {
        transactionId: 't2',
        date: '2026-10-18',
        kind: 'expense',
        description: 'Groceries',
        totalCents: 2700,
        shares: [
          { personId: 'pa', givenCents: 0, receivedCents: 900 },
          { personId: 'pb', givenCents: 2700, receivedCents: 2339 },
          { personId: 'pc', givenCents: 0, receivedCents: -539 },
        ],
      },
    ],
    transfers: [
      { fromPersonId: 'pb', toPersonId: 'pa', cents: 70139 },
      { fromPersonId: 'pc', toPersonId: 'pa', cents: 28961 },
    ],
    generatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  } as unknown as StatementSnapshot
}

function divide(id: string, extra: Partial<Statements> = {}, snap = divideSnapshot()): Statements {
  return statement(id, { type: 'divide', ...extra }, snap)
}

const FINAL_DIVIDE = { status: 'final', issuedOn: '2026-11-01', pdfFileId: 'd1' } as const

describe('StatementPage: a monthly divide (#166)', () => {
  beforeEach(() => {
    mockGroup('admin', { type: 'house', name: 'The flat' })
    call.mockImplementation(async (_fn, _method, path) =>
      path.endsWith('/refresh') ? ok(stored.find((row) => path.includes(row.$id))) : ok({}),
    )
    createExecution.mockResolvedValue({ $id: 'e1' } as never)
  })

  it('shows a draft as its PDF lays it out: balances in words, transfers and each part', async () => {
    store(divide('d1'))
    renderAt('/groups/g1/statements/d1')
    const article = await screen.findByRole('article', { name: 'Draft divide' })
    const period = `${formatDate('2026-10-01')} – ${formatDate('2026-10-31')}`
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Divide for ${period}`)
    expect(screen.getByRole('link', { name: 'All statements' })).toBeTruthy()
    // Refreshed on open, as an invoice draft is.
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/d1/refresh', undefined),
    )
    const rows = within(article)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent)
    expect(rows).toEqual([
      expect.stringMatching(/^Alice.*0\.00.*1,500\.00.*509\.00.*991\.00is owed .*991\.00$/),
      expect.stringMatching(/^Bob-.*5\.00.*27\.00.*723\.39-.*701\.39owes .*701\.39$/),
      expect.stringMatching(/^Cara.*5\.00.*0\.00.*294\.61-.*289\.61owes .*289\.61$/),
    ])
    // The table scrolls inside its card, and can be reached by keyboard to do so.
    const table = within(article).getByRole('region', { name: 'Balances table' })
    expect(table.className).toContain('overflow-x-auto')
    expect(table.getAttribute('tabindex')).toBe('0')
    const transfers = within(article).getByRole('region', { name: 'To settle up' })
    expect(
      within(transfers)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^Bob pays Alice .*701\.39$/),
      expect.stringMatching(/^Cara pays Alice .*289\.61$/),
    ])
    const lines = within(article).getByRole('region', { name: 'Transactions' })
    expect(within(lines).getByText(/^Bob: paid .*27\.00, share .*23\.39$/)).toBeTruthy()
    expect(within(lines).getByText(/^Alice: paid .*1,500\.00, share .*500\.00$/)).toBeTruthy()
  })

  it('shows openings and closings past the amount cap', async () => {
    const people = divideSnapshot().people.map((person) =>
      person.personId === 'pa'
        ? { ...person, openingCents: 20_000_000_000, closingCents: 20_000_099_100 }
        : person,
    )
    store(divide('d1', FINAL_DIVIDE, divideSnapshot({ people })))
    renderAt('/groups/g1/statements/d1')
    const article = await screen.findByRole('article', { name: 'Divide' })
    expect(within(article).getAllByRole('row')[1]?.textContent).toMatch(
      /^Alice.*200,000,000\.00.*1,500\.00.*509\.00.*200,000,991\.00is owed .*200,000,991\.00$/,
    )
  })

  it('says when someone in a transaction has no part of it', async () => {
    const snap = divideSnapshot()
    snap.lines[1]?.shares.push({ personId: 'pd', givenCents: 0, receivedCents: 0 })
    store(divide('d1', FINAL_DIVIDE, snap))
    renderAt('/groups/g1/statements/d1')
    expect(await screen.findByText('Someone: no part')).toBeTruthy()
  })

  it('says everyone is settled when there are no transfers', async () => {
    store(divide('d1', FINAL_DIVIDE, divideSnapshot({ transfers: [] })))
    renderAt('/groups/g1/statements/d1')
    expect(await screen.findByText('Everyone is settled up.')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'Divide' })).toBeTruthy()
  })

  async function openFinalize() {
    store(divide('d1'))
    const view = renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize…' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Finalize this divide?' })).toBeTruthy()
    return view
  }

  it('goes back to the list when another admin discarded the draft meanwhile', async () => {
    getExecution.mockImplementation((async () => {
      stored = []
      getRow.mockRejectedValue(new AppwriteException('Row not found', 404, 'row_not_found'))
      return { status: 'failed', responseStatusCode: 404, responseBody: '' }
    }) as never)
    const { router } = await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize only' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g1/statements'))
    expect(await screen.findByText(/^The draft for .+ was discarded\.$/)).toBeTruthy()
    expect(screen.queryByText(/Could not reach the server/)).toBeNull()
  })

  it.each([
    ['Finalize and email everyone', true, 'Finalized and emailed to everyone.'],
    ['Finalize only', false, 'Finalized.'],
  ])('“%s” finalizes with { send: %s }', async (button, send, message) => {
    getExecution.mockImplementation((async () => {
      store(divide('d1', { ...FINAL_DIVIDE, sentAt: send ? '2026-11-01T01:00:00.000Z' : null }))
      return { status: 'completed', responseStatusCode: 200, responseBody: '' }
    }) as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(createExecution).toHaveBeenCalledWith({
      functionId: 'statements',
      body: JSON.stringify({ send }),
      async: true,
      xpath: '/statements/d1/finalize',
      method: 'POST',
    })
  })

  it('says when it was finalized but the emails failed', async () => {
    getExecution.mockImplementation((async () => {
      store(divide('d1', FINAL_DIVIDE))
      return { status: 'failed', responseStatusCode: 500, responseBody: '' }
    }) as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize and email everyone' }))
    expect(
      await screen.findByText(
        'Finalized, but it wasn’t emailed: The server stopped with an error. Use Email everyone to try again.',
      ),
    ).toBeTruthy()
  })

  it.each([
    [
      'a clash or an earlier draft (409, no body kept)',
      { status: 'completed', responseStatusCode: 409, responseBody: '' },
      'Finalize the earlier statement first. If there isn’t one, try again.',
    ],
    [
      'a check that didn’t add up (500, no body kept, back at draft)',
      { status: 'failed', responseStatusCode: 500, responseBody: '' },
      'It didn’t add up, so it’s still a draft.',
    ],
    [
      'a refusal never worded as an invoice',
      { status: 'completed', responseStatusCode: 403, responseBody: '' },
      'Only an admin can finalize this divide.',
    ],
    [
      'a check that didn’t add up',
      {
        status: 'failed',
        responseStatusCode: 500,
        responseBody: JSON.stringify({
          ok: false,
          error: { code: 'INVARIANT_VIOLATION', message: 'A ledger invariant would break.' },
        }),
      },
      'It didn’t add up, so it’s still a draft.',
    ],
  ])('words a refused finalize for %s', async (_case, run, message) => {
    getExecution.mockResolvedValue(run as never)
    await openFinalize()
    fireEvent.click(screen.getByRole('button', { name: 'Finalize only' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByRole('button', { name: 'Finalize only' })).toBeTruthy()
  })

  it('emails everyone with POST /send, then says when it was sent', async () => {
    store(divide('d1', FINAL_DIVIDE))
    call.mockResolvedValue(ok({ sentAt: '2026-11-01T14:00:00.000Z' }))
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Email everyone' }))
    // 01:00 on the 2nd in Sydney, still the 1st in UTC.
    expect(await screen.findByText(`Sent ${formatDate('2026-11-02')}.`)).toBeTruthy()
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/d1/send', undefined)
    expect(screen.getByRole('button', { name: 'Email everyone again' })).toBeTruthy()
  })

  it('shows the message when nobody can be emailed', async () => {
    store(divide('d1', FINAL_DIVIDE))
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Nobody in this house has a verified email.' },
    })
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Email everyone' }))
    expect(await screen.findByText('Nobody in this house has a verified email.')).toBeTruthy()
  })

  it('downloads the PDF as divide-<periodEnd>.pdf', async () => {
    store(divide('d1', FINAL_DIVIDE))
    clientCall.mockResolvedValue(new ArrayBuffer(8))
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pdf'), revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('divide-2026-10-31.pdf')
  })

  it('voids the latest final divide in its own words', async () => {
    store(divide('d1', FINAL_DIVIDE))
    call.mockResolvedValue(ok(divide('d1', { ...FINAL_DIVIDE, status: 'void' })))
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Void…' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Void this divide?' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Rent was wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Void divide' }))
    expect(await screen.findByText('This divide is void.')).toBeTruthy()
  })

  it('shows drafts and finals to members and viewers, with the PDF but no admin buttons', async () => {
    for (const role of ['member', 'viewer']) {
      mockGroup(role, { type: 'house', name: 'The flat' })
      store(divide('d1', FINAL_DIVIDE))
      renderAt('/groups/g1/statements/d1')
      expect(await screen.findByRole('button', { name: 'Download PDF' })).toBeTruthy()
      await act(async () => {})
      expect(screen.queryByRole('button', { name: /^Email everyone/ })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Void…' })).toBeNull()
      cleanup()
      store(divide('d2'))
      renderAt('/groups/g1/statements/d2')
      expect(await screen.findByRole('article', { name: 'Draft divide' })).toBeTruthy()
      await act(async () => {})
      expect(screen.queryByRole('button', { name: 'Finalize…' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Discard draft…' })).toBeNull()
      cleanup()
    }
  })
})

describe('StatementPage: discard a draft (#166)', () => {
  beforeEach(() => {
    mockGroup('admin', { type: 'house', name: 'The flat' })
  })

  /** Refreshes answer with the stored draft; discard answers `discard`. */
  function answer(discard: Result<unknown>) {
    call.mockImplementation(async (_fn, _method, path) => {
      if (path.endsWith('/refresh')) return ok(stored.find((row) => path.includes(row.$id)))
      return discard
    })
  }

  it('says the latest draft’s period goes on the next statement, discards it and goes back', async () => {
    store(
      divide('d1'),
      divide('d0', { ...FINAL_DIVIDE, periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
    )
    answer(ok({}))
    const { router, queryClient } = renderAt('/groups/g1/statements/d1')
    const open = await screen.findByRole('button', { name: 'Discard draft…' })
    fireEvent.click(open)
    const period = `${formatDate('2026-10-01')} – ${formatDate('2026-10-31')}`
    const heading = screen.getByRole('heading', {
      level: 2,
      name: `Discard the draft for ${period}?`,
    })
    expect(document.activeElement).toBe(heading)
    expect(
      screen.getByText(
        `It’s deleted. Its transactions don’t change. This period, ${period}, will be included in the next statement.`,
      ),
    ).toBeTruthy()
    store(divide('d0', { ...FINAL_DIVIDE, periodStart: '2026-09-01', periodEnd: '2026-09-30' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g1/statements'))
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/d1/discard')
    // Said in a status region that was already there, with focus on the heading.
    const note = await screen.findByText(`The draft for ${period} was discarded.`)
    expect(note.getAttribute('role')).toBe('status')
    const list = screen.getByRole('heading', { level: 1 })
    expect(list.textContent).toBe('Statements for The flat')
    expect(document.activeElement).toBe(list)
    // Cleared, so a reload doesn't say it again.
    expect(router.state.location.state).toBeNull()
    // The deleted row isn't kept, so nothing shows it again.
    expect(queryClient.getQueryData(['statement', 'd1'])).toBeUndefined()
  })

  it('doesn’t say so for a draft that isn’t the latest, and Cancel puts focus back', async () => {
    store(
      divide('d1', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
      divide('d2', { periodStart: '2026-10-01', periodEnd: '2026-10-31' }),
    )
    answer(ok({}))
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }))
    expect(screen.getByText('It’s deleted. Its transactions don’t change.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard draft…' }))
  })

  it('counts a later void statement too: a reissued draft isn’t the latest (statements.md#5)', async () => {
    store(
      divide('d1', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
      divide('d2', { ...FINAL_DIVIDE, status: 'void' }),
    )
    answer(ok({}))
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }))
    expect(screen.getByText('It’s deleted. Its transactions don’t change.')).toBeTruthy()
  })

  it('counts NOT_FOUND as done: an earlier try already discarded it', async () => {
    store(divide('d1'))
    answer({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } })
    const { router } = renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g1/statements'))
  })

  it.each([
    ['CONFLICT', 'finalizing', 'It’s being finalized. Finalize it again instead.'],
    ['VALIDATION_FAILED', 'final', 'It’s final now, so it can’t be discarded.'],
  ] as const)(
    'shows %s on the page when the row changed meanwhile (%s), and stays',
    async (code, status, message) => {
      store(divide('d1'))
      call.mockImplementation(async (_fn, _method, path) => {
        if (path.endsWith('/refresh')) return ok(stored[0])
        // Another admin got there first: reading it again finds it changed.
        store(divide('d1', status === 'final' ? FINAL_DIVIDE : { status }))
        return { ok: false, error: { code, message } }
      })
      const { router } = renderAt('/groups/g1/statements/d1')
      fireEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }))
      fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
      expect((await screen.findByRole('alert')).textContent).toBe(message)
      // The panel goes with the draft; the message stays, and focus is on the page's heading.
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: /^Discard the draft/ })).toBeNull(),
      )
      expect(screen.getByRole('alert').textContent).toBe(message)
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
      expect(router.state.location.pathname).toBe('/groups/g1/statements/d1')
    },
  )

  it('waits for the refresh on open before discarding', async () => {
    store(divide('d1'))
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/groups/g1/statements/d1')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }))
    const button = screen.getByRole('button', { name: 'Discard draft' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    // A mutation starts on a later tick.
    await act(async () => {})
    expect(call.mock.calls.map(([, , path]) => path)).toEqual(['/statements/d1/refresh'])
  })

  it('offers no discard on a statement being finalized, or an invoice draft with a number', async () => {
    store(divide('d1', { status: 'finalizing' }))
    answer(ok({}))
    renderAt('/groups/g1/statements/d1')
    expect(await screen.findByRole('button', { name: 'Finalize…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Discard draft…' })).toBeNull()
    cleanup()
    mockGroup('admin')
    store(statement('s1', { number: 7 }))
    renderAt('/groups/g1/statements/s1')
    expect(await screen.findByRole('button', { name: 'Finalize…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Discard draft…' })).toBeNull()
  })

  it('discards an invoice draft too', async () => {
    mockGroup('admin')
    store(statement('s1'))
    answer(ok({}))
    renderAt('/groups/g1/statements/s1')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/s1/discard'),
    )
  })
})

describe('StatementsPage: a house', () => {
  it('lists divides by period, with no balance due', async () => {
    mockGroup('member', { type: 'house', name: 'The flat' })
    store(
      divide('d1', { periodStart: '2026-11-01', periodEnd: '2026-11-30' }),
      divide('d0', FINAL_DIVIDE),
    )
    renderAt('/groups/g1/statements')
    const links = await screen.findAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      `Draft divide${formatDate('2026-11-01')} – ${formatDate('2026-11-30')} · Draft`,
      `Divide${formatDate('2026-10-01')} – ${formatDate('2026-10-31')} · Final`,
    ])
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Statements for The flat')
  })

  it('says when there are none yet', async () => {
    mockGroup('member', { type: 'house', name: 'The flat' })
    store()
    renderAt('/groups/g1/statements')
    expect(await screen.findByText(/^No statements yet/)).toBeTruthy()
  })
})

describe('StatementsPage: the period so far, and closing it now (#398)', () => {
  // 14:00 on 12 Nov 2026 in Sydney, the group's time zone.
  const NOW = new Date('2026-11-12T03:00:00.000Z')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * The statements function: a preview covers `start` to its `periodEnd` (default: today), and a
   * close answers `close`, by default the new draft.
   */
  function answer({
    start = '2026-11-01',
    snap = snapshot,
    close = (periodEnd: string): Result<unknown> => {
      const row = statement('s9', { periodStart: start, periodEnd })
      store(...stored, row)
      return ok(row)
    },
  }: {
    start?: string
    snap?: (extra: object) => StatementSnapshot
    close?: (periodEnd: string) => Result<unknown>
  } = {}) {
    call.mockImplementation(async (_fn, _method, path, body) => {
      const { periodEnd = '2026-11-12' } = (body ?? {}) as { periodEnd?: string }
      if (path === '/statements/preview') {
        return ok({ snapshot: snap({ period: { start, end: periodEnd } }) })
      }
      if (path === '/statements/close') return close(periodEnd)
      // The draft's page refreshes it on open.
      return ok(stored.find((row) => path.includes(row.$id)))
    })
  }

  const covers = (start: string, end: string) =>
    `Covers ${formatDate(start)} – ${formatDate(end)}. Entries after ${formatDate(end)} go on the next one.`

  it('offers Close period now… to an admin only, never in an archived group', async () => {
    const cases = [
      ['admin', {}, true],
      // A group with no cycle gets a statement only this way.
      ['admin', { statementCycle: 'none' }, true],
      ['member', {}, false],
      ['viewer', {}, false],
      ['admin', { archivedAt: '2026-11-01T00:00:00.000Z' }, false],
    ] as const
    for (const [role, extra, shown] of cases) {
      mockGroup(role, extra)
      store()
      answer()
      renderAt('/groups/g1/statements')
      // The preview has come back, so the page is all there.
      await screen.findByText('Balance due', {}, { timeout: 3000 })
      expect(screen.queryByRole('button', { name: 'Close period now…' }) !== null).toBe(shown)
      cleanup()
    }
  })

  it('offers neither the button nor the period so far in a group with no statements', async () => {
    mockGroup('admin', { type: 'pair', statementCycle: 'none' })
    store()
    answer()
    renderAt('/groups/g1/statements')
    // The list is in, so the button would be there by now.
    await screen.findByText('No invoices yet.', {}, { timeout: 3000 })
    expect(screen.queryByText('Close period now…')).toBeNull()
    expect(screen.queryByText('Current period so far')).toBeNull()
    expect(call.mock.calls.map(([, , path]) => path)).not.toContain('/statements/preview')
  })

  it('says what a close would cover, then drafts it up to the day picked and opens it', async () => {
    store(statement('s1', FINAL))
    answer()
    const { router } = renderAt('/groups/g1/statements')
    fireEvent.click(await screen.findByText('Close period now…', {}, { timeout: 3000 }))
    expect(document.activeElement?.textContent).toBe('Close the period now?')
    // Today in the group's time zone.
    const input = screen.getByLabelText('Last day') as HTMLInputElement
    expect(input.value).toBe('2026-11-12')
    expect(input.max).toBe('2026-11-12')
    await screen.findByText(covers('2026-11-01', '2026-11-12'), {}, { timeout: 3000 })

    fireEvent.change(input, { target: { value: '2026-11-05' } })
    await screen.findByText(covers('2026-11-01', '2026-11-05'), {}, { timeout: 3000 })
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/preview', {
      groupId: 'g1',
      periodEnd: '2026-11-05',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close period' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g1/statements/s9'))
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/close', {
      groupId: 'g1',
      periodEnd: '2026-11-05',
    })
  })

  it('shows a refused close, and links to the earlier draft when one is unfinished', async () => {
    store()
    let refusal: Result<unknown> = {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'That day is after the period ends.' },
    }
    answer({ close: () => refusal })
    const { router } = renderAt('/groups/g1/statements')
    fireEvent.click(await screen.findByText('Close period now…', {}, { timeout: 3000 }))
    fireEvent.click(screen.getByRole('button', { name: 'Close period' }))
    await screen.findByText('That day is after the period ends.', {}, { timeout: 3000 })

    refusal = {
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Another draft is unfinished.',
        details: { draftId: 's2' },
      },
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close period' }))
    const link = await screen.findByText('Open the earlier draft', {}, { timeout: 3000 })
    expect(link.getAttribute('href')).toBe('/groups/g1/statements/s2')
    expect(screen.getByRole('alert').textContent).toBe(
      'Finalize or discard the earlier draft first. Open the earlier draft',
    )
    expect(router.state.location.pathname).toBe('/groups/g1/statements')
  })

  it('ends no later than the job’s period before the job drafts it, and checks the day', async () => {
    // 03:00 on 1 Nov in Sydney: October has ended, and the job drafts it at 06:00. September's
    // invoice was voided, so the next one starts on 1 October all the same.
    vi.setSystemTime(new Date('2026-10-31T16:00:00.000Z'))
    mockGroup('admin', { nextCloseAt: '2026-10-31T19:00:00.000Z' })
    store(statement('s1', { periodStart: '2026-09-01', periodEnd: '2026-09-30', status: 'void' }))
    answer({ start: '2026-10-01' })
    renderAt('/groups/g1/statements')
    fireEvent.click(await screen.findByText('Close period now…', {}, { timeout: 3000 }))
    const input = screen.getByLabelText('Last day') as HTMLInputElement
    expect(input.value).toBe('2026-10-31')
    expect(input.min).toBe('2026-10-01')
    expect(input.max).toBe('2026-10-31')
    await screen.findByText(covers('2026-10-01', '2026-10-31'), {}, { timeout: 3000 })

    fireEvent.change(input, { target: { value: '2026-11-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close period' }))
    await screen.findByText(`Pick ${formatDate('2026-10-31')} or earlier`)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close period' }))
    await screen.findByText('Required')
    // A day the latest statement covers is pointed out, from the list, not sent.
    fireEvent.change(input, { target: { value: '2026-09-30' } })
    await screen.findByText(
      `The next one starts on ${formatDate('2026-10-01')}, so pick that day or a later one.`,
      {},
      { timeout: 3000 },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close period' }))
    await screen.findByText(`Pick ${formatDate('2026-10-01')} or later`)
    expect(call.mock.calls.map(([, , path]) => path)).not.toContain('/statements/close')
  })

  it('doesn’t promise a draft at period end to a group with no cycle', async () => {
    mockGroup('admin', { statementCycle: 'none' })
    store()
    answer()
    renderAt('/groups/g1/statements')
    expect((await screen.findByText(/^No invoices yet/)).textContent).toBe('No invoices yet.')
  })

  it('shows a member the invoice so far: its period and balance due', async () => {
    mockGroup('member')
    store()
    answer()
    renderAt('/groups/g1/statements')
    const due = await screen.findByText('Balance due', {}, { timeout: 3000 })
    expect(due.closest('section')?.textContent).toBe(
      `Current period so far${formatDate('2026-11-01')} – ${formatDate('2026-11-12')}Balance due${formatNet(11500, 'AUD')}`,
    )
    // Today in the group's time zone, which the server works out.
    expect(call).toHaveBeenCalledWith('statements', 'POST', '/statements/preview', {
      groupId: 'g1',
    })
  })

  it('shows a housemate everyone’s closing so far, in words', async () => {
    mockGroup('member', { type: 'house', name: 'The flat' })
    store()
    const dan = {
      personId: 'pd',
      name: 'Dan',
      openingCents: 0,
      givenCents: 0,
      receivedCents: 0,
      closingCents: 0,
    }
    answer({
      snap: (extra) => divideSnapshot({ people: [...divideSnapshot().people, dan], ...extra }),
    })
    renderAt('/groups/g1/statements')
    const alice = await screen.findByText(/^Alice is owed/, {}, { timeout: 3000 })
    const section = alice.closest('section') as HTMLElement
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `Alice is owed ${formatNet(99100, 'AUD')}`,
      `Bob owes ${formatNet(70139, 'AUD')}`,
      `Cara owes ${formatNet(28961, 'AUD')}`,
      'Dan is settled up',
    ])
    expect(
      within(section).getByText(`${formatDate('2026-11-01')} – ${formatDate('2026-11-12')}`),
    ).toBeTruthy()
    expect(within(section).queryByText('Balance due')).toBeNull()
  })
})

describe('readSnapshot', () => {
  it('gives undefined for a snapshot it can’t read', () => {
    expect(readSnapshot('not json')).toBeUndefined()
    expect(readSnapshot('{"version":2}')).toBeUndefined()
    expect(readSnapshot(JSON.stringify(snapshot()))?.invoice?.balanceDueCents).toBe(11500)
  })
})
