import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { tablesDB } from '../../lib/appwrite'
import { useGroup, useMyMember } from '../groups/use-groups'
import { transactionRoutes } from './routes'

// #184: changing a posted employer or lend & borrow entry from `/transactions/{id}`.

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  tablesDB: { listRows: vi.fn(), getRow: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
// The viewer's person: the worker, Sam.
let mockPersonId = 'pw'
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: mockPersonId } }),
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

const acme = {
  $id: 'g1',
  type: 'employer',
  name: 'Acme',
  ownerPersonId: 'pw',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

const pair = { ...acme, $id: 'g2', type: 'pair', name: 'Fran' } as Groups

const EMPLOYER_MEMBERS = [
  { $id: 'm1', groupId: 'g1', personId: 'pw', displayName: 'Sam', role: 'admin' },
  { $id: 'm2', groupId: 'g1', personId: 'pe', displayName: 'Acme', role: 'viewer' },
] as Members[]

const PAIR_MEMBERS = [
  { $id: 'm3', groupId: 'g2', personId: 'pw', displayName: 'Sam', role: 'admin' },
  { $id: 'm4', groupId: 'g2', personId: 'pf', displayName: 'Fran', role: 'admin' },
] as Members[]

/** A posted row, its stored input as the ledger keeps it. */
function row(input: object, extra: Partial<Transactions> = {}): Transactions {
  return {
    $id: 't1',
    groupId: 'g1',
    kind: 'expense',
    status: 'posted',
    date: '2026-10-18',
    description: 'Supplies',
    category: 'work',
    totalCents: 4000,
    inputJson: JSON.stringify(input),
    statementId: null,
    voidReason: null,
    createdBy: 'pw',
    ...extra,
  } as Transactions
}

/** The PATCH body that sends `stored` back unchanged: the row's columns and its stored input. */
function sameBody(stored: Transactions) {
  return {
    id: stored.$id,
    groupId: stored.groupId,
    kind: stored.kind,
    date: stored.date,
    description: stored.description,
    totalCents: stored.totalCents,
    ...(stored.category ? { category: stored.category } : {}),
    ...JSON.parse(stored.inputJson),
  }
}

function mock(
  stored: Transactions,
  {
    group = acme,
    role = 'admin',
    members = EMPLOYER_MEMBERS,
    items = [],
  }: { group?: Groups; role?: Members['role']; members?: Members[]; items?: object[] } = {},
) {
  vi.mocked(useGroup).mockReturnValue({ data: group, isError: false } as never)
  vi.mocked(useMyMember).mockReturnValue({ data: { role }, isError: false } as never)
  getRow.mockResolvedValue(stored as never)
  listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
    const rows = tableId === 'members' ? members : tableId === 'items' ? items : []
    return { total: rows.length, rows }
  }) as never)
}

function renderPage() {
  const router = createMemoryRouter([transactionRoutes, { path: '*', element: null }], {
    initialEntries: ['/transactions/t1'],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { queryClient }
}

function ok(data: unknown): Result<unknown> {
  return { ok: true, data }
}

/** The ledger's answer to a PATCH: the row as it stores the body, its input in `inputJson`. */
function saves(stored: Transactions) {
  return (async (_fn: string, _method: string, _path: string, body: Record<string, unknown>) => {
    const { id, groupId, kind, date, description, totalCents, category, ...input } = body
    return ok({
      transaction: {
        ...stored,
        date,
        description,
        totalCents,
        category: category ?? null,
        inputJson: JSON.stringify(input),
      },
      shares: [],
    })
  }) as never
}

/** The page's alerts with something in them: the receipts section keeps an empty one mounted. */
function alerts() {
  return screen.queryAllByRole('alert').filter((alert) => alert.textContent !== '')
}

/** The last PATCH body sent. */
function patched() {
  const last = call.mock.calls.at(-1)
  expect(last?.slice(0, 3)).toEqual(['ledger', 'PATCH', '/transactions/t1'])
  return last?.[3]
}

/** Opens the form and waits for focus on its heading. */
async function openForm() {
  // The file's first test starts cold: wait for Edit by text, then find its role once. Polling
  // the first role query by name used up findByRole's 1 s under load.
  await screen.findByText('Edit', { selector: 'button' }, { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const heading = screen.getByRole('heading', { name: 'Change this entry' })
  expect(document.activeElement).toBe(heading)
  return heading
}

/** Waits until every read is in, items included, so no Edit is the answer. */
async function settled(queryClient: QueryClient) {
  await screen.findByText('Group')
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
}

beforeEach(() => {
  mockPersonId = 'pw'
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

const RADIO = {
  reimbursable: 'I paid for them (reimbursable)',
  onTheirCard: 'Bought on their card, for work',
  personalOnTheirCard: 'Personal, on their card / cash advance',
  paymentReceived: 'Payment received',
}

describe('TransactionPage, an employer entry', () => {
  const note = { note: 'From the hardware shop' }
  it.each([
    [
      'reimbursable',
      row({
        payers: [{ personId: 'pw', cents: 4000 }],
        split: { mode: 'equal', personIds: ['pe'] },
        ...note,
      }),
    ],
    [
      'onTheirCard',
      row({
        payers: [{ personId: 'pe', cents: 4000 }],
        split: { mode: 'equal', personIds: ['pe'] },
      }),
    ],
    [
      'personalOnTheirCard',
      row(
        {
          payers: [{ personId: 'pe', cents: 4000 }],
          split: { mode: 'equal', personIds: ['pw'] },
          ...note,
        },
        { category: null },
      ),
    ],
    [
      'paymentReceived',
      row(
        { payment: { fromPersonId: 'pe', toPersonId: 'pw' } },
        { kind: 'payment', category: null, description: 'October pay' },
      ),
    ],
  ] as const)('opens %s as stored, saves it unchanged, then a new amount', async (type, stored) => {
    mock(stored)
    call.mockImplementation(saves(stored))
    renderPage()
    await openForm()
    expect(
      (
        screen.getByRole('radio', {
          name: (name: string) => name.startsWith(RADIO[type]),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true)
    // Only choices of the row's kind.
    const offered = screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)
    expect(offered).toEqual(
      type === 'paymentReceived'
        ? ['paymentReceived']
        : ['reimbursable', 'onTheirCard', 'personalOnTheirCard'],
    )
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('40.00')
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-18')
    expect((screen.getByLabelText('Note (optional)') as HTMLInputElement).value).toBe(
      'note' in JSON.parse(stored.inputJson) ? 'From the hardware shop' : '',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(patched()).toStrictEqual(sameBody(stored))
    // It closes with no error, and focus goes back to Edit.
    const edit = await screen.findByRole('button', { name: 'Edit' })
    await waitFor(() => expect(document.activeElement).toBe(edit))
    expect(alerts()).toEqual([])

    await openForm()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '55.10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const before = sameBody(stored)
    expect(patched()).toStrictEqual({
      ...before,
      totalCents: 5510,
      ...(before.payers ? { payers: [{ ...before.payers[0], cents: 5510 }] } : {}),
    })
    // The page shows the saved row, and Edit opens on it.
    expect(await screen.findByText(/^A?\$55\.10$/)).toBeTruthy()
    await openForm()
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('55.10')
  })

  const reimbursable = row({
    payers: [{ personId: 'pw', cents: 4000 }],
    split: { mode: 'equal', personIds: ['pe'] },
  })

  it('switches between the expense presets, sending the new payers and split', async () => {
    mock(reimbursable)
    call.mockResolvedValue(ok({ transaction: reimbursable, shares: [] }))
    renderPage()
    await openForm()
    fireEvent.click(
      screen.getByRole('radio', { name: (name: string) => name.startsWith(RADIO.onTheirCard) }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(patched()).toMatchObject({
      kind: 'expense',
      payers: [{ personId: 'pe', cents: 4000 }],
      split: { mode: 'equal', personIds: ['pe'] },
    })
  })

  it('refreshes the shares, balances, history and calendar after a save', async () => {
    mock(reimbursable)
    const shares = [{ $id: 's9', personId: 'pw', givenCents: 4000, receivedCents: 0 }]
    call.mockResolvedValue(ok({ transaction: reimbursable, shares }))
    const { queryClient } = renderPage()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['balances', 'g1'] }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history', 'g1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] })
    expect(queryClient.getQueryData(['transaction', 't1', 'shares'])).toEqual(shares)
  })

  it('closes on Cancel with nothing sent, and focus back on Edit', async () => {
    mock(reimbursable)
    renderPage()
    await openForm()
    // Voiding would take the form, and what was typed, away.
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'Change this entry' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }))
    expect(call).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Void' })).toBeTruthy()
    // Opened again, it starts from the row.
    await openForm()
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('40.00')
  })

  it('holds Save and Cancel while saving, keeping focus, and closes once it’s saved', async () => {
    mock(reimbursable)
    let answer!: (result: Result<unknown>) => void
    call.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    renderPage()
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    // aria-disabled, not disabled, so focus stays on it if the save fails.
    expect(saving.getAttribute('aria-disabled')).toBe('true')
    expect((saving as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(saving)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Change this entry' })).toBeTruthy()
    await act(async () => answer(ok({ transaction: reimbursable, shares: [] })))
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['LOCKED', 'It’s on a final invoice.', 'It’s on a final invoice.'],
    [
      'ARCHIVED',
      'Archived.',
      'This group has been archived, so it can’t be changed any more. Reload the page to see it as it is now.',
    ],
    ['FORBIDDEN', 'Only an admin can change this.', 'Only an admin can change this.'],
    ['CONFLICT', 'It changed meanwhile.', 'It changed meanwhile.'],
    ['NOT_FOUND', 'Not found.', 'Not found.'],
    ['VALIDATION_FAILED', 'The date is too far ahead.', 'The date is too far ahead.'],
  ] as const)('shows %s in plain words next to the form', async (code, message, shown) => {
    mock(reimbursable)
    call.mockResolvedValue({ ok: false, error: { code, message } })
    const { queryClient } = renderPage()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(alerts().map((alert) => alert.textContent)).toEqual([shown]))
    // The form stays open, so nothing typed is lost.
    expect(screen.getByRole('heading', { name: 'Change this entry' })).toBeTruthy()
    // The first three read the row, its group, the caller's role and the members again.
    const reread = ['LOCKED', 'ARCHIVED', 'FORBIDDEN'].includes(code)
    expect(invalidate).toHaveBeenCalledTimes(reread ? 4 : 0)
    if (reread) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transaction', 't1'], exact: true })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['group', 'g1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['member', 'g1'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['members', 'g1'] })
    }
  })

  it.each([
    ['LOCKED', 'It’s on a final invoice.', { row: { ...reimbursable, statementId: 'st1' } }],
    ['FORBIDDEN', 'Only an admin can change this.', { role: 'viewer' }],
  ] as const)(
    'keeps a %s refusal, with focus on it, once the re-read hides the form',
    async (code, message, after) => {
      mock(reimbursable)
      call.mockResolvedValue({ ok: false, error: { code, message } })
      renderPage()
      await openForm()
      // What the re-read finds: the row locked meanwhile, or the caller no longer an admin.
      if ('row' in after) getRow.mockResolvedValue(after.row as never)
      if ('role' in after) {
        vi.mocked(useMyMember).mockReturnValue({
          data: { role: after.role },
          isError: false,
        } as never)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Change this entry' })).toBeNull(),
      )
      const [alert, ...more] = alerts()
      expect(more).toEqual([])
      expect(alert?.textContent).toBe(message)
      expect(document.activeElement).toBe(alert)
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    },
  )

  it('says so, with no Edit, for a stored input that matches no choice', async () => {
    mock(
      row({
        payers: [
          { personId: 'pw', cents: 2000 },
          { personId: 'pe', cents: 2000 },
        ],
        split: { mode: 'equal', personIds: ['pe'] },
      }),
    )
    renderPage()
    expect(
      await screen.findByText('This entry can’t be changed here. Void it and add it again.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

describe('TransactionPage, a lend & borrow entry', () => {
  const lent = row(
    { payers: [{ personId: 'pw', cents: 4000 }], split: { mode: 'equal', personIds: ['pf'] } },
    { groupId: 'g2', kind: 'loan', category: null, description: 'Lent' },
  )
  const borrowed = row(
    {
      payers: [{ personId: 'pf', cents: 4000 }],
      split: { mode: 'equal', personIds: ['pw'] },
      note: 'Until Friday',
    },
    { groupId: 'g2', kind: 'loan', category: null, description: 'Rent', createdBy: 'pf' },
  )
  const repaidByMe = row(
    { payment: { fromPersonId: 'pw', toPersonId: 'pf' } },
    { groupId: 'g2', kind: 'payment', category: null, description: 'Repaid' },
  )
  const repaidByThem = row(
    { payment: { fromPersonId: 'pf', toPersonId: 'pw' } },
    { groupId: 'g2', kind: 'payment', category: null, description: 'Repaid' },
  )
  const pairOptions = { group: pair, members: PAIR_MEMBERS }

  it.each([
    ['lent', lent, 'I lent Fran money', undefined],
    ['borrowed', borrowed, 'I borrowed from Fran', undefined],
    ['repaid by me', repaidByMe, 'Money was paid back', 'me'],
    ['repaid by them', repaidByThem, 'Money was paid back', 'them'],
  ] as const)(
    'opens %s as stored, saves it unchanged, then a new amount',
    async (_, stored, radio, from) => {
      mock(stored, pairOptions)
      call.mockImplementation(saves(stored))
      renderPage()
      await openForm()
      expect((screen.getByRole('radio', { name: radio }) as HTMLInputElement).checked).toBe(true)
      const offered = screen.getAllByRole('radio').map((input) => (input as HTMLInputElement).value)
      expect(offered).toEqual(stored.kind === 'payment' ? ['repaid'] : ['lent', 'borrowed'])
      if (from) {
        expect((screen.getByLabelText('Who paid back?') as HTMLSelectElement).value).toBe(from)
      }
      // A change starts from the row, not from the balance.
      expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('40.00')

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(patched()).toStrictEqual(sameBody(stored))
      const edit = await screen.findByRole('button', { name: 'Edit' })
      await waitFor(() => expect(document.activeElement).toBe(edit))

      await openForm()
      fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '0.99' } })
      // No warning about paying back more than is owed: the balance already counts this entry.
      expect(screen.queryByText(/owed the other way/)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
      const before = sameBody(stored)
      expect(patched()).toStrictEqual({
        ...before,
        totalCents: 99,
        ...(before.payers ? { payers: [{ ...before.payers[0], cents: 99 }] } : {}),
      })
      await openForm()
      expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('0.99')
    },
  )

  it('switches a loan between lent and borrowed, and who repaid', async () => {
    mock(lent, pairOptions)
    call.mockResolvedValue(ok({ transaction: lent, shares: [] }))
    renderPage()
    await openForm()
    // Saved blank, its description was the default, which follows the new choice.
    expect((screen.getByLabelText('Description (optional)') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('radio', { name: 'I borrowed from Fran' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(patched()).toMatchObject({
      description: 'Borrowed',
      payers: [{ personId: 'pf', cents: 4000 }],
      split: { mode: 'equal', personIds: ['pw'] },
    })
    cleanup()
    call.mockReset()
    mock(repaidByMe, pairOptions)
    call.mockResolvedValue(ok({ transaction: repaidByMe, shares: [] }))
    renderPage()
    await openForm()
    fireEvent.change(screen.getByLabelText('Who paid back?'), { target: { value: 'them' } })
    // A change keeps the amount as stored, whoever repaid.
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('40.00')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(patched()).toMatchObject({ payment: { fromPersonId: 'pf', toPersonId: 'pw' } })
  })

  it('shows a refusal as the function words it, never as a possible duplicate', async () => {
    mock(lent, pairOptions)
    call.mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'It changed.' } })
    renderPage()
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(alerts().map((alert) => alert.textContent)).toEqual(['It changed.']))
  })

  it('closes on Cancel, with focus back on Edit, and holds Cancel while saving', async () => {
    mock(lent, pairOptions)
    renderPage()
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }))
    expect(call).not.toHaveBeenCalled()
    call.mockReturnValue(new Promise(() => {}))
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Saving…' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Change this entry' })).toBeTruthy()
  })
})

describe('TransactionPage, who sees Edit', () => {
  const reimbursable = row({
    payers: [{ personId: 'pw', cents: 4000 }],
    split: { mode: 'equal', personIds: ['pe'] },
  })
  const lent = row(
    { payers: [{ personId: 'pw', cents: 4000 }], split: { mode: 'equal', personIds: ['pf'] } },
    { groupId: 'g2', kind: 'loan', category: null },
  )

  it.each([
    ['an admin', reimbursable, {}, true],
    ['a member who added it', lent, { group: pair, members: PAIR_MEMBERS, role: 'member' }, true],
    [
      'a member who didn’t add it',
      { ...lent, createdBy: 'pf' },
      { group: pair, members: PAIR_MEMBERS, role: 'member' },
      false,
    ],
    ['a viewer', lent, { group: pair, members: PAIR_MEMBERS, role: 'viewer' }, false],
    ['a locked row', { ...reimbursable, statementId: 'st1' }, {}, false],
    [
      'an archived group',
      reimbursable,
      { group: { ...acme, archivedAt: '2026-10-01T00:00:00Z' } },
      false,
    ],
    ['a void row', { ...reimbursable, status: 'void' }, {}, false],
    ['a scheduled row', { ...reimbursable, status: 'scheduled' }, {}, false],
    ['a due row', { ...lent, status: 'due' }, { group: pair, members: PAIR_MEMBERS }, false],
    [
      'an itemised row',
      reimbursable,
      {
        items: [
          {
            $id: 'i1',
            transactionId: 't1',
            position: 0,
            name: 'Paint',
            amountCents: 4000,
            splitJson: JSON.stringify({ mode: 'equal', personIds: ['pe'] }),
          },
        ],
      },
      false,
    ],
    ['a loan in an employer group', { ...lent, groupId: 'g1' }, {}, false],
    [
      'an expense in a pair group',
      { ...reimbursable, groupId: 'g2' },
      { group: pair, members: PAIR_MEMBERS },
      false,
    ],
  ] as const)('%s: %s', async (_, stored, options, shown) => {
    mock(stored as Transactions, options as Parameters<typeof mock>[1])
    const { queryClient } = renderPage()
    await settled(queryClient)
    if (shown) expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
    else expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    // Nothing that can't be changed says to void it.
    expect(screen.queryByText(/can’t be changed here/)).toBeNull()
  })

  it('offers an employer entry to the worker only, whose side its choices are worded from', async () => {
    mockPersonId = 'pe'
    mock(reimbursable)
    const { queryClient } = renderPage()
    await settled(queryClient)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(
      screen.getByText('Only the person this group pays changes expenses and payments here.'),
    ).toBeTruthy()
    // Void stays, by the creator-or-admin rule.
    expect(screen.getByRole('button', { name: 'Void' })).toBeTruthy()
  })

  it('says so when it can’t check the row for items', async () => {
    mock(reimbursable)
    listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
      if (tableId === 'items') throw new Error('Offline')
      const rows = tableId === 'members' ? EMPLOYER_MEMBERS : []
      return { total: rows.length, rows }
    }) as never)
    renderPage()
    // The page's own message (#42); Edit waits for the items, so it never shows.
    expect(
      await screen.findByText(
        'We couldn’t load this expense’s items. Reload the page to try again.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('reads the items once, with the page, and none for a loan', async () => {
    mock(reimbursable)
    const { queryClient } = renderPage()
    await screen.findByRole('button', { name: 'Edit' })
    await settled(queryClient)
    const itemReads = () =>
      listRows.mock.calls.filter(
        ([params]) => (params as unknown as { tableId: string }).tableId === 'items',
      ).length
    expect(itemReads()).toBe(1)
    cleanup()
    listRows.mockClear()
    mock(lent, { group: pair, members: PAIR_MEMBERS })
    const second = renderPage()
    await screen.findByRole('button', { name: 'Edit' })
    await settled(second.queryClient)
    expect(itemReads()).toBe(0)
  })
})

describe('TransactionPage, bills and shifts', () => {
  const personal = { ...acme, $id: 'g4', type: 'personal', name: 'Me' } as Groups
  const bill = row({}, { groupId: 'g4', kind: 'bill', status: 'due', description: 'Power' })
  const shift = row({ shift: { minutes: 480, rateCents: 2500 } }, { kind: 'shift', category: null })

  it('links a due personal or house bill and a shift to their own pages', async () => {
    for (const group of [personal, { ...personal, type: 'house', name: 'The flat' } as Groups]) {
      mock(bill, { group })
      renderPage()
      expect(
        (await screen.findByRole('link', { name: 'Change this bill' })).getAttribute('href'),
      ).toBe('/bills/t1')
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
      cleanup()
    }
    for (const status of ['scheduled', 'posted'] as const) {
      mock({ ...shift, status })
      renderPage()
      expect(
        (await screen.findByRole('link', { name: 'Change this shift' })).getAttribute('href'),
      ).toBe('/shifts/t1')
      cleanup()
    }
  })

  it.each([
    ['a paid bill', { ...bill, status: 'posted' }, personal, 'admin'],
    ['a bill outside a personal group', { ...bill, groupId: 'g1' }, acme, 'admin'],
    ['a running shift', { ...shift, status: 'running' }, acme, 'admin'],
    ['a void shift', { ...shift, status: 'void' }, acme, 'admin'],
    ['a locked shift', { ...shift, statementId: 'st1' }, acme, 'admin'],
    ['a shift, to a viewer', shift, acme, 'viewer'],
    [
      'a bill in an archived group',
      bill,
      { ...personal, archivedAt: '2026-10-01T00:00:00Z' },
      'admin',
    ],
  ] as const)('links nothing for %s', async (_, stored, group, role) => {
    mock(stored as Transactions, { group, role })
    renderPage()
    const details = await screen.findByText('Group')
    expect(details).toBeTruthy()
    expect(screen.queryByRole('link', { name: /^Change this/ })).toBeNull()
    expect(within(document.body).queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

// #202: changing a posted house expense with the house expense form.
describe('Edit a house expense (#202)', () => {
  const flat = {
    ...acme,
    $id: 'g3',
    type: 'house',
    name: 'The flat',
    ownerPersonId: 'pc',
  } as Groups
  const HOUSE_MEMBERS = [
    { personId: 'pw', displayName: 'Sam', joinedOn: '2026-01-01' },
    { personId: 'pa', displayName: 'Alice', joinedOn: '2026-01-01' },
    // Cara moved in on 1 March: a date before that wouldn't tick her by default.
    { personId: 'pc', displayName: 'Cara', joinedOn: '2026-03-01' },
  ].map(
    (member, n) =>
      ({ $id: `h${n}`, groupId: 'g3', role: 'member', leftOn: null, ...member }) as Members,
  )
  // Sam paid 90.00; Alice 60.00 and Sam and Cara 15.00 each, as amounts.
  const groceries = row(
    {
      payers: [{ personId: 'pw', cents: 9000 }],
      split: {
        mode: 'exact',
        amounts: [
          { personId: 'pa', cents: 6000 },
          { personId: 'pc', cents: 1500 },
          { personId: 'pw', cents: 1500 },
        ],
      },
      note: 'Market',
    },
    { groupId: 'g3', description: 'Groceries', category: 'groceries', totalCents: 9000 },
  )
  const house = (stored = groceries, role: Members['role'] = 'admin', extra = {}) =>
    mock(stored, { group: flat, members: HOUSE_MEMBERS, role, ...extra })

  async function openHouseForm() {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const heading = screen.getByRole('heading', { name: 'Change this expense' })
    expect(document.activeElement).toBe(heading)
  }

  const ticked = (name: string) =>
    (screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }) as HTMLInputElement).checked

  it('fills the form from the row and sends it back exactly when saved unchanged', async () => {
    house()
    call.mockImplementation(saves(groceries))
    renderPage()
    await openHouseForm()
    expect((screen.getByLabelText('Amount (AUD)') as HTMLInputElement).value).toBe('90.00')
    expect((screen.getByLabelText('Paid by') as HTMLSelectElement).value).toBe('pw')
    expect((screen.getByRole('radio', { name: 'By amounts' }) as HTMLInputElement).checked).toBe(
      true,
    )
    expect((screen.getByLabelText('Alice’s amount (AUD)') as HTMLInputElement).value).toBe('60.00')
    expect((screen.getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('Market')
    // A change can't itemise it (decision 1).
    expect(screen.queryByLabelText('Itemise this receipt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(patched()).toStrictEqual(sameBody(groceries))
    // The page stays, and focus goes back to Edit (decision 3).
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' })),
    )
  })

  it('sends a changed amount and split, with the row’s own id', async () => {
    house()
    call.mockImplementation(saves(groceries))
    renderPage()
    await openHouseForm()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Alice’s amount (AUD)'), { target: { value: '70' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(patched()).toMatchObject({
      id: 't1',
      totalCents: 10000,
      payers: [{ personId: 'pw', cents: 10000 }],
      split: {
        mode: 'exact',
        amounts: [
          { personId: 'pa', cents: 7000 },
          { personId: 'pc', cents: 1500 },
          { personId: 'pw', cents: 1500 },
        ],
      },
    })
  })

  it('keeps who shares it when the date changes (decision 2)', async () => {
    house()
    renderPage()
    await openHouseForm()
    expect(ticked('Cara')).toBe(true)
    // Before Cara moved in: a new expense would untick her.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-01' } })
    expect(ticked('Cara')).toBe(true)
  })

  it('shows the function’s own CONFLICT message, never the duplicate warning', async () => {
    house()
    call.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Someone else changed it. Reload and try again.' },
    })
    renderPage()
    await openHouseForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Someone else changed it. Reload and try again.')).toBeTruthy()
    expect(screen.queryByText(/may already have been saved/)).toBeNull()
  })

  it('keeps Save and Cancel from acting while it saves, and Cancel sends nothing', async () => {
    house()
    let answer!: (value: Result<unknown>) => void
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderPage()
    await openHouseForm()
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const busy = screen.getByRole('button', { name: 'Saving…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(busy)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Change this expense' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull()
    await act(async () => answer(ok({ transaction: groceries, shares: [] })))
    expect(call).toHaveBeenCalledTimes(1)
    cleanup()
    call.mockClear()
    house()
    renderPage()
    await openHouseForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }))
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['an admin', groceries, 'admin', {}, true],
    ['the member who added it', groceries, 'member', {}, true],
    ['a member who didn’t add it', { ...groceries, createdBy: 'pa' }, 'member', {}, false],
    ['a viewer', groceries, 'viewer', {}, false],
    ['a locked row', { ...groceries, statementId: 'st1' }, 'admin', {}, false],
    ['a void row', { ...groceries, status: 'void' }, 'admin', {}, false],
    ['a paid house bill', { ...groceries, kind: 'bill' }, 'admin', {}, false],
    ['a house payment', { ...groceries, kind: 'payment' }, 'admin', {}, false],
    [
      'an archived house',
      groceries,
      'admin',
      { group: { ...flat, archivedAt: '2026-10-01T00:00:00Z' } },
      false,
    ],
  ] as const)('%s: Edit shown is %s', async (_, stored, role, extra, shown) => {
    house(stored as Transactions, role, extra)
    const { queryClient } = renderPage()
    await settled(queryClient)
    if (shown) expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
    else expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByText(/can’t be changed here/)).toBeNull()
  })

  it.each([
    ['LOCKED', 'It’s on a final invoice.', 'It’s on a final invoice.'],
    [
      'ARCHIVED',
      'Archived.',
      'This group has been archived, so it can’t be changed any more. Reload the page to see it as it is now.',
    ],
    ['FORBIDDEN', 'Only an admin can change this.', 'Only an admin can change this.'],
    ['NOT_FOUND', 'Not found.', 'Not found.'],
    ['VALIDATION_FAILED', 'The date is too far ahead.', 'The date is too far ahead.'],
  ] as const)(
    'shows %s next to the house form, re-reading as #211 does',
    async (code, message, shown) => {
      house()
      call.mockResolvedValue({ ok: false, error: { code, message } })
      const { queryClient } = renderPage()
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      await openHouseForm()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(alerts().map((alert) => alert.textContent)).toEqual([shown]))
      expect(screen.getByRole('heading', { name: 'Change this expense' })).toBeTruthy()
      const reread = ['LOCKED', 'ARCHIVED', 'FORBIDDEN'].includes(code)
      expect(invalidate).toHaveBeenCalledTimes(reread ? 4 : 0)
      if (reread) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transaction', 't1'], exact: true })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['group', 'g3'] })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['member', 'g3'] })
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['members', 'g3'] })
      }
    },
  )

  it('keeps a LOCKED refusal, with focus on it, once the re-read hides the house form', async () => {
    house()
    call.mockResolvedValue({
      ok: false,
      error: { code: 'LOCKED', message: 'It’s on a final invoice.' },
    })
    renderPage()
    await openHouseForm()
    getRow.mockResolvedValue({ ...groceries, statementId: 'st1' } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Change this expense' })).toBeNull(),
    )
    const [alert, ...more] = alerts()
    expect(more).toEqual([])
    expect(alert?.textContent).toBe('It’s on a final invoice.')
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('says a stored input it can’t show can’t be changed here (decision 4)', async () => {
    house(
      row(
        { payers: [{ personId: 'pw', cents: 4000 }], split: { mode: 'days' } },
        { groupId: 'g3' },
      ),
    )
    const { queryClient } = renderPage()
    await settled(queryClient)
    expect(
      await screen.findByText('This entry can’t be changed here. Void it and add it again.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  describe('itemised (#225)', () => {
    const everyone = { mode: 'equal', personIds: ['pa', 'pc', 'pw'] }
    type Item = { name: string; amountCents: number; category?: string; split: object }
    // User flow 7 in this house: Sam pays; milk, bread and the discount for everyone, beer for Sam.
    const FLOW_7: Item[] = [
      { name: 'Milk', amountCents: 450, category: 'groceries', split: everyone },
      { name: 'Bread', amountCents: 600, split: everyone },
      { name: 'Beer', amountCents: 2000, split: { mode: 'equal', personIds: ['pw'] } },
      { name: 'Discount', amountCents: -150, split: everyone },
    ]
    /** The `items` rows the ledger keeps (data-model.md#items), in `position` order. */
    const itemRows = (items: readonly Item[], quantity = 1) =>
      items.map(({ split, category, ...item }, position) => ({
        $id: `i${position}`,
        transactionId: 't1',
        position,
        quantity,
        category: category ?? null,
        splitJson: JSON.stringify(split),
        ...item,
      }))
    const sum = (items: readonly Item[]) =>
      items.reduce((total, item) => total + item.amountCents, 0)
    const receipt = (items: readonly Item[], payers = [{ personId: 'pw', cents: sum(items) }]) =>
      row(
        { payers, note: 'Corner shop' },
        { groupId: 'g3', description: 'Shop', category: 'groceries', totalCents: sum(items) },
      )
    const shop = receipt(FLOW_7)
    const itemised = (
      stored = shop,
      items: readonly Item[] = FLOW_7,
      role: Members['role'] = 'admin',
    ) => house(stored, role, { items: itemRows(items) })

    /** The ledger's answer to a PATCH with items: their rows, and the total they add up to. */
    function savesItems(stored: Transactions) {
      return (async (
        _fn: string,
        _method: string,
        _path: string,
        body: Record<string, unknown>,
      ) => {
        const { id, groupId, kind, date, description, category, items, ...input } = body
        const sent = items as Item[]
        return ok({
          transaction: {
            ...stored,
            date,
            description,
            category: category ?? null,
            totalCents: sum(sent),
            inputJson: JSON.stringify(input),
          },
          shares: [],
          items: itemRows(sent),
        })
      }) as never
    }

    const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement
    const forItem = (item: number, name: string) =>
      within(screen.getByRole('group', { name: `Who item ${item} is for` })).getByRole('checkbox', {
        name,
      }) as HTMLInputElement

    it('fills the items from their rows and sends them back exactly when saved unchanged', async () => {
      itemised()
      call.mockImplementation(savesItems(shop))
      renderPage()
      await openHouseForm()
      // It stays itemised (decision 3).
      expect(screen.queryByRole('checkbox', { name: 'Itemise this receipt' })).toBeNull()
      expect(screen.queryByLabelText('Amount (AUD)')).toBeNull()
      expect([1, 2, 3, 4].map((n) => field(`Item ${n} name`).value)).toEqual([
        'Milk',
        'Bread',
        'Beer',
        'Discount',
      ])
      // A discount reads back with its minus, Discount unticked (decision 1).
      expect(field('Item 4 amount (AUD)').value).toBe('-1.50')
      expect(field('Item 4 is a discount').checked).toBe(false)
      expect((screen.getByLabelText('Item 1 category') as HTMLSelectElement).value).toBe(
        'groceries',
      )
      expect(['Alice', 'Cara', 'Sam'].map((name) => forItem(3, name).checked)).toEqual([
        false,
        false,
        true,
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(patched()).toStrictEqual({
        id: 't1',
        groupId: 'g3',
        kind: 'expense',
        date: '2026-10-18',
        description: 'Shop',
        category: 'groceries',
        note: 'Corner shop',
        payers: [{ personId: 'pw', cents: 2900 }],
        items: FLOW_7,
      })
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' })),
      )
    })

    it('sends changed items, then shows them on the page', async () => {
      itemised()
      call.mockImplementation(savesItems(shop))
      renderPage()
      await openHouseForm()
      // The milk isn't Alice's any more, the bread and the discount go, and eggs come in by
      // shares.
      fireEvent.click(forItem(1, 'Alice'))
      fireEvent.click(screen.getByRole('button', { name: 'Remove item 2' }))
      fireEvent.click(screen.getByRole('button', { name: 'Remove item 3' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
      fireEvent.change(field('Item 3 name'), { target: { value: 'Eggs' } })
      fireEvent.change(field('Item 3 amount (AUD)'), { target: { value: '6' } })
      fireEvent.click(
        within(screen.getByRole('group', { name: 'How to split item 3' })).getByRole('radio', {
          name: 'By shares',
        }),
      )
      fireEvent.change(field('Alice’s shares of item 3'), { target: { value: '1' } })
      fireEvent.change(field('Cara’s shares of item 3'), { target: { value: '1' } })
      fireEvent.change(field('Sam’s shares of item 3'), { target: { value: '2' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      const sent = [
        {
          name: 'Milk',
          amountCents: 450,
          category: 'groceries',
          split: { mode: 'equal', personIds: ['pc', 'pw'] },
        },
        FLOW_7[2],
        {
          name: 'Eggs',
          amountCents: 600,
          split: {
            mode: 'weights',
            weights: [
              { personId: 'pa', weight: 1 },
              { personId: 'pc', weight: 1 },
              { personId: 'pw', weight: 2 },
            ],
          },
        },
      ]
      expect(patched()).toMatchObject({ payers: [{ personId: 'pw', cents: 3050 }], items: sent })
      expect(patched()).not.toHaveProperty('totalCents')
      expect(patched()).not.toHaveProperty('split')
      // The Items section and the Split row show what was saved.
      const list = await screen.findByRole('region', { name: 'Items' })
      expect(within(list).getByText(/^Eggs:/)).toBeTruthy()
      expect(within(list).queryByText(/^Bread:/)).toBeNull()
      expect(within(list).queryByText(/^Discount:/)).toBeNull()
      expect(screen.getByText('Itemised (3 items)')).toBeTruthy()
    })

    it('puts someone newly sharing the receipt in every item (Q2)', async () => {
      // Cara is in no item, so she isn't sharing until she's ticked.
      const noCara: Item[] = [
        { name: 'Milk', amountCents: 450, split: { mode: 'equal', personIds: ['pa', 'pw'] } },
        FLOW_7[2] as Item,
      ]
      const stored = receipt(noCara)
      itemised(stored, noCara)
      call.mockImplementation(savesItems(stored))
      renderPage()
      await openHouseForm()
      const sharing = within(screen.getByRole('group', { name: 'Who’s sharing this receipt' }))
      expect((sharing.getByRole('checkbox', { name: /^Cara/ }) as HTMLInputElement).checked).toBe(
        false,
      )
      fireEvent.click(sharing.getByRole('checkbox', { name: /^Cara/ }))
      expect([forItem(1, 'Cara').checked, forItem(2, 'Cara').checked]).toEqual([true, true])
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(patched()).toMatchObject({
        items: [
          { name: 'Milk', split: { mode: 'equal', personIds: ['pa', 'pc', 'pw'] } },
          { name: 'Beer', split: { mode: 'equal', personIds: ['pc', 'pw'] } },
        ],
      })
    })

    it('refuses a discount that takes someone below 0 (I-4), as on create', async () => {
      itemised()
      renderPage()
      await openHouseForm()
      fireEvent.change(field('Item 4 amount (AUD)'), { target: { value: '-20' } })
      expect(
        await screen.findByText('A discount can’t make anyone’s part go below zero.'),
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(alerts().length).toBeGreaterThan(0))
      expect(call).not.toHaveBeenCalled()
    })

    it('keeps a refund a refund (decision 4)', async () => {
      const back: Item[] = [
        {
          name: 'Kettle back',
          amountCents: -3000,
          split: { mode: 'equal', personIds: ['pa', 'pw'] },
        },
      ]
      const refund = receipt(back)
      itemised(refund, back)
      call.mockImplementation(savesItems(refund))
      renderPage()
      await openHouseForm()
      expect((screen.getByLabelText('Refunded to') as HTMLSelectElement).value).toBe('pw')
      expect(screen.queryByRole('checkbox', { name: 'Several people paid' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(patched()).toMatchObject({ payers: [{ personId: 'pw', cents: -3000 }], items: back })
    })

    it('keeps one Items heading per id, the form’s a level down', async () => {
      itemised()
      renderPage()
      await openHouseForm()
      expect(document.querySelectorAll('[id="items-heading"]')).toHaveLength(1)
      const items = within(screen.getByRole('region', { name: 'Change this expense' }))
      expect(items.getByRole('heading', { name: 'Items' }).tagName).toBe('H3')
    })

    it.each([
      ['an admin', 'admin', true],
      ['the member who added it', 'member', true],
      ['a viewer', 'viewer', false],
    ] as const)('%s: Edit shown is %s', async (_, role, shown) => {
      itemised(shop, FLOW_7, role)
      const { queryClient } = renderPage()
      await settled(queryClient)
      if (shown) expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
      else expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    })

    it('offers no Edit when the items can’t be read, and says so', async () => {
      itemised()
      listRows.mockImplementation((async ({ tableId }: { tableId: string }) => {
        if (tableId === 'items') throw new Error('offline')
        const rows = tableId === 'members' ? HOUSE_MEMBERS : []
        return { total: rows.length, rows }
      }) as never)
      const { queryClient } = renderPage()
      await settled(queryClient)
      expect(await screen.findByText(/We couldn’t load this expense’s items/)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
      // Not read as a plain expense meanwhile.
      expect(screen.queryByText(/can’t be changed here/)).toBeNull()
    })

    it('says an item it can’t show can’t be changed here (decision 2)', async () => {
      house(shop, 'admin', { items: itemRows(FLOW_7, 2) })
      const { queryClient } = renderPage()
      await settled(queryClient)
      expect(
        await screen.findByText('This entry can’t be changed here. Void it and add it again.'),
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    })
  })
})

// #402: changing a posted personal income or expense with the entry form it was made with.
describe('Edit a personal income or expense (#402)', () => {
  const personal = { ...acme, $id: 'g5', type: 'personal', name: 'Personal' } as Groups
  const ME = [
    { $id: 'm5', groupId: 'g5', personId: 'pw', displayName: 'Sam', role: 'admin' },
  ] as Members[]
  const income = row(
    { note: 'ATO' },
    { groupId: 'g5', kind: 'income', description: 'Refund', category: null, totalCents: 1999 },
  )
  // ledger.md#transaction-kinds: in a personal group the owner pays, for themselves.
  const groceries = row(
    { payers: [{ personId: 'pw', cents: 4000 }], split: { mode: 'equal', personIds: ['pw'] } },
    { groupId: 'g5', description: 'Groceries', category: 'groceries' },
  )
  const mine = (stored: Transactions) => mock(stored, { group: personal, members: ME })

  it.each([
    ['an income', income, 'Income', 'Expense'],
    ['an expense', groceries, 'Expense', 'Income'],
  ])(
    'fills the form from %s and sends it back exactly when saved unchanged',
    async (_, stored, own, other) => {
      mine(stored)
      call.mockImplementation(saves(stored))
      renderPage()
      await openForm()
      // The kind stays: the ledger refuses a new one.
      const choice = screen.getByRole('radio', { name: new RegExp(`^${own}`) }) as HTMLInputElement
      expect(choice.checked).toBe(true)
      expect(screen.queryByRole('radio', { name: new RegExp(`^${other}`) })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(patched()).toStrictEqual(sameBody(stored))
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' })),
      )
    },
  )

  it('sends a changed amount, date and category, the payer following the amount', async () => {
    mine(groceries)
    call.mockImplementation(saves(groceries))
    renderPage()
    await openForm()
    fireEvent.change(screen.getByLabelText('Amount (AUD)'), { target: { value: '55.10' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(patched()).toStrictEqual({
      id: 't1',
      groupId: 'g5',
      kind: 'expense',
      date: '2026-10-01',
      description: 'Groceries',
      totalCents: 5510,
      payers: [{ personId: 'pw', cents: 5510 }],
      split: { mode: 'equal', personIds: ['pw'] },
    })
  })

  it('says a stored input the form doesn’t make can’t be changed here', async () => {
    mine(row({ payers: [{ personId: 'pw', cents: 4000 }] }, { groupId: 'g5' }))
    const { queryClient } = renderPage()
    await settled(queryClient)
    expect(
      await screen.findByText('This entry can’t be changed here. Void it and add it again.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
