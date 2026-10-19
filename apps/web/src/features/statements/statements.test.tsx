import type { Groups, Statements } from '@ledgerly/core/generated/rows'
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

describe('readSnapshot', () => {
  it('gives undefined for a snapshot it can’t read', () => {
    expect(readSnapshot('not json')).toBeUndefined()
    expect(readSnapshot('{"version":2}')).toBeUndefined()
    expect(readSnapshot(JSON.stringify(snapshot()))?.invoice?.balanceDueCents).toBe(11500)
  })
})
