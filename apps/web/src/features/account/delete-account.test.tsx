import type { Groups } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useBootstrap } from '../auth/use-bootstrap'
import { useCurrentUser } from '../auth/use-current-user'
import { useAllBalances } from '../dashboard/use-dashboard'
import { useGroups } from '../groups/use-groups'
import { DeleteAccountPage } from './delete-account-page'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({ account: { deleteSession: vi.fn() } }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: vi.fn() }))
vi.mock('../groups/use-groups', () => ({ useGroups: vi.fn() }))
vi.mock('../dashboard/use-dashboard', () => ({ useAllBalances: vi.fn() }))
// Pair names have their own tests (#145).
vi.mock('../groups/use-group-name', () => ({
  GroupName: ({ group }: { group: Groups }) => group.name,
}))

const call = vi.mocked(callFunction)
const HOUR = 3_600_000
const deleteSession = vi.mocked(account.deleteSession)

const flat = { $id: 'g1', name: 'Flat 2/14', type: 'house' } as Groups
const cafe = { $id: 'g2', name: 'Acme Cafe', type: 'employer' } as Groups

// A group whose balance can't be read.
let failing = ''

function balances(nets: Record<string, number>) {
  vi.mocked(useAllBalances).mockImplementation(
    (groups: Groups[]) =>
      groups.map((group) =>
        group.$id === failing
          ? { data: undefined, isPending: false, isError: true }
          : {
              data: { people: [{ personId: 'p1', netCents: nets[group.$id] ?? 0 }], transfers: [] },
              isPending: false,
              isError: false,
            },
      ) as never,
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

/** `useCurrentUser` read from the cache, as the app's is, so setting it to null re-renders. */
function cachedUser(user: object = { $id: 'u1' }) {
  vi.mocked(useCurrentUser).mockImplementation(
    () =>
      useQuery({
        queryKey: queryKeys.currentUser,
        queryFn: async () => user,
        initialData: user,
        staleTime: Number.POSITIVE_INFINITY,
      }) as never,
  )
}

const signedOut = () => new AppwriteException('No session', 401)

const confirm = (text = 'DELETE') =>
  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: text } })

const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Delete my account|^Deleting/ }))

beforeEach(() => {
  vi.mocked(useCurrentUser).mockReturnValue({ data: { $id: 'u1' }, isPending: false } as never)
  vi.mocked(useGroups).mockReturnValue({ data: [flat, cafe] } as never)
  vi.mocked(useBootstrap).mockReturnValue({ data: { personId: 'p1' }, isError: false } as never)
  failing = ''
  balances({})
  deleteSession.mockResolvedValue({} as never)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.resetAllMocks()
})

describe('DeleteAccountPage', () => {
  it('says what goes and what stays, links the export, and waits for DELETE', () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Delete your account')
    expect(screen.getByRole('region', { name: 'What’s deleted' })).toBeTruthy()
    expect(
      screen.getByRole('region', { name: 'What stays, in groups shared with others' }).textContent,
    ).toMatch(/Former member/)
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

  it('names groups whose balance can’t be checked', () => {
    failing = 'g1'
    renderPage()
    const region = screen.getByRole('region', { name: 'Balances not settled' })
    expect(region.textContent).toMatch(/couldn’t check your balance in these groups:Flat 2\/14/)
  })

  it('waits for the account and balances before it can delete', () => {
    vi.mocked(useBootstrap).mockReturnValue({ data: undefined, isError: false } as never)
    renderPage()
    expect(screen.getByText('Checking your balances…')).toBeTruthy()
    confirm()
    const button = screen.getByRole('button', { name: 'Delete my account' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('This waits until your balances are checked.')
    submit()
    expect(call).not.toHaveBeenCalled()
    cleanup()
    vi.mocked(useAllBalances).mockReturnValue([{ isPending: true }, { isPending: true }] as never)
    vi.mocked(useBootstrap).mockReturnValue({ data: { personId: 'p1' }, isError: false } as never)
    renderPage()
    expect(screen.getByText('Checking your balances…')).toBeTruthy()
  })

  it('says when the account or groups can’t be checked', () => {
    vi.mocked(useBootstrap).mockReturnValue({ data: undefined, isError: true } as never)
    renderPage()
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t check your groups and balances/)
  })

  it('explains the button until DELETE is typed, and deletes on Enter', async () => {
    call.mockResolvedValue({
      ok: true,
      data: { deletedAt: '2026-10-19T08:30:00.000Z', finished: true },
    })
    renderPage()
    const button = screen.getByRole('button', { name: 'Delete my account' })
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Type DELETE above first.')
    confirm()
    expect(button.hasAttribute('aria-describedby')).toBe(false)
    fireEvent.submit(
      screen.getByLabelText('Type DELETE to confirm').closest('form') as HTMLFormElement,
    )
    expect(await screen.findByRole('heading', { name: 'Your account was deleted' })).toBeTruthy()
  })

  it('can’t be left while the deletion is on its way', async () => {
    let answer!: (result: Result<unknown>) => void
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { router } = renderPage()
    confirm()
    submit()
    await screen.findByRole('button', { name: 'Deleting…' })
    expect(screen.queryByRole('link', { name: 'Back to your profile' })).toBeNull()
    expect(screen.getByText('Deleting your account…')).toBeTruthy()
    await act(async () => {
      await router.navigate('/profile')
    })
    expect(router.state.location.pathname).toBe('/account/delete')
    await act(async () =>
      answer({ ok: true, data: { deletedAt: '2026-10-19T08:30:00.000Z', finished: true } }),
    )
    expect(screen.getByRole('heading', { name: 'Your account was deleted' })).toBeTruthy()
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
    expect(localStorage.getItem('ledgerly:onboarding-hidden:u1')).toBeNull()
    expect(localStorage.getItem('cookieFallback')).toBeNull()
    expect(screen.getByText(/signed out on every device/)).toBeTruthy()
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
    // Signing out fails for another reason: a session left behind would block the next sign-in.
    deleteSession.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/couldn’t sign you out/),
    )
    expect(router.state.location.pathname).toBe('/account/delete')
    expect(queryClient.getQueryData(['kept'])).toBeDefined()
    // Already signed out (401): on to sign in.
    deleteSession.mockRejectedValueOnce(signedOut())
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.state).toEqual({ from: '/account/delete' })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'current' })
    expect(queryClient.getQueryData(['kept'])).toBeUndefined()
  })

  it('treats an UNAUTHENTICATED answer as maybe deleted, and keeps saying so', async () => {
    cachedUser()
    localStorage.setItem('ledgerly:onboarding-hidden:u1', '1')
    localStorage.setItem('cookieFallback', '{"a_session":"secret"}')
    call.mockResolvedValue(refused('UNAUTHENTICATED', 'No signed-in user'))
    const { router, queryClient } = renderPage()
    confirm()
    submit()
    const heading = await screen.findByRole('heading', { name: 'We couldn’t confirm the deletion' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    // Nothing of the account's stays in the browser.
    expect(queryClient.getQueryData(['kept'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.currentUser)).toBeNull()
    expect(localStorage.getItem('ledgerly:onboarding-hidden:u1')).toBeNull()
    expect(localStorage.getItem('cookieFallback')).toBeNull()
    expect(router.state.location.pathname).toBe('/account/delete')
    deleteSession.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t sign you out/)
    expect(router.state.location.pathname).toBe('/account/delete')
    deleteSession.mockRejectedValueOnce(signedOut())
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.state).toEqual({ from: '/account/delete' })
  })

  it('sends no bootstrap after an UNAUTHENTICATED answer, with the real useBootstrap', async () => {
    const real =
      await vi.importActual<typeof import('../auth/use-bootstrap')>('../auth/use-bootstrap')
    vi.mocked(useBootstrap).mockImplementation(real.useBootstrap)
    cachedUser()
    call.mockImplementation((async (_fn: string, _method: string, path: string) =>
      path === '/bootstrap'
        ? { ok: true, data: { personId: 'p1' } }
        : refused('UNAUTHENTICATED', 'No signed-in user')) as never)
    const { router } = renderPage()
    confirm()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Delete my account' }).getAttribute('aria-disabled'),
      ).toBe('false'),
    )
    submit()
    await screen.findByRole('heading', { name: 'We couldn’t confirm the deletion' })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(call.mock.calls.map((args) => args[2])).toEqual(['/bootstrap', '/delete'])
    expect(router.state.location.pathname).toBe('/account/delete')
  })

  it('says when the password changed too recently, and when to try again', async () => {
    // An hour ago by the real clock, so the 24 hours are still running whenever this runs.
    const changedAt = Date.now() - HOUR
    vi.mocked(useCurrentUser).mockReturnValue({
      data: { $id: 'u1', passwordUpdate: new Date(changedAt).toISOString() },
      isPending: false,
    } as never)
    call.mockResolvedValue(refused('FORBIDDEN', 'Too soon', { reason: 'recent_password_change' }))
    renderPage()
    confirm()
    submit()
    const at = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(changedAt + 24 * HOUR)
    expect((await screen.findByRole('alert')).textContent).toBe(
      `A sign-in detail (your password, email or phone) changed in the last 24 hours. For your safety, you can delete your account from ${at}.`,
    )
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  })

  it.each([
    ['isn’t known', undefined],
    ['would already be past', '2026-01-01T00:00:00.000Z'],
  ])('says 24 hours after the change when the time %s', async (_case, passwordUpdate) => {
    vi.mocked(useCurrentUser).mockReturnValue({
      data: { $id: 'u1', passwordUpdate },
      isPending: false,
    } as never)
    call.mockResolvedValue(refused('FORBIDDEN', 'Too soon', { reason: 'recent_password_change' }))
    renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /delete your account 24 hours after that change\.$/,
    )
  })

  it('shows a FORBIDDEN with another reason, or none, as the function words it', async () => {
    call
      .mockResolvedValueOnce(refused('FORBIDDEN', 'Not allowed', { reason: 'other' }))
      .mockResolvedValueOnce(refused('FORBIDDEN', 'Not allowed either'))
      .mockResolvedValueOnce(refused('FORBIDDEN', 'Not an object', 'reauth'))
    renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe('Not allowed')
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not allowed either'))
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not an object'))
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

  it.each([
    'A timer is running. Stop or void it first.',
    'A statement is being finalized. Finish it first.',
    'Something else changed this at the same time. Try again.',
  ])('shows each CONFLICT in the function’s words: %s', async (message) => {
    call.mockResolvedValue(refused('CONFLICT', message))
    renderPage()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toContain(message)
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
