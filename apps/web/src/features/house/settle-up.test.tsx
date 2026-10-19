import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { formatMoney } from '@ledgerly/core/money/format'
import type { Balances } from '@ledgerly/core/schemas/ledger'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type ErrorCode, type Result } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { SettleUp } from './settle-up'

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
function mockLedger(balances: Balances = BALANCES, ...posted: Result<unknown>[]) {
  call.mockImplementation(async (_fn, method) => {
    if (method === 'GET') return ok(balances)
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
}: {
  group?: Groups
  role?: Members['role']
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const me = { ...(MEMBERS[1] as Members), role }
  render(
    <QueryClientProvider client={queryClient}>
      <SettleUp group={group} me={me} members={MEMBERS} />
    </QueryClientProvider>,
  )
  return { queryClient }
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
