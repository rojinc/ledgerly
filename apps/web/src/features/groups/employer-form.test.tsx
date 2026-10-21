import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { useProfile } from '../profile/use-profile'
import { useMembers } from '../transactions/use-transactions'
import { ArchiveGroup } from './archive-group'
import { centsToText, toEmployerValues, toUpdateBody } from './employer-form'
import { EmployerSettingsPage } from './employer-settings-page'
import { NewEmployerPage } from './new-employer-page'
import { useGroup, useMyMember } from './use-groups'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: 'p1', profile: { currency: 'AUD' } } }),
}))
vi.mock('../profile/use-profile', () => ({ useProfile: vi.fn() }))
vi.mock('./use-groups', () => ({ useGroup: vi.fn(), useMyMember: vi.fn() }))
// Delete group, beside Unarchive, reads the members (#429).
vi.mock('../transactions/use-transactions', () => ({ useMembers: vi.fn() }))

const call = vi.mocked(callFunction)
const groupHook = vi.mocked(useGroup)
const memberHook = vi.mocked(useMyMember)
const profileHook = vi.mocked(useProfile)
const membersHook = vi.mocked(useMembers)

/** The group's member rows: the worker (p1) and the employer, `employerStatus`. */
function mockMembers(employerStatus: Members['status'] = 'placeholder') {
  membersHook.mockReturnValue({
    data: [
      { personId: 'p1', role: 'admin', status: 'active' },
      { personId: 'p2', role: 'viewer', status: employerStatus },
    ] as Members[],
  } as ReturnType<typeof useMembers>)
}

function mockProfile(currency: string, timezone = 'Australia/Sydney', region = 'AU-NSW') {
  profileHook.mockReturnValue({
    data: { currency, timezone, region },
    isError: false,
  } as ReturnType<typeof useProfile>)
}

const employer = {
  $id: 'g1',
  type: 'employer',
  name: 'Acme Cafe',
  ownerPersonId: 'p1',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  statementCycle: 'weekly',
  cycleAnchor: '2026-10-05',
  nextCloseAt: null,
  settingsJson: JSON.stringify({
    type: 'employer',
    defaultRateCents: 2550,
    paymentTermsDays: 7,
    autoFinalize: true,
    recipients: ['pay@acme.test', 'boss@acme.test'],
  }),
  archivedAt: null,
} as Groups

function mockGroup(group: Groups | undefined, role: Members['role'] | null = 'admin') {
  groupHook.mockReturnValue({ data: group, isError: false } as ReturnType<typeof useGroup>)
  memberHook.mockReturnValue({
    data: role ? ({ role } as Members) : null,
    isError: false,
  } as ReturnType<typeof useMyMember>)
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/groups/new-employer', element: <NewEmployerPage /> },
      { path: '/groups/:groupId/settings', element: <EmployerSettingsPage /> },
    ],
    { initialEntries: [path] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

/**
 * useGroup as a live query: `refetch(group)` changes what it returns and re-renders whoever
 * reads it, as a real refetch would.
 */
function liveGroup(group: Groups) {
  let current = { data: group, isError: false }
  const listeners = new Set<() => void>()
  groupHook.mockImplementation(
    () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        () => current,
      ) as ReturnType<typeof useGroup>,
  )
  return (next: Groups) =>
    act(() => {
      current = { data: next, isError: false }
      for (const listener of listeners) listener()
    })
}

/** useMyMember as a live query, as liveGroup is for the group. */
function liveMember(role: Members['role']) {
  let current = { data: { role } as Members, isError: false }
  const listeners = new Set<() => void>()
  memberHook.mockImplementation(
    () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        () => current,
      ) as ReturnType<typeof useMyMember>,
  )
  return (next: Members['role']) =>
    act(() => {
      current = { data: { role: next } as Members, isError: false }
      for (const listener of listeners) listener()
    })
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function input(label: string | RegExp) {
  return screen.getByLabelText(label) as HTMLInputElement
}

const created = { ok: true as const, data: { group: { ...employer, $id: 'g9' }, members: [] } }

beforeEach(() => {
  mockGroup(undefined)
  mockProfile('AUD')
  mockMembers()
})

afterEach(() => {
  cleanup()
  call.mockReset()
})

describe('NewEmployerPage', () => {
  it('creates the employer with its settings and opens its settings page', async () => {
    call.mockResolvedValue(created)
    const { router } = renderAt('/groups/new-employer')
    expect(screen.getByRole('heading', { name: 'New employer' })).toBeTruthy()
    type('Employer name', '  Acme Cafe ')
    type('Billing emails', 'pay@acme.test, boss@acme.test\n\n')
    type(/Default hourly rate/, '25.50')
    type('Invoice cycle', 'fortnightly')
    type('Cycle starts on', '2026-10-01')
    type('Payment terms (days)', '7')
    fireEvent.click(screen.getByLabelText('Finalize invoices automatically when the period ends'))
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3]
    expect(call).toHaveBeenCalledWith('groups', 'POST', '/groups', {
      id: (body as { id: string }).id,
      type: 'employer',
      name: 'Acme Cafe',
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      currency: 'AUD',
      counterpart: { displayName: 'Acme Cafe' },
      statementCycle: 'fortnightly',
      cycleAnchor: '2026-10-01',
      settings: {
        type: 'employer',
        defaultRateCents: 2550,
        paymentTermsDays: 7,
        autoFinalize: true,
        recipients: ['pay@acme.test', 'boss@acme.test'],
      },
    })
    expect((body as { id: string }).id).toMatch(/^[a-zA-Z0-9]/)
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g9/settings'))
  })

  it('parses the rate in the current profile currency and sends that currency', async () => {
    mockProfile('JPY')
    call.mockResolvedValue(created)
    renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type(/Default hourly rate/, '25')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as {
      currency: string
      settings: { defaultRateCents: number }
    }
    expect(body.currency).toBe('JPY')
    expect(body.settings.defaultRateCents).toBe(25)
  })

  it('starts with the profile’s time zone, region and currency, and sends the ones chosen', async () => {
    mockProfile('NZD', 'Pacific/Auckland', 'NZ-AUK')
    call.mockResolvedValue(created)
    renderAt('/groups/new-employer')
    expect(input('Time zone').value).toBe('Pacific/Auckland')
    expect(input('Public holiday region').value).toBe('NZ-AUK')
    expect(input('Currency').value).toBe('NZD')
    expect(screen.getByText(/It can’t change once something is recorded/)).toBeTruthy()
    // A new group has no period yet.
    expect(screen.queryByText('A period that has already ended keeps its dates.')).toBeNull()
    type('Employer name', 'Acme Cafe')
    type('Time zone', 'Asia/Tokyo')
    type('Public holiday region', ' jp ')
    type('Currency', 'jpy')
    // The rate is typed in the group's currency, not the profile's.
    expect(screen.getByLabelText('Default hourly rate (JPY)')).toBeTruthy()
    type(/Default hourly rate/, '2500')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      timezone: 'Asia/Tokyo',
      region: 'JP',
      currency: 'JPY',
      settings: { defaultRateCents: 2500 },
    })
  })

  it('shows an inline error for a currency that isn’t three letters, and not one for the rate', async () => {
    renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type(/Default hourly rate/, '25.50')
    type('Currency', 'A1')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    expect((await screen.findByText('Expected e.g. AUD', {}, { timeout: 3000 })).id).toBe(
      'currency-error',
    )
    expect(input(/Default hourly rate/).getAttribute('aria-invalid')).toBe('false')
    expect(call).not.toHaveBeenCalled()
  })

  it('says the employer may already exist on a conflict, keeping the id', async () => {
    call.mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'That ID is taken.' } })
    renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type(/Default hourly rate/, '25')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This employer may already exist. Check Groups, or try again.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    const ids = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(ids[0]).toBe(ids[1])
  })

  it('sends no anchor for a monthly cycle, even if one was typed', async () => {
    call.mockResolvedValue(created)
    renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type(/Default hourly rate/, '25')
    type('Invoice cycle', 'weekly')
    type('Cycle starts on', '2026-10-01')
    type('Invoice cycle', 'monthly')
    expect(screen.queryByLabelText('Cycle starts on')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const body = call.mock.calls[0]?.[3] as Record<string, unknown>
    expect(body.statementCycle).toBe('monthly')
    expect('cycleAnchor' in body).toBe(false)
    expect(body.settings).toEqual({
      type: 'employer',
      defaultRateCents: 2500,
      paymentTermsDays: 14,
      autoFinalize: false,
      recipients: [],
    })
  })

  it.each([
    ['25.555', 'Enter an amount like 25.50'],
    ['abc', 'Enter an amount like 25.50'],
    ['', 'Required'],
    ['-5', 'Must be 0 or more'],
  ])('shows an inline error for the rate %j and sends nothing', async (rate, message) => {
    renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type(/Default hourly rate/, rate)
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    expect((await screen.findByText(message)).id).toBe('defaultRate-error')
    expect(input(/Default hourly rate/).getAttribute('aria-invalid')).toBe('true')
    expect(call).not.toHaveBeenCalled()
  })

  it('shows inline errors on the visible fields', async () => {
    renderAt('/groups/new-employer')
    type('Billing emails', 'pay@acme.test\nnot-an-email')
    type(/Default hourly rate/, '25')
    type('Invoice cycle', 'weekly')
    type('Payment terms (days)', '7.5')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    expect((await screen.findByText('not-an-email is not an email address')).id).toBe(
      'recipients-error',
    )
    expect(screen.getByText('Enter whole days, 0 to 365').id).toBe('paymentTermsDays-error')
    expect(input('Employer name').getAttribute('aria-describedby')).toBe('name-error')
    expect(input('Cycle starts on').getAttribute('aria-describedby')).toBe(
      'cycleAnchor-hint cycleAnchor-error',
    )
    expect(screen.getAllByText('Required').map((error) => error.id)).toEqual([
      'name-error',
      'cycleAnchor-error',
    ])
    expect(call).not.toHaveBeenCalled()
  })

  it('limits the billing emails to 10', async () => {
    renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type('Billing emails', Array.from({ length: 11 }, (_, i) => `p${i}@acme.test`).join(','))
    type(/Default hourly rate/, '25')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    expect((await screen.findByText('At most 10 billing emails')).id).toBe('recipients-error')
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the form when a background refetch of the profile fails', () => {
    profileHook.mockReturnValue({
      data: { currency: 'AUD', timezone: 'Australia/Sydney', region: 'AU-NSW' },
      isError: true,
    } as ReturnType<typeof useProfile>)
    renderAt('/groups/new-employer')
    expect(screen.getByLabelText('Employer name')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the function error and retries with the same id', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Could not reach the server.' },
    })
    call.mockResolvedValueOnce(created)
    const { router } = renderAt('/groups/new-employer')
    type('Employer name', 'Acme Cafe')
    type(/Default hourly rate/, '25')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach the server.')
    fireEvent.click(screen.getByRole('button', { name: 'Create employer' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/g9/settings'))
    expect(call).toHaveBeenCalledTimes(2)
    const ids = call.mock.calls.map((args) => (args[3] as { id: string }).id)
    expect(ids[0]).toBe(ids[1])
  })
})

describe('EmployerSettingsPage', () => {
  it('starts from the stored group and saves the changes', async () => {
    mockGroup(employer)
    const saved = {
      ...employer,
      name: 'Acme',
      settingsJson: JSON.stringify({
        type: 'employer',
        defaultRateCents: 3000,
        paymentTermsDays: 7,
        autoFinalize: true,
        recipients: ['pay@acme.test', 'accounts@acme.test'],
      }),
    }
    call.mockResolvedValue({ ok: true, data: saved })
    const { queryClient } = renderAt('/groups/g1/settings')
    expect(screen.getByRole('link', { name: 'Invoices' }).getAttribute('href')).toBe(
      '/groups/g1/statements',
    )
    expect(input('Group name').value).toBe('Acme Cafe')
    expect(input('Billing emails').value).toBe('pay@acme.test\nboss@acme.test')
    expect(input(/Default hourly rate/).value).toBe('25.50')
    expect(input('Invoice cycle').value).toBe('weekly')
    expect(input('Cycle starts on').value).toBe('2026-10-05')
    expect(input('Payment terms (days)').value).toBe('7')
    expect(input('Finalize invoices automatically when the period ends').checked).toBe(true)

    type('Group name', ' Acme ')
    type('Billing emails', 'pay@acme.test,  accounts@acme.test')
    type(/Default hourly rate/, '30')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call).toHaveBeenCalledWith('groups', 'PATCH', '/groups/g1', {
      name: 'Acme',
      statementCycle: 'weekly',
      cycleAnchor: '2026-10-05',
      settings: {
        type: 'employer',
        defaultRateCents: 3000,
        paymentTermsDays: 7,
        autoFinalize: true,
        recipients: ['pay@acme.test', 'accounts@acme.test'],
      },
    })
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(input('Billing emails').value).toBe('pay@acme.test\naccounts@acme.test')
    expect(input(/Default hourly rate/).value).toBe('30.00')
    expect(queryClient.getQueryData(['group', 'g1'])).toEqual(saved)
  })

  it('emails auto-finalized invoices only with automatic finalizing and a billing email (#432)', async () => {
    mockGroup(employer)
    call.mockResolvedValue({ ok: true, data: employer })
    renderAt('/groups/g1/settings')
    const autoSend = input('Also email it to the billing emails')
    const autoFinalize = input('Finalize invoices automatically when the period ends')
    expect(autoSend.checked).toBe(false)
    expect(autoSend.getAttribute('aria-disabled')).toBe('false')
    expect(autoSend.getAttribute('aria-describedby')).toBe('autoSend-hint')
    fireEvent.click(autoSend)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      settings: {
        autoFinalize: true,
        autoSend: true,
        recipients: ['pay@acme.test', 'boss@acme.test'],
      },
    })
    // Clearing either clears it, and it can't be ticked again until both are back.
    fireEvent.click(autoFinalize)
    await waitFor(() => expect(autoSend.checked).toBe(false))
    expect(autoSend.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(autoFinalize)
    expect(autoSend.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(autoSend)
    type('Billing emails', '')
    await waitFor(() => expect(autoSend.checked).toBe(false))
    expect(autoSend.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls[1]?.[3]).toMatchObject({
      settings: { autoFinalize: true, recipients: [] },
    })
    expect(call.mock.calls[1]?.[3]).not.toHaveProperty('settings.autoSend')
  })

  const manual = {
    ...employer,
    settingsJson: JSON.stringify({ ...JSON.parse(employer.settingsJson), autoFinalize: false }),
  }

  it('keeps auto-send focusable while it can’t be used, and a click doesn’t tick it (#459)', async () => {
    mockGroup(manual)
    call.mockResolvedValue({ ok: true, data: employer })
    renderAt('/groups/g1/settings')
    const autoSend = input('Also email it to the billing emails')
    expect(autoSend.getAttribute('aria-disabled')).toBe('true')
    autoSend.focus()
    expect(document.activeElement).toBe(autoSend)
    fireEvent.click(autoSend)
    expect(autoSend.checked).toBe(false)
    fireEvent.click(screen.getByText('Also email it to the billing emails'))
    expect(autoSend.checked).toBe(false)
    // Nor in the form's value: with automatic finalizing back on, a save doesn't send it.
    fireEvent.click(input('Finalize invoices automatically when the period ends'))
    expect(autoSend.getAttribute('aria-disabled')).toBe('false')
    expect(autoSend.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({ settings: { autoFinalize: true } })
    expect(call.mock.calls[0]?.[3]).not.toHaveProperty('settings.autoSend')
  })

  it('counts a tick once auto-send can be used again, after a click while it couldn’t (#459)', async () => {
    mockGroup(manual)
    call.mockResolvedValue({ ok: true, data: employer })
    renderAt('/groups/g1/settings')
    const autoSend = input('Also email it to the billing emails')
    fireEvent.click(autoSend)
    fireEvent.click(input('Finalize invoices automatically when the period ends'))
    fireEvent.click(autoSend)
    expect(autoSend.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[3]).toMatchObject({
      settings: { autoFinalize: true, autoSend: true },
    })
  })

  it('keeps Save focusable while saving, and saves once', async () => {
    mockGroup(employer)
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving.getAttribute('aria-disabled')).toBe('true')
    saving.focus()
    expect(document.activeElement).toBe(saving)
    fireEvent.click(saving)
    expect(fireEvent.submit(saving.closest('form') as HTMLFormElement)).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shows auto-send as stored', () => {
    mockGroup({
      ...employer,
      settingsJson: JSON.stringify({ ...JSON.parse(employer.settingsJson), autoSend: true }),
    })
    renderAt('/groups/g1/settings')
    expect(input('Also email it to the billing emails').checked).toBe(true)
  })

  it('shows the group’s own time zone, region and currency, and sends only those changed', async () => {
    mockGroup({ ...employer, timezone: 'Pacific/Auckland', region: 'NZ-AUK', currency: 'NZD' })
    call.mockResolvedValue({ ok: true, data: { ...employer, timezone: 'Asia/Tokyo' } })
    renderAt('/groups/g1/settings')
    expect(input('Time zone').value).toBe('Pacific/Auckland')
    expect(input('Public holiday region').value).toBe('NZ-AUK')
    expect(input('Currency').value).toBe('NZD')
    expect(screen.getByLabelText('Default hourly rate (NZD)')).toBeTruthy()
    // statements.md#periods (#126).
    expect(screen.getByText('A period that has already ended keeps its dates.')).toBeTruthy()
    type('Time zone', 'Asia/Tokyo')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved.', {}, { timeout: 3000 })
    const body = call.mock.calls[0]?.[3] as Record<string, unknown>
    expect(body.timezone).toBe('Asia/Tokyo')
    expect(body).not.toHaveProperty('region')
    expect(body).not.toHaveProperty('currency')
  })

  it('reads the rate in a currency changed here, in either direction', async () => {
    // AUD to JPY: "25.50" has cents, which yen don't, so it's refused until typed again.
    mockGroup(employer)
    call.mockResolvedValue({ ok: true, data: { ...employer, currency: 'JPY' } })
    renderAt('/groups/g1/settings')
    type('Currency', 'jpy')
    expect(screen.getByLabelText('Default hourly rate (JPY)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Enter an amount like 2550', {}, { timeout: 3000 })
    expect(call).not.toHaveBeenCalled()
    type(/Default hourly rate/, '3000')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const toYen = call.mock.calls[0]?.[3] as {
      currency: string
      settings: { defaultRateCents: number }
    }
    expect([toYen.currency, toYen.settings.defaultRateCents]).toEqual(['JPY', 3000])
    cleanup()
    call.mockClear()

    // JPY to AUD: "2550" reads as $2,550.00, and the label right under the currency says so.
    mockGroup({ ...employer, currency: 'JPY' })
    call.mockResolvedValue({ ok: true, data: employer })
    renderAt('/groups/g1/settings')
    expect(input(/Default hourly rate/).value).toBe('2550')
    type('Currency', 'aud')
    expect(screen.getByLabelText('Default hourly rate (AUD)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const toDollars = call.mock.calls[0]?.[3] as {
      currency: string
      settings: { defaultRateCents: number }
    }
    expect([toDollars.currency, toDollars.settings.defaultRateCents]).toEqual(['AUD', 255000])
  })

  it('asks for the currency before the rate, which is read in it', () => {
    mockGroup(employer)
    renderAt('/groups/g1/settings')
    const currency = screen.getByLabelText('Currency')
    const rate = screen.getByLabelText(/Default hourly rate/)
    expect(currency.compareDocumentPosition(rate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows why when the currency can’t change any more', async () => {
    mockGroup(employer)
    // functions-api.md#groups: refused once the group has a transaction.
    call.mockResolvedValue({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: "The currency can't change after the group's first transaction.",
      },
    })
    renderAt('/groups/g1/settings')
    expect(screen.getByText(/It can’t change once something is recorded/)).toBeTruthy()
    type('Currency', 'usd')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(
      "The currency can't change after the group's first transaction.",
      {},
      {
        timeout: 3000,
      },
    )
    expect(call.mock.calls[0]?.[3]).toMatchObject({ currency: 'USD' })
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('keeps the stored anchor after saving another cycle', async () => {
    mockGroup(employer)
    call.mockResolvedValue({ ok: true, data: { ...employer, statementCycle: 'monthly' } })
    renderAt('/groups/g1/settings')
    type('Invoice cycle', 'monthly')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(call.mock.calls[0]?.[3]).not.toHaveProperty('cycleAnchor')
    type('Invoice cycle', 'weekly')
    expect(input('Cycle starts on').value).toBe('2026-10-05')
  })

  it('shows the function error', async () => {
    mockGroup(employer)
    call.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'Admins only.' } })
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Admins only.')
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('shows the settings read-only to a member who is not an admin', () => {
    mockGroup(employer, 'member')
    renderAt('/groups/g1/settings')
    expect(screen.getByText('Only an admin can change these settings.')).toBeTruthy()
    expect(input('Group name').disabled).toBe(false) // disabled through its fieldset
    expect(input('Group name').matches(':disabled')).toBe(true)
    for (const label of ['Time zone', 'Public holiday region', 'Currency']) {
      expect(input(label).matches(':disabled')).toBe(true)
    }
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('has no settings form for other groups', () => {
    mockGroup({ ...employer, type: 'house' })
    renderAt('/groups/g1/settings')
    expect(screen.getByText('Only employer groups have settings here.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('has no settings form for an archived group', () => {
    mockGroup({ ...employer, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/groups/g1/settings')
    expect(
      screen.getByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Archive group' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each([
    ['not JSON', '{oops'],
    ['not employer settings', JSON.stringify({ type: 'house', defaultBillSplit: 'equal' })],
  ])('shows an error and no form when the stored settings are %s', (_, settingsJson) => {
    mockGroup({ ...employer, settingsJson })
    renderAt('/groups/g1/settings')
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t read this group’s settings/)
    expect(screen.queryByLabelText(/Default hourly rate/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('keeps the form when a background refetch of the group or member fails', () => {
    groupHook.mockReturnValue({ data: employer, isError: true } as ReturnType<typeof useGroup>)
    memberHook.mockReturnValue({
      data: { role: 'admin' } as Members,
      isError: true,
    } as ReturnType<typeof useMyMember>)
    renderAt('/groups/g1/settings')
    expect(input('Group name').value).toBe('Acme Cafe')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reloads the group and role when a save is refused because they changed', async () => {
    mockGroup(employer)
    call.mockResolvedValue({ ok: false, error: { code: 'ARCHIVED', message: 'Archived.' } })
    const { queryClient } = renderAt('/groups/g1/settings')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // In plain words, not the raw error (#37).
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This group has been archived, so it can’t be changed any more. Reload the page to see it as it is now.',
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['group', 'g1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['member', 'g1', 'p1'] })
  })

  it('says when it is loading or the group could not be loaded', () => {
    renderAt('/groups/g1/settings')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    cleanup()
    groupHook.mockReturnValue({ data: undefined, isError: true } as ReturnType<typeof useGroup>)
    renderAt('/groups/g1/settings')
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t load this group/)
  })
})

describe('centsToText', () => {
  it('writes cents with the currency’s decimals, without floats', () => {
    expect(centsToText(2550, 'AUD')).toBe('25.50')
    expect(centsToText(5, 'AUD')).toBe('0.05')
    expect(centsToText(-2550, 'AUD')).toBe('-25.50')
    expect(centsToText(2550, 'JPY')).toBe('2550')
    expect(centsToText(12345, 'KWD')).toBe('12.345')
  })
})

describe('toEmployerValues', () => {
  it('uses the employer defaults for a group without employer settings', () => {
    expect(
      toEmployerValues({
        name: 'X',
        timezone: 'Australia/Sydney',
        region: 'AU-NSW',
        currency: 'AUD',
        settings: { type: 'house', autoFinalize: true, defaultBillSplit: 'days' },
      }),
    ).toEqual({
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      currency: 'AUD',
      name: 'X',
      recipients: '',
      defaultRate: '0.00',
      statementCycle: 'monthly',
      cycleAnchor: '',
      paymentTermsDays: '14',
      autoFinalize: false,
      autoSend: false,
    })
  })
})

describe('toUpdateBody', () => {
  it('sends autoSend only with automatic finalizing and a billing email (#432)', () => {
    const values = {
      ...toEmployerValues({ ...employer, settings: JSON.parse(employer.settingsJson) }),
      autoSend: true,
    }
    expect(toUpdateBody(values).settings).toMatchObject({ autoSend: true })
    expect(toUpdateBody({ ...values, autoFinalize: false }).settings).not.toHaveProperty('autoSend')
    expect(toUpdateBody({ ...values, recipients: ' ' }).settings).not.toHaveProperty('autoSend')
  })
})

describe('archiving a group (#37)', () => {
  // jsdom has no showModal: open and close the native dialog by its attribute, mark it modal
  // only when showModal() opened it, and make the page behind a modal inert, as browsers do, so
  // focus() outside it does nothing.
  const original = {
    showModal: HTMLDialogElement.prototype.showModal,
    close: HTMLDialogElement.prototype.close,
    focus: HTMLElement.prototype.focus,
  }
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '')
      this.dataset.modal = ''
    }
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open')
      delete this.dataset.modal
    }
    HTMLElement.prototype.focus = function (options) {
      const modal = document.querySelector('dialog[open][data-modal]')
      if (modal && !modal.contains(this)) return
      original.focus.call(this, options)
    }
  })
  afterAll(() => {
    HTMLDialogElement.prototype.showModal = original.showModal
    HTMLDialogElement.prototype.close = original.close
    HTMLElement.prototype.focus = original.focus
  })
  const esc = (dialog: HTMLElement) => fireEvent(dialog, new Event('cancel', { cancelable: true }))

  it('moves focus to the heading when a save is refused with ARCHIVED and the group reloads', async () => {
    mockGroup(employer)
    const refetch = liveGroup(employer)
    call.mockResolvedValue({ ok: false, error: { code: 'ARCHIVED', message: 'Group is archived' } })
    renderAt('/groups/g1/settings')
    const save = screen.getByRole('button', { name: 'Save' })
    save.focus()
    fireEvent.click(save)
    expect((await screen.findByRole('alert')).textContent).toMatch(/^This group has been archived/)
    // The reload it asked for comes back archived: the form, and the focused button, are gone.
    refetch({ ...employer, archivedAt: '2026-10-19T00:00:00.000Z' })
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('reopens if the browser closes it while archiving, and closes as Cancel otherwise', async () => {
    mockGroup(employer)
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/groups/g1/settings')
    const trigger = screen.getByRole('button', { name: 'Archive group' })
    fireEvent.click(trigger)
    let dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive group' }))
    await within(dialog).findByRole('button', { name: 'Archiving…' })
    // A second Esc with no click between can't be cancelled: the browser closes it.
    dialog.removeAttribute('open')
    fireEvent(dialog, new Event('close'))
    expect(dialog.hasAttribute('open')).toBe(true)
    cleanup()
    // Not archiving: the same native close counts as Cancel, and focus goes back.
    mockGroup(employer)
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    dialog = screen.getByRole('alertdialog')
    dialog.removeAttribute('open')
    fireEvent(dialog, new Event('close'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Archive group' }))
  })

  it('leaves focus alone when the group was already archived when the page opened', () => {
    mockGroup({ ...employer, archivedAt: '2026-10-01T00:00:00.000Z' })
    renderAt('/groups/g1/settings')
    expect(document.activeElement).toBe(document.body)
  })

  it('moves focus to the heading when the caller is made a member under the dialog', () => {
    mockGroup(employer)
    const demote = liveMember('admin')
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    demote('member')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('leaves focus where it is when something else on the page still has it', () => {
    mockGroup(employer)
    const demote = liveMember('admin')
    renderAt('/groups/g1/settings')
    const name = screen.getByLabelText('Group name')
    name.focus()
    demote('member')
    expect(document.activeElement).toBe(name)
  })

  it('keeps Esc from closing the dialog itself: React closes it', () => {
    mockGroup(employer)
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    const event = new Event('cancel', { cancelable: true })
    fireEvent(screen.getByRole('alertdialog'), event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('is offered to admins only', () => {
    mockGroup(employer, 'member')
    renderAt('/groups/g1/settings')
    expect(screen.queryByRole('button', { name: 'Archive group' })).toBeNull()
    cleanup()
    mockGroup(employer, 'admin')
    renderAt('/groups/g1/settings')
    expect(screen.getByRole('button', { name: 'Archive group' })).toBeTruthy()
  })

  it('never offers a personal group', () => {
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <ArchiveGroup group={{ ...employer, type: 'personal' } as Groups} onArchived={() => {}} />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Archive group' })).toBeNull()
  })

  it('explains what archiving does in a native modal, and gives focus back on Esc', () => {
    mockGroup(employer)
    renderAt('/groups/g1/settings')
    const trigger = screen.getByRole('button', { name: 'Archive group' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Acme Cafe?' })
    // A native <dialog> shown with showModal(): the page behind is inert, so no click can move
    // focus out of it (the browser does the trap).
    expect(dialog.tagName).toBe('DIALOG')
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.dataset.modal).toBe('')
    expect(dialog.textContent).toContain('read-only')
    expect(dialog.textContent).toContain('schedules, reminders and statements stop')
    expect(dialog.textContent).toContain('history stays')
    // An admin can unarchive it now (#428).
    expect(dialog.textContent).not.toContain('can’t be undone')
    expect(dialog.textContent).toContain('An admin can unarchive it later.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    esc(dialog)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(call).not.toHaveBeenCalled()
  })

  it('archives on confirm, refreshes the groups and moves focus to the page', async () => {
    mockGroup(employer)
    call.mockResolvedValue({ ok: true, data: { ...employer, archivedAt: '2026-10-19T00:00:00Z' } })
    const { queryClient } = renderAt('/groups/g1/settings')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive group' }),
    )
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(call).toHaveBeenCalledWith('groups', 'POST', '/groups/g1/archive')
    expect(queryClient.getQueryData(['group', 'g1'])).toMatchObject({
      archivedAt: expect.any(String),
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groups', 'u1'] })
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('shows why when the server refuses, such as a timer still running (#120)', async () => {
    mockGroup(employer)
    call.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Stop the timer first.' },
    })
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive group' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Stop the timer first.')
    // Still open, so the user can cancel or try again once the timer is stopped.
    expect(within(dialog).getByRole('button', { name: 'Archive group' })).toBeTruthy()
  })

  it('moves focus to the heading when a refetch finds the group archived under the dialog', () => {
    mockGroup(employer)
    const refetch = liveGroup(employer)
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    // Archived in another tab: the next refetch has archivedAt, and the dialog goes with the form.
    refetch({ ...employer, archivedAt: '2026-10-19T00:00:00.000Z' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(
      screen.getByText('This group is archived. You can see its history but not change it.'),
    ).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('keeps focus in the dialog while archiving, and ignores Esc until it answers', async () => {
    mockGroup(employer)
    call.mockReturnValue(new Promise(() => {}))
    renderAt('/groups/g1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'Archive group' }))
    const dialog = screen.getByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: 'Archive group' })
    confirm.focus()
    fireEvent.click(confirm)
    const busy = await within(dialog).findByRole('button', { name: 'Archiving…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(busy)
    esc(dialog)
    fireEvent.click(busy)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  })

  describe('and deleting it (#429)', () => {
    const archived = { ...employer, archivedAt: '2026-10-01T00:00:00.000Z' }
    const deleteLink = () => screen.queryByRole('link', { name: 'Delete group' })

    it('links Delete group beside Unarchive, for an admin, while nobody else has joined', () => {
      mockGroup(archived)
      renderAt('/groups/g1/settings')
      expect(screen.getByRole('button', { name: 'Unarchive group' })).toBeTruthy()
      expect(deleteLink()?.getAttribute('href')).toBe('/groups/g1/delete')
      cleanup()
      // Someone who left may have moved out, still in the team: the delete's refusal says.
      mockMembers('left')
      renderAt('/groups/g1/settings')
      expect(deleteLink()).toBeTruthy()
    })

    it('isn’t offered once the other side has joined, before the members are read, or to anyone else', () => {
      // Joined, so in the team: the delete would be refused.
      mockMembers('active')
      mockGroup(archived)
      renderAt('/groups/g1/settings')
      expect(screen.getByRole('button', { name: 'Unarchive group' })).toBeTruthy()
      expect(deleteLink()).toBeNull()
      cleanup()
      membersHook.mockReturnValue({ data: undefined } as ReturnType<typeof useMembers>)
      renderAt('/groups/g1/settings')
      expect(deleteLink()).toBeNull()
      cleanup()
      mockMembers()
      for (const role of ['member', 'viewer'] as const) {
        mockGroup(archived, role)
        renderAt('/groups/g1/settings')
        expect(deleteLink()).toBeNull()
        cleanup()
      }
      mockGroup(employer)
      renderAt('/groups/g1/settings')
      expect(deleteLink()).toBeNull()
    })

    // #486: the worker deleted their account, so their kept row is `left`, and nobody has
    // joined as an admin. The employer, a viewer, is the last one in.
    function workerGone(others: Members[] = []) {
      membersHook.mockReturnValue({
        data: [
          { personId: 'p1', role: 'viewer', status: 'left' },
          { personId: 'p2', role: 'viewer', status: 'active' },
          ...others,
        ] as Members[],
      } as ReturnType<typeof useMembers>)
      mockGroup(archived)
      memberHook.mockReturnValue({
        data: { personId: 'p2', role: 'viewer', status: 'active' } as Members,
        isError: false,
      } as ReturnType<typeof useMyMember>)
    }

    it('links Delete group, never Unarchive, for the last person once no admin has joined (#486)', () => {
      workerGone()
      renderAt('/groups/g1/settings')
      expect(
        screen.getByText('This group has no admin any more, so you can delete it.'),
      ).toBeTruthy()
      expect(deleteLink()?.getAttribute('href')).toBe('/groups/g1/delete')
      expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
      cleanup()
      // A placeholder's admin row isn't a joined admin.
      workerGone([{ personId: 'p3', role: 'admin', status: 'placeholder' } as Members])
      renderAt('/groups/g1/settings')
      expect(deleteLink()).toBeTruthy()
    })

    it('isn’t offered to them while someone has joined as an admin, or anyone else has joined (#486)', () => {
      for (const role of ['admin', 'viewer'] as const) {
        workerGone([{ personId: 'p3', role, status: 'active' } as Members])
        renderAt('/groups/g1/settings')
        expect(deleteLink()).toBeNull()
        expect(screen.queryByText(/no admin any more/)).toBeNull()
        cleanup()
      }
      // Nor to someone whose own row isn't among the members, or hasn't joined.
      for (const status of [null, 'placeholder'] as const) {
        workerGone(status ? [{ personId: 'p9', role: 'viewer', status } as Members] : [])
        memberHook.mockReturnValue({
          data: { personId: 'p9', role: 'viewer' } as Members,
          isError: false,
        } as ReturnType<typeof useMyMember>)
        membersHook.mockReturnValue({
          data: [
            { personId: 'p1', role: 'viewer', status: 'left' },
            ...(status ? [{ personId: 'p9', role: 'viewer', status }] : []),
          ] as Members[],
        } as ReturnType<typeof useMembers>)
        renderAt('/groups/g1/settings')
        expect(deleteLink()).toBeNull()
        cleanup()
      }
    })
  })

  describe('and unarchiving it (#428)', () => {
    const archived = { ...employer, archivedAt: '2026-10-01T00:00:00.000Z' }

    it('is offered to an admin of an archived group only', () => {
      mockGroup(archived)
      renderAt('/groups/g1/settings')
      expect(
        screen.getByText('This group is archived. You can see its history but not change it.'),
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Unarchive group' })).toBeTruthy()
      cleanup()
      mockGroup(archived, 'member')
      renderAt('/groups/g1/settings')
      expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
      cleanup()
      mockGroup(archived, 'viewer')
      renderAt('/groups/g1/settings')
      expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
      cleanup()
      mockGroup(employer)
      renderAt('/groups/g1/settings')
      expect(screen.queryByRole('button', { name: 'Unarchive group' })).toBeNull()
    })

    it('explains it in a native modal, and gives focus back on Esc', () => {
      mockGroup(archived)
      renderAt('/groups/g1/settings')
      const trigger = screen.getByRole('button', { name: 'Unarchive group' })
      fireEvent.click(trigger)
      const dialog = screen.getByRole('alertdialog', { name: 'Unarchive Acme Cafe?' })
      expect(dialog.dataset.modal).toBe('')
      expect(dialog.textContent).toContain('can be changed again')
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
      esc(dialog)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(call).not.toHaveBeenCalled()
    })

    it('unarchives on confirm, refreshes the group, says so and moves focus to the heading', async () => {
      mockGroup(archived)
      const refetch = liveGroup(archived)
      call.mockResolvedValue({ ok: true, data: employer })
      const { queryClient } = renderAt('/groups/g1/settings')
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      fireEvent.click(screen.getByRole('button', { name: 'Unarchive group' }))
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Unarchive group' }),
      )
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(call).toHaveBeenCalledWith('groups', 'POST', '/groups/g1/unarchive')
      // The group as stored goes in the cache, so the page reads it writable.
      expect(queryClient.getQueryData(['group', 'g1'])).toMatchObject({ archivedAt: null })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groups', 'u1'] })
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
      refetch(employer)
      expect(screen.getByText('This group is unarchived, so it can be changed again.')).toBeTruthy()
      expect(input('Group name').matches(':disabled')).toBe(false)
      expect(screen.getByRole('button', { name: 'Archive group' })).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
    })

    it('shows the function’s refusal in the dialog', async () => {
      mockGroup(archived)
      call.mockResolvedValue({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Your role in this group can’t do this.' },
      })
      renderAt('/groups/g1/settings')
      fireEvent.click(screen.getByRole('button', { name: 'Unarchive group' }))
      const dialog = screen.getByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Unarchive group' }))
      expect((await within(dialog).findByRole('alert')).textContent).toBe(
        'Your role in this group can’t do this.',
      )
      expect(within(dialog).getByRole('button', { name: 'Unarchive group' })).toBeTruthy()
      expect(screen.queryByText(/is unarchived/)).toBeNull()
    })
  })
})
