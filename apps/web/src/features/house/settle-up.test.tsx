import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { Balances } from '@ledgerly/core/schemas/ledger'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type ErrorCode, type Result } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { balanceLine, SettleUp } from './settle-up'

vi.mock('../../lib/appwrite', () => ({ DATABASE_ID: 'main', tablesDB: {}, teams: {} }))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))

const call = vi.mocked(callFunction)

// 22:00 UTC on 18 October: already the 19th in Sydney.
const NOW = new Date('2026-10-18T22:00:00.000Z')

const HOUSE = {
  $id: 'g1',
  type: 'house',
  name: 'Flat 3',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  archivedAt: null,
} as Groups

function member(personId: string, displayName: string, extra: Partial<Members> = {}): Members {
  return {
    $id: `m-${personId}`,
    groupId: 'g1',
    personId,
    displayName,
    role: 'member',
    status: 'active',
    joinedOn: '2026-08-01',
    leftOn: null,
    ...extra,
  } as Members
}

const MEMBERS = [
  member('p3', 'Cara'),
  member('p1', 'Mia', { role: 'admin' }),
  member('p2', 'Bob'),
  // Moved out: Dan still owes, Eve is square.
  member('p4', 'Dan', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
  member('p5', 'Eve', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
]

const BALANCES: Balances = {
  people: [
    { personId: 'p1', netCents: 5480 },
    { personId: 'p2', netCents: 0 },
    { personId: 'p3', netCents: -4520 },
    { personId: 'p4', netCents: -960 },
    { personId: 'p5', netCents: 0 },
  ],
  transfers: [
    { fromPersonId: 'p3', toPersonId: 'p1', cents: 4520 },
    { fromPersonId: 'p4', toPersonId: 'p1', cents: 960 },
  ],
}

const money = (cents: number) => formatMoney(cents, 'AUD')

function ok(data: unknown): Result<unknown> {
  return { ok: true, data }
}

function refused(code: ErrorCode, message = 'Refused.'): Result<unknown> {
  return { ok: false, error: { code, message } }
}

/** `/balances` answers with `balances`; a payment with `posted`, then the next answers in turn. */
/** What `/balances` answers now; a test changes it to show someone else's write landing. */
let current: Balances

function mockLedger(balances: Balances = BALANCES, ...posted: Result<unknown>[]) {
  current = balances
  call.mockImplementation(async (_fn, method) => {
    if (method === 'GET') return ok(current)
    return (
      posted.shift() ?? ok({ transaction: { $id: 't1', groupId: 'g1' }, shares: [], items: [] })
    )
  })
}

/** The payment bodies sent so far. */
function payments() {
  return call.mock.calls
    .filter(([, method]) => method === 'POST')
    .map(([fn, , path, body]) => ({ fn, path, body: body as Record<string, unknown> }))
}

function renderSettleUp({
  group = HOUSE,
  role = 'admin',
  me = MEMBERS[1] as Members,
}: {
  group?: Groups
  role?: Members['role']
  me?: Members
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = (props: { group: Groups; role: Members['role'] }) => (
    <QueryClientProvider client={queryClient}>
      <SettleUp group={props.group} me={{ ...me, role: props.role }} members={MEMBERS} />
    </QueryClientProvider>
  )
  const { rerender } = render(page({ group, role }))
  return {
    queryClient,
    /** The page again, as the house page renders it after the group or the caller's row reloads. */
    rerender: (props: { group: Groups; role: Members['role'] }) => rerender(page(props)),
  }
}

function input(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('balanceLine', () => {
  it('words a balance past the amount cap', () => {
    expect(balanceLine('Alice', 20_000_000_000, 'AUD')).toMatch(/^Alice is owed .*200,000,000\.00$/)
    expect(balanceLine('Cara', -20_000_000_000, 'AUD')).toMatch(/^Cara owes .*200,000,000\.00$/)
  })
})

describe('SettleUp', () => {
  it('shows each balance in words, the viewer first, and the suggested payments in order', async () => {
    mockLedger()
    renderSettleUp()
    const section = screen.getByRole('region', { name: 'Settle up' })
    const [people, transfers] = await within(section).findAllByRole('list')
    expect(
      within(people as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      `Mia (you) is owed ${money(5480)}`,
      'Bob is square',
      `Cara owes ${money(4520)}`,
      // Dan moved out but still owes; Eve moved out and is square, so she's gone.
      `Dan owes ${money(960)}`,
    ])
    const suggested = within(transfers as HTMLElement).getAllByRole('listitem')
    expect(suggested.map((li) => li.querySelector('span')?.textContent)).toEqual([
      `Cara pays Mia (you) ${money(4520)}`,
      `Dan pays Mia (you) ${money(960)}`,
    ])
    expect(call).toHaveBeenCalledWith('ledger', 'GET', '/groups/g1/balances')
  })

  it('says when everyone is square', async () => {
    mockLedger({ people: [], transfers: [] })
    renderSettleUp()
    expect(await screen.findByText('Everyone is square.')).toBeTruthy()
  })

  it('says when the balances can’t be loaded', async () => {
    call.mockResolvedValue(refused('INTERNAL'))
    renderSettleUp()
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'We couldn’t load the balances.',
    )
  })

  it('records a suggested payment with its exact body, then refreshes the balances', async () => {
    mockLedger()
    const { queryClient } = renderSettleUp()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const [first] = await screen.findAllByRole('button', { name: 'Record' })
    fireEvent.click(first as HTMLElement)
    // Prefilled from the transfer, dated today in the house's time zone.
    expect(input('From').value).toBe('p3')
    expect(input('To').value).toBe('p1')
    expect(input('Amount (AUD)').value).toBe('45.20')
    expect(input('Date').value).toBe('2026-10-19')
    expect(input('Description').value).toBe('Settle up')
    expect(document.activeElement).toBe(input('From'))
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText('Payment recorded.')).toBeTruthy()
    const [sent] = payments()
    expect(payments()).toHaveLength(1)
    expect(sent).toEqual({
      fn: 'ledger',
      path: '/transactions',
      body: {
        id: sent?.body.id,
        groupId: 'g1',
        kind: 'payment',
        date: '2026-10-19',
        description: 'Settle up',
        totalCents: 4520,
        payment: { fromPersonId: 'p3', toPersonId: 'p1' },
      },
    })
    expect(sent?.body.id).toEqual(expect.any(String))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.balances('g1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] })
    // The form is gone: focus goes to the section's heading.
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Settle up' }))
  })

  it('records a part payment, a note, and a date in a UTC house', async () => {
    mockLedger()
    renderSettleUp({ group: { ...HOUSE, timezone: 'UTC' } })
    const [first] = await screen.findAllByRole('button', { name: 'Record' })
    fireEvent.click(first as HTMLElement)
    expect(input('Date').value).toBe('2026-10-18')
    fireEvent.change(input('Amount (AUD)'), { target: { value: '20' } })
    fireEvent.change(input('Note (optional)'), { target: { value: ' Cash ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await screen.findByText('Payment recorded.')
    expect(payments()[0]?.body).toMatchObject({
      totalCents: 2000,
      date: '2026-10-18',
      note: 'Cash',
    })
  })

  it('records a blank payment between anyone, including someone who moved out', async () => {
    mockLedger()
    renderSettleUp()
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }))
    expect(input('Amount (AUD)').value).toBe('')
    fireEvent.change(input('From'), { target: { value: 'p5' } })
    fireEvent.change(input('To'), { target: { value: 'p2' } })
    fireEvent.change(input('Amount (AUD)'), { target: { value: '5.00' } })
    fireEvent.change(input('Description'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await screen.findByText('Payment recorded.')
    expect(payments()[0]?.body).toMatchObject({
      description: 'Settle up',
      totalCents: 500,
      payment: { fromPersonId: 'p5', toPersonId: 'p2' },
    })
  })

  it('refuses the same person twice, a missing person and an amount that isn’t above 0', async () => {
    mockLedger()
    renderSettleUp()
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findAllByText('Required')).toHaveLength(3)
    fireEvent.change(input('From'), { target: { value: 'p2' } })
    fireEvent.change(input('To'), { target: { value: 'p2' } })
    fireEvent.change(input('Amount (AUD)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText('Pick someone other than who paid')).toBeTruthy()
    expect(screen.getByText('Enter an amount above 0')).toBeTruthy()
    fireEvent.change(input('Amount (AUD)'), { target: { value: 'ten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText('Enter an amount like 40.50')).toBeTruthy()
    expect(payments()).toEqual([])
  })

  it('keeps the form filled after LOCKED, and the same ID for the retry', async () => {
    mockLedger(
      BALANCES,
      refused('LOCKED', 'A statement covering this date is being finalized. Try again soon.'),
    )
    renderSettleUp()
    const [first] = await screen.findAllByRole('button', { name: 'Record' })
    fireEvent.click(first as HTMLElement)
    fireEvent.change(input('Amount (AUD)'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(
      await screen.findByText('A statement covering this date is being finalized. Try again soon.'),
    ).toBeTruthy()
    expect(input('Amount (AUD)').value).toBe('20')
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await screen.findByText('Payment recorded.')
    const [one, two] = payments()
    expect(two?.body.id).toBe(one?.body.id)
  })

  it('shows ARCHIVED and FORBIDDEN in plain words, and takes a new ID after CONFLICT', async () => {
    mockLedger(
      BALANCES,
      refused('ARCHIVED', 'Group is archived'),
      refused('FORBIDDEN', "Your role in this group can't do this."),
      refused('CONFLICT'),
    )
    renderSettleUp()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0] as HTMLElement)
    const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    submit()
    expect(await screen.findByText(/This group has been archived/)).toBeTruthy()
    submit()
    expect(await screen.findByText("Your role in this group can't do this.")).toBeTruthy()
    submit()
    expect(await screen.findByText(/may already have been recorded/)).toBeTruthy()
    submit()
    await screen.findByText('Payment recorded.')
    const ids = payments().map(({ body }) => body.id)
    expect(ids[2]).toBe(ids[0])
    expect(ids[3]).not.toBe(ids[2])
  })

  it('returns focus to Record when the form is cancelled', async () => {
    mockLedger()
    renderSettleUp()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[1] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Record' })[1])
  })

  it('gives a viewer the balances but no way to record, and says who can', async () => {
    mockLedger()
    renderSettleUp({ role: 'viewer' })
    expect(await screen.findByText(`Cara pays Mia (you) ${money(4520)}`)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.getByText('A housemate can record a payment for you.')).toBeTruthy()
  })

  it('shows an archived house’s balances with no way to record', async () => {
    mockLedger()
    renderSettleUp({ group: { ...HOUSE, archivedAt: '2026-10-01T00:00:00.000Z' } })
    expect(await screen.findByText(`Cara owes ${money(4520)}`)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryByText(/can record a payment/)).toBeNull()
  })

  it('keeps an open form on its transfer when a refetch changes the list', async () => {
    mockLedger()
    const { queryClient } = renderSettleUp()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[1] as HTMLElement)
    fireEvent.change(input('Amount (AUD)'), { target: { value: '7' } })
    // A housemate's expense lands meanwhile: a new transfer comes first.
    current = {
      people: BALANCES.people,
      transfers: [{ fromPersonId: 'p2', toPersonId: 'p1', cents: 2000 }, ...BALANCES.transfers],
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.balances('g1') })
    expect(await screen.findByText(`Bob pays Mia (you) ${money(2000)}`)).toBeTruthy()
    expect(input('From').value).toBe('p4')
    expect(input('Amount (AUD)').value).toBe('7')
  })

  it('closes a form whose transfer is gone, says so and focuses the heading', async () => {
    mockLedger()
    const { queryClient } = renderSettleUp()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0] as HTMLElement)
    // Cara settled up from her own phone meanwhile.
    current = { people: BALANCES.people, transfers: BALANCES.transfers.slice(1) }
    await queryClient.invalidateQueries({ queryKey: queryKeys.balances('g1') })
    expect(
      await screen.findByText('The suggested payments changed, so that form was closed.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Settle up' }))
  })

  it('closes an open form when the house is archived or the caller becomes a viewer', async () => {
    mockLedger()
    const { rerender } = renderSettleUp()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0] as HTMLElement)
    rerender({ group: { ...HOUSE, archivedAt: '2026-10-18T21:00:00.000Z' }, role: 'admin' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Settle up' }))
    rerender({ group: HOUSE, role: 'admin' })
    fireEvent.click(screen.getByRole('button', { name: 'Record a payment' }))
    rerender({ group: HOUSE, role: 'viewer' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull())
  })

  it('reloads the balances after CONFLICT, and the house and role after FORBIDDEN', async () => {
    mockLedger(
      BALANCES,
      refused('CONFLICT'),
      refused('FORBIDDEN', "Your role in this group can't do this."),
    )
    const { queryClient } = renderSettleUp()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText(/may already have been recorded/)).toBeTruthy()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.balances('g1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['calendar'] })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.group('g1') })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText("Your role in this group can't do this.")).toBeTruthy()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.group('g1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.myMember('g1', 'p1') })
  })

  it('sends once while it saves, and keeps the form after LOCKED', async () => {
    let answer: (result: Result<unknown>) => void = () => {}
    mockLedger()
    renderSettleUp()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0] as HTMLElement)
    call.mockImplementation(async (_fn, method) =>
      method === 'GET' ? ok(current) : new Promise((resolve) => (answer = resolve)),
    )
    const save = screen.getByRole('button', { name: 'Record payment' })
    save.focus()
    fireEvent.click(save)
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBe(save)
    // aria-disabled, not disabled, so the button keeps focus (jsdom doesn't move it either way).
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(save.hasAttribute('disabled')).toBe(false)
    // A second press while saving sends nothing more.
    fireEvent.click(save)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(payments()).toHaveLength(1)
    answer(refused('LOCKED', 'A statement covering this date is being finalized. Try again soon.'))
    expect(await screen.findByText(/being finalized/)).toBeTruthy()
    expect(document.activeElement).toBe(save)
  })

  it('shows a viewer who moved out their own line, even at 0', async () => {
    mockLedger()
    renderSettleUp({ me: MEMBERS[4] as Members, role: 'viewer' })
    const [people] = await screen.findAllByRole('list')
    expect(within(people as HTMLElement).getAllByRole('listitem')[0]?.textContent).toBe(
      'Eve (you) is square',
    )
  })

  it('shows Loading until the balances come', async () => {
    let answer: (result: Result<unknown>) => void = () => {}
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderSettleUp()
    expect(screen.getByText('Loading…')).toBeTruthy()
    answer(ok(BALANCES))
    expect(await screen.findByText(`Cara owes ${money(4520)}`)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})
