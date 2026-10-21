import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { InvitePage } from './invite-page'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({ account: { createEmailVerification: vi.fn() } }))
// Signed in as u1 by default; tests switch to signed out. Kept in the query cache, so the page
// signing someone out shows.
let mockUser: { $id: string } | null = { $id: 'u1' }
vi.mock('../auth/use-current-user', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  const { queryKeys } = await import('../../lib/query-keys')
  return {
    useCurrentUser: () =>
      useQuery({
        queryKey: queryKeys.currentUser,
        queryFn: () => mockUser,
        initialData: mockUser,
        staleTime: Number.POSITIVE_INFINITY,
      }),
  }
})
// Bootstrapped by default; tests make it wait or fail. A query, so Try again can run it again.
let mockBootstrap: 'done' | 'waiting' | 'failed' = 'done'
vi.mock('../auth/use-bootstrap', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  const { queryKeys } = await import('../../lib/query-keys')
  return {
    useBootstrap: (userId: string) =>
      useQuery({
        queryKey: queryKeys.bootstrap(userId),
        queryFn: async () => {
          if (mockBootstrap === 'failed') throw new Error('Offline.')
          if (mockBootstrap === 'waiting') await new Promise(() => {})
          return { personId: 'p1' }
        },
        staleTime: Number.POSITIVE_INFINITY,
      }),
  }
})

const call = vi.mocked(callFunction)
const TOKEN = 'Ab9_-'.repeat(8)
const REFUSED = { ok: false, error: { code: 'INTERNAL', message: 'Try again.' } } as const

/** An answer the test gives when it's ready, to see the page while it waits. */
function later() {
  let give: (result: Result<unknown>) => void = () => {}
  call.mockReturnValueOnce(
    new Promise((resolve) => {
      give = resolve
    }),
  )
  return (result: Result<unknown>) => act(async () => give(result))
}

/** Clicks a button the way a keyboard user does: it has the focus first. */
function press(name: string) {
  const button = screen.getByRole('button', { name })
  button.focus()
  fireEvent.click(button)
}

function Where({ name }: { name: string }) {
  const location = useLocation()
  return (
    <p>
      {name} from {(location.state as { from?: string } | null)?.from ?? 'nowhere'}
    </p>
  )
}

function renderAt(path: string, strict = false) {
  const router = createMemoryRouter(
    [
      { path: '/invite', element: <InvitePage /> },
      { path: '/login', element: <Where name="Login" /> },
      { path: '/signup', element: <Where name="Signup" /> },
      { path: '/groups', element: <p>Groups</p> },
      { path: '/', element: <p>Home</p> },
    ],
    { initialEntries: [path] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const tree = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  return { router, invalidate }
}

function answer(data: unknown): Result<unknown> {
  return { ok: true, data }
}

beforeEach(() => {
  mockUser = { $id: 'u1' }
  mockBootstrap = 'done'
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('InvitePage', () => {
  it('takes the token off the address bar, sends it only in the body, and opens the group', async () => {
    call.mockResolvedValue(answer({ groupId: 'g1' }))
    const { router, invalidate } = renderAt(`/invite#${TOKEN}`)
    expect(router.state.location.hash).toBe('')
    expect(await screen.findByText('Groups')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/invites/accept', { token: TOKEN })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groups', 'u1'] })
    // Used up: not kept for this tab any more.
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBeNull()
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('accepts once under StrictMode', async () => {
    call.mockResolvedValue(answer({ groupId: 'g1' }))
    renderAt(`/invite#${TOKEN}`, true)
    expect(await screen.findByText('Groups')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('waits for bootstrap before accepting', async () => {
    mockBootstrap = 'waiting'
    renderAt(`/invite#${TOKEN}`)
    expect(await screen.findByText('Joining the group…')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('offers Try again when setting up the account fails, then joins', async () => {
    mockBootstrap = 'failed'
    call.mockResolvedValue(answer({ groupId: 'g1' }))
    renderAt(`/invite#${TOKEN}`)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('We couldn’t set up your account. Try again in a moment.')
    expect(document.activeElement).toBe(alert)
    expect(call).not.toHaveBeenCalled()
    mockBootstrap = 'done'
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Groups')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('offers log in or sign up when signed out, and keeps the token for after', async () => {
    mockUser = null
    const { router } = renderAt(`/invite#${TOKEN}`)
    expect(router.state.location.hash).toBe('')
    // Replaced, so Back doesn't bring the token back into the address bar.
    expect(router.state.historyAction).toBe('REPLACE')
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(TOKEN)
    // Signing up from here agrees to them (#566).
    expect((await screen.findByRole('link', { name: 'Terms of use' })).getAttribute('href')).toBe(
      '/terms',
    )
    fireEvent.click(await screen.findByRole('link', { name: 'Log in' }))
    expect(await screen.findByText('Login from /invite')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
    cleanup()
    renderAt(`/invite#${TOKEN}`)
    fireEvent.click(await screen.findByRole('link', { name: 'Create an account' }))
    expect(await screen.findByText('Signup from /invite')).toBeTruthy()
    // Signed in now, back on /invite without the token in the address.
    cleanup()
    mockUser = { $id: 'u1' }
    call.mockResolvedValue(answer({ groupId: 'g1' }))
    renderAt('/invite')
    expect(await screen.findByText('Groups')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/invites/accept', { token: TOKEN })
  })

  it('asks for the email to be verified, then accepts again', async () => {
    call.mockResolvedValueOnce(answer({ needsVerification: 'email' }))
    vi.mocked(account.createEmailVerification).mockResolvedValue({} as never)
    renderAt(`/invite#${TOKEN}`)
    expect(await screen.findByText(/first verify your email/)).toBeTruthy()
    // Not used up yet: kept for after they verify, even if they reload.
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(TOKEN)
    fireEvent.click(screen.getByRole('button', { name: 'Send the link again' }))
    expect(await screen.findByText('We sent you a new link.')).toBeTruthy()
    expect(account.createEmailVerification).toHaveBeenCalledWith({
      url: `${window.location.origin}/verify-email`,
    })
    call.mockResolvedValueOnce(answer({ groupId: 'g1' }))
    fireEvent.click(screen.getByRole('button', { name: 'I’ve verified it, join now' }))
    expect(await screen.findByText('Groups')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]?.[3]).toEqual({ token: TOKEN })
  })

  it('reads out the verify prompt in the status that said “Joining the group…”', async () => {
    const give = later()
    renderAt(`/invite#${TOKEN}`)
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Joining the group…')
    await give(answer({ needsVerification: 'email' }))
    await waitFor(() =>
      expect(status.textContent).toBe(
        'To join, first verify your email: open the link we sent you, then come back here.',
      ),
    )
    expect(status.isConnected).toBe(true)
  })

  it('moves the focus from Try again and “I’ve verified it” to what replaces them', async () => {
    call.mockResolvedValueOnce(REFUSED)
    renderAt(`/invite#${TOKEN}`)
    await screen.findByRole('alert')
    let give = later()
    press('Try again')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Joining the group…'))
    await give(answer({ needsVerification: 'email' }))
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/^To join, first verify your email/),
    )
    give = later()
    press('I’ve verified it, join now')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Joining the group…'))
    await give(REFUSED)
    const alert = await screen.findByRole('alert')
    expect(document.activeElement).toBe(alert)
  })

  it.each([
    ['an incomplete link', () => {}],
    [
      'an expired invite',
      () => call.mockResolvedValue({ ok: false, error: { code: 'INVITE_INVALID', message: '' } }),
    ],
    ['a phone invite', () => call.mockResolvedValue(answer({ needsVerification: 'phone' }))],
  ])('offers a way into the app from %s', async (state, answerWith) => {
    answerWith()
    renderAt(state === 'an incomplete link' ? '/invite' : `/invite#${TOKEN}`)
    fireEvent.click(await screen.findByRole('link', { name: 'Go to Ledgerly' }))
    expect(await screen.findByText('Home')).toBeTruthy()
  })

  it('says plainly that joining by phone isn’t ready', async () => {
    call.mockResolvedValue(answer({ needsVerification: 'phone' }))
    renderAt(`/invite#${TOKEN}`)
    expect(await screen.findByText(/Joining by phone isn’t ready yet/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says an invalid invite has expired or was used, and forgets it', async () => {
    call.mockResolvedValue({
      ok: false,
      error: {
        code: 'INVITE_INVALID',
        message: "This invite link isn't valid. It may have expired or been used already.",
      },
    })
    renderAt(`/invite#${TOKEN}`)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This invite has expired or was already used.',
    )
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('treats a token too long to send as an invalid invite, without Try again', async () => {
    call.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'The request is not valid.' },
    })
    renderAt(`/invite#${'x'.repeat(129)}`)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This invite has expired or was already used.',
    )
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows another refusal with Try again, keeping the token', async () => {
    call.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL', message: 'Try again.' } })
    renderAt(`/invite#${TOKEN}`)
    expect((await screen.findByRole('alert')).textContent).toBe('Try again.')
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(TOKEN)
    call.mockResolvedValueOnce(answer({ groupId: 'g1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Groups')).toBeTruthy()
  })

  it.each([
    ['UNAUTHENTICATED', 'Please log in again.'],
    ['NOT_FOUND', 'Set up your account first.'],
  ] as const)(
    'signs out on %s, offering log in or sign up and keeping the token',
    async (code, message) => {
      call.mockResolvedValueOnce({ ok: false, error: { code, message } })
      renderAt(`/invite#${TOKEN}`)
      expect(await screen.findByRole('link', { name: 'Log in' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Create an account' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
      expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(TOKEN)
    },
  )

  it('takes a second link opened in the same tab, and accepts it', async () => {
    const NEW = 'Zy8-_'.repeat(8)
    call.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'INVITE_INVALID',
        message: "This invite link isn't valid. It may have expired or been used already.",
      },
    })
    const { router } = renderAt(`/invite#${TOKEN}`)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This invite has expired or was already used.',
    )
    call.mockResolvedValueOnce(answer({ needsVerification: 'email' }))
    await act(() => router.navigate(`/invite#${NEW}`))
    expect(router.state.location.hash).toBe('')
    expect(router.state.historyAction).toBe('REPLACE')
    expect(await screen.findByText(/first verify your email/)).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]?.[3]).toEqual({ token: NEW })
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(NEW)
  })

  it('keeps a newer link’s token when an earlier link’s refusal lands after it', async () => {
    const NEW = 'Zy8-_'.repeat(8)
    let refuseOld: (result: Result<unknown>) => void = () => {}
    call.mockReturnValueOnce(
      new Promise((resolve) => {
        refuseOld = resolve
      }),
    )
    const { router } = renderAt(`/invite#${TOKEN}`)
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    call.mockResolvedValueOnce(answer({ needsVerification: 'email' }))
    await act(() => router.navigate(`/invite#${NEW}`))
    expect(await screen.findByText(/first verify your email/)).toBeTruthy()
    await act(async () => {
      refuseOld({ ok: false, error: { code: 'INVITE_INVALID', message: 'Not valid.' } })
    })
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(NEW)
  })

  it('says when there’s no token at all', async () => {
    renderAt('/invite')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This invite link is incomplete. Open the link from the email again.',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('works when the browser keeps no storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    call.mockResolvedValue(answer({ groupId: 'g1' }))
    renderAt(`/invite#${TOKEN}`)
    expect(await screen.findByText('Groups')).toBeTruthy()
    setItem.mockRestore()
  })

  it('never logs the token', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
      vi.spyOn(console, name as 'log'),
    )
    call.mockResolvedValue(answer({ groupId: 'g1' }))
    renderAt(`/invite#${TOKEN}`)
    await waitFor(() => expect(screen.getByText('Groups')).toBeTruthy())
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
      log.mockRestore()
    }
  })
})
