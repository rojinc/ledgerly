import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { account, tablesDB, teams } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { useCurrentUser } from '../auth/use-current-user'
import { DeleteGroupPage } from './delete-group-page'
import { GroupsPage } from './groups-page'

vi.mock('../../lib/appwrite', () => ({
  DATABASE_ID: 'main',
  account: { deleteSession: vi.fn() },
  teams: { list: vi.fn() },
  tablesDB: { getRow: vi.fn(), listRows: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: vi.fn() }))
vi.mock('../auth/use-bootstrap', () => ({ useBootstrap: () => ({ data: { personId: 'p1' } }) }))

const call = vi.mocked(callFunction)
const getRow = vi.mocked(tablesDB.getRow)
const listRows = vi.mocked(tablesDB.listRows)
const deleteSession = vi.mocked(account.deleteSession)
const HOUR = 3_600_000
const PATH = '/groups/g1/delete'

const flat = {
  $id: 'g1',
  type: 'house',
  name: 'Flat 2/14',
  currency: 'AUD',
  archivedAt: '2026-10-01T00:00:00.000Z',
}

/** The delete's answer, and what the rest of the app reads meanwhile. */
function answer(result: Result<unknown> | Promise<Result<unknown>>) {
  call.mockImplementation(async (_fn, _method, path) => {
    if (path === PATH) return result
    if (path === '/groups/pending') return { ok: true, data: { groups: [] } }
    return { ok: true, data: { people: [], transfers: [] } }
  })
}

function refused(code: string, message: string, details?: unknown): Result<unknown> {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } } as Result<unknown>
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/groups', element: <GroupsPage /> },
      { path: '/groups/:groupId/delete', element: <DeleteGroupPage /> },
      { path: '*', element: <p>Elsewhere</p> },
    ],
    { initialEntries: [PATH] },
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

const confirm = (text = 'DELETE') =>
  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: text } })

const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Delete group|^Deleting/ }))

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'Delete Flat 2/14' })
}

beforeEach(() => {
  vi.mocked(useCurrentUser).mockReturnValue({ data: { $id: 'u1' } } as never)
  getRow.mockResolvedValue(flat as never)
  // Its team is gone once it's deleted, so the list no longer has it.
  vi.mocked(teams.list).mockResolvedValue({ total: 0, teams: [] } as never)
  listRows.mockResolvedValue({ total: 0, rows: [] } as never)
  deleteSession.mockResolvedValue({} as never)
  answer({ ok: true, data: { finished: true } })
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('DeleteGroupPage', () => {
  it('says what goes, links the export, and waits for DELETE', async () => {
    renderPage()
    await loaded()
    expect(screen.getByRole('region', { name: 'What’s deleted' }).textContent).toMatch(
      /final ones included/,
    )
    expect(screen.getByRole('link', { name: 'export its records' }).getAttribute('href')).toBe(
      '/export',
    )
    expect(screen.getByRole('link', { name: 'Back to the group' }).getAttribute('href')).toBe(
      '/groups/g1',
    )
    const button = screen.getByRole('button', { name: 'Delete group' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Type DELETE above first.')
    for (const text of ['', 'delete', 'DELETE ']) {
      confirm(text)
      expect(button.getAttribute('aria-disabled')).toBe('true')
      submit()
    }
    expect(call.mock.calls.some(([, , path]) => path === PATH)).toBe(false)
    confirm()
    expect(button.getAttribute('aria-disabled')).toBe('false')
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  })

  it('names a pair by its page, and links back to it', async () => {
    getRow.mockResolvedValue({ ...flat, type: 'pair', name: 'Sam' } as never)
    renderPage()
    await screen.findByRole('heading', { level: 1, name: 'Delete Sam' })
    expect(screen.getByRole('link', { name: 'Back to the group' }).getAttribute('href')).toBe(
      '/people/g1',
    )
  })

  it('waits for the group, and says when it can’t be read', async () => {
    getRow.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    cleanup()
    getRow.mockRejectedValue(new AppwriteException('Not found', 404))
    renderPage()
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t load this group/)
  })

  it('sends { confirm: "DELETE" }, then says so on the groups list, refreshed, with focus on its heading', async () => {
    const { router, queryClient } = renderPage()
    await loaded()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    confirm()
    fireEvent.submit(
      screen.getByLabelText('Type DELETE to confirm').closest('form') as HTMLFormElement,
    )
    const heading = await screen.findByRole('heading', { level: 1, name: 'Groups' })
    expect(call).toHaveBeenCalledWith('account', 'POST', PATH, { confirm: 'DELETE' })
    expect(router.state.location.pathname).toBe('/groups')
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText('Deleted Flat 2/14.')).toBeTruthy()
    // Said once: the state that carried it is cleared, so a reload doesn't say it again.
    expect(router.state.location.state).toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.groups('u1') })
    // Not in the history: back doesn't return to a deleted group's screen.
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('says the rest goes within the hour when the hourly job finishes it', async () => {
    answer({ ok: true, data: { finished: false } })
    const { router } = renderPage()
    await loaded()
    confirm()
    submit()
    expect(
      await screen.findByText('Deleted Flat 2/14. The rest of it is removed within the hour.'),
    ).toBeTruthy()
    expect(router.state.location.state).toBeNull()
  })

  it('takes the group off the cached list and drops what was read for it (AI E on #449)', async () => {
    const other = { ...flat, $id: 'g2', name: 'Old office', archivedAt: null }
    // The list is read again but never answers, so only the cache shows.
    vi.mocked(teams.list).mockReturnValue(new Promise(() => {}))
    const { queryClient } = renderPage()
    queryClient.setQueryData(queryKeys.groups('u1'), [flat, other])
    queryClient.setQueryData(queryKeys.members('g1'), [])
    queryClient.setQueryData(queryKeys.myMember('g1', 'p1'), { role: 'admin' })
    queryClient.setQueryData(queryKeys.balances('g1'), { people: [], transfers: [] })
    queryClient.setQueryData(queryKeys.members('g2'), [])
    await loaded()
    confirm()
    submit()
    await screen.findByText('Deleted Flat 2/14.')
    expect(await screen.findByRole('link', { name: /Old office/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Flat 2\/14/ })).toBeNull()
    for (const key of [
      queryKeys.group('g1'),
      queryKeys.members('g1'),
      queryKeys.myMember('g1', 'p1'),
      queryKeys.balances('g1'),
    ]) {
      expect(queryClient.getQueryData(key)).toBeUndefined()
    }
    expect(queryClient.getQueryData(queryKeys.members('g2'))).toEqual([])
  })

  it('says it once: Back to the groups list later doesn’t say it again', async () => {
    const { router } = renderPage()
    await loaded()
    confirm()
    submit()
    await screen.findByText('Deleted Flat 2/14.')
    await act(async () => {
      await router.navigate('/elsewhere')
    })
    await act(async () => {
      await router.navigate(-1)
    })
    await screen.findByRole('heading', { level: 1, name: 'Groups' })
    expect(screen.queryByText(/Deleted Flat/)).toBeNull()
  })

  it('treats NOT_A_MEMBER as done: a delete that finished took their member row', async () => {
    answer(refused('NOT_A_MEMBER', 'You’re not a member of this group.'))
    const { router } = renderPage()
    await loaded()
    confirm()
    submit()
    expect(await screen.findByText('Deleted Flat 2/14.')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/groups')
  })

  it('sends once, and can’t be left while the delete is on its way', async () => {
    let settle!: (result: Result<unknown>) => void
    answer(new Promise((resolve) => (settle = resolve)))
    const { router } = renderPage()
    await loaded()
    confirm()
    submit()
    const busy = await screen.findByRole('button', { name: 'Deleting…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Deleting the group…')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Back to the group' })).toBeNull()
    submit()
    expect(call.mock.calls.filter(([, , path]) => path === PATH)).toHaveLength(1)
    await act(async () => {
      await router.navigate('/elsewhere')
    })
    expect(router.state.location.pathname).toBe(PATH)
    await act(async () => settle(refused('INTERNAL', 'Try again later.')))
    expect(screen.getByRole('alert').textContent).toBe('Try again later.')
    expect(screen.getByRole('button', { name: 'Delete group' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to the group' })).toBeTruthy()
  })

  it('asks to sign in again when the session is old, and comes back here', async () => {
    answer(refused('FORBIDDEN', 'Sign in again', { reason: 'reauth' }))
    const { router, queryClient } = renderPage()
    await loaded()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /sign in again, then delete the group within 10 minutes/,
    )
    // Signing out fails for another reason: a session left behind would block the next sign-in.
    deleteSession.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/couldn’t sign you out/),
    )
    expect(router.state.location.pathname).toBe(PATH)
    expect(queryClient.getQueryData(['kept'])).toBeDefined()
    // Already signed out (401): on to sign in, and back here after.
    deleteSession.mockRejectedValueOnce(new AppwriteException('No session', 401))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.state).toEqual({ from: PATH })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'current' })
    expect(queryClient.getQueryData(['kept'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.currentUser)).toBeNull()
  })

  it('asks to sign in again when the session is over', async () => {
    answer(refused('UNAUTHENTICATED', 'Please log in again.'))
    renderPage()
    await loaded()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Please log in again\./)
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })

  it('says when the password changed too recently, and when to try again', async () => {
    const changedAt = Date.now() - HOUR
    vi.mocked(useCurrentUser).mockReturnValue({
      data: { $id: 'u1', passwordUpdate: new Date(changedAt).toISOString() },
    } as never)
    answer(refused('FORBIDDEN', 'Too soon', { reason: 'recent_password_change' }))
    renderPage()
    await loaded()
    confirm()
    submit()
    const at = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(changedAt + 24 * HOUR)
    expect((await screen.findByRole('alert')).textContent).toBe(
      `A sign-in detail (your password, email or phone) changed in the last 24 hours. For your safety, you can delete the group from ${at}.`,
    )
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  })

  it('says why when someone else is still in the group', async () => {
    answer(refused('VALIDATION_FAILED', 'Shared', { reason: 'shared' }))
    renderPage()
    await loaded()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone else is still in this group, so it can’t be deleted: only the last person in it can. That includes anyone who moved out.',
    )
  })

  it.each([
    ['CONFLICT', 'Something else changed this at the same time. Try again.', undefined],
    ['FORBIDDEN', 'Your role in this group can’t do this.', undefined],
    ['FORBIDDEN', 'Not allowed', { reason: 'other' }],
    ['VALIDATION_FAILED', 'Archive the group first, then delete it.', undefined],
    ['VALIDATION_FAILED', 'Not an object', 'shared'],
  ])('shows %s in the function’s words: %s', async (code, message, details) => {
    answer(refused(code, message, details))
    const { router } = renderPage()
    await loaded()
    confirm()
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
    expect(router.state.location.pathname).toBe(PATH)
  })
})
