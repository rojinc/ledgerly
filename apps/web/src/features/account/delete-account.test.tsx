import type { Groups } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'
import { useAllBalances } from '../dashboard/use-dashboard'
import { useGroups } from '../groups/use-groups'
import { DeleteAccountPage } from './delete-account-page'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({ account: { deleteSession: vi.fn() } }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))
vi.mock('../dashboard/use-dashboard', () => ({ useAllBalances: vi.fn() }))
// Pair names have their own tests (#145).
vi.mock('../groups/use-group-name', () => ({
  GroupName: ({ group }: { group: Groups }) => group.name,
}))

const call = vi.mocked(callFunction)
const deleteSession = vi.mocked(account.deleteSession)

const flat = { $id: 'g1', name: 'Flat 2/14', type: 'house' } as Groups
const cafe = { $id: 'g2', name: 'Acme Cafe', type: 'employer' } as Groups

function balances(nets: Record<string, number>) {
  vi.mocked(useAllBalances).mockImplementation(
    (groups: Groups[]) =>
      groups.map((group) => ({
        data: { people: [{ personId: 'p1', netCents: nets[group.$id] ?? 0 }], transfers: [] },
      })) as never,
  )
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/account/delete', element: <DeleteAccountPage /> },
      { path: '*', element: <p>Elsewhere</p> },
    ],
    { initialEntries: ['/account/delete'] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['kept'], 'a row of this user’s')
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

function refused(code: string, message: string, details?: unknown): Result<unknown> {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } } as Result<unknown>
}

const confirm = (text = 'DELETE') =>
  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: text } })

const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Delete my account|^Deleting/ }))

beforeEach(() => {
  vi.mocked(useCurrentUser).mockReturnValue({ data: { $id: 'u1' }, isPending: false } as never)
  vi.mocked(useGroups).mockReturnValue({ data: [flat, cafe] } as never)
  balances({})
  deleteSession.mockResolvedValue({} as never)
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('DeleteAccountPage', () => {
  it('says what goes and what stays, links the export, and waits for DELETE', () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Delete your account')
    expect(screen.getByRole('region', { name: 'What’s deleted' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'What stays' }).textContent).toMatch(/Former member/)
    expect(screen.getByRole('link', { name: 'export your data' }).getAttribute('href')).toBe(
      '/export',
    )
    const button = screen.getByRole('button', { name: 'Delete my account' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    for (const text of ['', 'delete', 'DELETE ']) {
      confirm(text)
      expect(button.getAttribute('aria-disabled')).toBe('true')
      submit()
    }
    expect(call).not.toHaveBeenCalled()
    confirm()
    expect(button.getAttribute('aria-disabled')).toBe('false')
  })

  it('warns about balances that aren’t settled', () => {
    balances({ g2: -1500 })
    renderPage()
    const region = screen.getByRole('region', { name: 'Balances not settled' })
    expect(region.textContent).toMatch(/Acme Cafe/)
    expect(region.textContent).not.toMatch(/Flat/)
  })

  it('shows no balance warning when everything is settled', () => {
    renderPage()
    expect(screen.queryByRole('region', { name: 'Balances not settled' })).toBeNull()
  })

  it('deletes, then clears the cache, signs out and says so', async () => {
    // The user comes from the cache here, so clearing it re-renders the page with no user.
    let renders = 0
    vi.mocked(useCurrentUser).mockImplementation(() => {
      renders += 1
      return useQuery({
        queryKey: queryKeys.currentUser,
        queryFn: async () => ({ $id: 'u1' }),
        initialData: { $id: 'u1' },
        staleTime: Number.POSITIVE_INFINITY,
      }) as never
    })
    call.mockResolvedValue({
      ok: true,
      data: { deletedAt: '2026-10-19T08:30:00.000Z', finished: true },
    })
    const { queryClient } = renderPage()
    confirm()
    submit()
    const heading = await screen.findByRole('heading', { name: 'Your account was deleted' })
    expect(call).toHaveBeenCalledWith('account', 'POST', '/delete', { confirm: 'DELETE' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText(/Everything listed is gone\./)).toBeTruthy()
    expect(queryClient.getQueryData(['kept'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.currentUser)).toBeNull()
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'current' })
    // The user is null in the cache now, and the page has re-rendered with it: the message stays.
    expect(renders).toBeGreaterThan(1)
    expect(screen.getByRole('heading', { name: 'Your account was deleted' })).toBeTruthy()
  })

  it('says the rest goes within the hour when the job finishes it', async () => {
    deleteSession.mockRejectedValue(new Error('gone'))
    call.mockResolvedValue({
      ok: true,
      data: { deletedAt: '2026-10-19T08:30:00.000Z', finished: false },
    })
    renderPage()
    confirm()
    submit()
    expect(await screen.findByText(/removed within the hour/)).toBeTruthy()
  })

  it('sends once while deleting', async () => {
    let answer!: (result: Result<unknown>) => void
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderPage()
    confirm()
    submit()
    const busy = await screen.findByRole('button', { name: 'Deleting…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    submit()
    expect(call).toHaveBeenCalledTimes(1)
    await act(async () => answer(refused('INTERNAL', 'Try again later.')))
    expect(screen.getByRole('alert').textContent).toMatch(/Try again later\./)
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeTruthy()
  })

  it('asks to sign in again when the session is old, and comes back here', async () => {
    call.mockResolvedValue(refused('FORBIDDEN', 'Sign in again', { reason: 'reauth' }))
    const { router, queryClient } = renderPage()
    confirm()
    submit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/sign in again, then delete your account within 10 minutes/)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.state).toEqual({ from: '/account/delete' })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'current' })
    expect(queryClient.getQueryData(['kept'])).toBeUndefined()
  })

  it('still goes to sign in when signing out fails', async () => {
    deleteSession.mockRejectedValue(new Error('no session'))
    call.mockResolvedValue(refused('UNAUTHENTICATED', 'No signed-in user'))
    const { router } = renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /We couldn’t confirm the deletion/,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  })

  it('says when the password changed too recently', async () => {
    call.mockResolvedValue(refused('FORBIDDEN', 'Too soon', { reason: 'recent_password_change' }))
    renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/in the last 24 hours/)
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  })

  it('names the houses that need another admin first', async () => {
    call.mockResolvedValue(refused('VALIDATION_FAILED', 'Only admin', { groupIds: ['g1', 'g9'] }))
    renderPage()
    confirm()
    submit()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Make someone else admin first/)
    expect([...alert.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Flat 2/14',
      'A house',
    ])
  })

  it('points to Today when a timer is running', async () => {
    call.mockResolvedValue(refused('CONFLICT', 'Timer running'))
    renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/timer running/)
    expect(screen.getByRole('link', { name: 'Go to Today' }).getAttribute('href')).toBe('/today')
  })

  it('shows any other refusal as the function words it', async () => {
    call.mockResolvedValue(refused('VALIDATION_FAILED', 'Expected DELETE'))
    renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe('Expected DELETE')
  })

  it('sends someone signed out to sign in, and back here', async () => {
    vi.mocked(useCurrentUser).mockReturnValue({ data: null, isPending: false } as never)
    const { router } = renderPage()
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.state).toEqual({ from: '/account/delete' })
  })

  it('waits for the user, and says when they can’t be read', () => {
    vi.mocked(useCurrentUser).mockReturnValue({ data: undefined, isPending: true } as never)
    renderPage()
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    cleanup()
    vi.mocked(useCurrentUser).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    } as never)
    renderPage()
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t reach Ledgerly/)
  })
})
