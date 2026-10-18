import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction } from '../../lib/api'
import { centsToText, toEmployerValues } from './employer-form'
import { EmployerSettingsPage } from './employer-settings-page'
import { NewEmployerPage } from './new-employer-page'
import { useGroup, useMyMember } from './use-groups'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: { personId: 'p1', profile: { currency: 'AUD' } } }),
}))
vi.mock('./use-groups', () => ({ useGroup: vi.fn(), useMyMember: vi.fn() }))

const call = vi.mocked(callFunction)
const groupHook = vi.mocked(useGroup)
const memberHook = vi.mocked(useMyMember)

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

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function input(label: string | RegExp) {
  return screen.getByLabelText(label) as HTMLInputElement
}

const created = { ok: true as const, data: { group: { ...employer, $id: 'g9' }, members: [] } }

beforeEach(() => mockGroup(undefined))

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
    call.mockResolvedValue({ ok: true, data: { ...employer, name: 'Acme' } })
    const { queryClient } = renderAt('/groups/g1/settings')
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
    expect(queryClient.getQueryData(['group', 'g1'])).toEqual({ ...employer, name: 'Acme' })
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
    expect(screen.getByText('This group is archived.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('falls back to the defaults when the stored settings are not readable', () => {
    mockGroup({ ...employer, settingsJson: '{oops' })
    renderAt('/groups/g1/settings')
    expect(input(/Default hourly rate/).value).toBe('0.00')
    expect(input('Payment terms (days)').value).toBe('14')
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
      toEmployerValues(
        { name: 'X', settings: { type: 'house', autoFinalize: true, defaultBillSplit: 'days' } },
        'AUD',
      ),
    ).toEqual({
      name: 'X',
      recipients: '',
      defaultRate: '0.00',
      statementCycle: 'monthly',
      cycleAnchor: '',
      paymentTermsDays: '14',
      autoFinalize: false,
    })
  })
})
