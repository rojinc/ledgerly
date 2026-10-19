import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { account } from '../../lib/appwrite'
import { InvitePage } from './invite-page'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
vi.mock('../../lib/appwrite', () => ({ account: { createEmailVerification: vi.fn() } }))
// Signed in as u1 by default; tests switch to signed out.
let mockUser: { $id: string } | null = { $id: 'u1' }
vi.mock('../auth/use-current-user', () => ({
  useCurrentUser: () => ({ data: mockUser, isPending: false, isError: false }),
}))
let mockBootstrapped = true
// The phone step has its own tests: here it only reports a verified number.
vi.mock('../profile/phone-section', () => ({
  PhoneSection: ({ onVerified }: { onVerified: () => void }) => (
    <button type="button" onClick={onVerified}>
      Phone verified
    </button>
  ),
}))
vi.mock('../auth/use-bootstrap', () => ({
  useBootstrap: () => ({ data: mockBootstrapped ? { personId: 'p1' } : undefined }),
}))

const call = vi.mocked(callFunction)
const TOKEN = 'Ab9_-'.repeat(8)

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
  mockBootstrapped = true
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groups'] })
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
    mockBootstrapped = false
    renderAt(`/invite#${TOKEN}`)
    expect(await screen.findByText('Joining the group…')).toBeTruthy()
    expect(call).not.toHaveBeenCalled()
  })

  it('offers log in or sign up when signed out, and keeps the token for after', async () => {
    mockUser = null
    const { router } = renderAt(`/invite#${TOKEN}`)
    expect(router.state.location.hash).toBe('')
    expect(sessionStorage.getItem('ledgerly.inviteToken')).toBe(TOKEN)
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

  it('opens the phone step for a phone invite, then accepts again', async () => {
    call.mockResolvedValueOnce(answer({ needsVerification: 'phone' }))
    renderAt(`/invite#${TOKEN}`)
    expect(await screen.findByText(/first add and verify the phone number/)).toBeTruthy()
    call.mockResolvedValueOnce(answer({ groupId: 'g1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Phone verified' }))
    expect(await screen.findByText('Groups')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('says an invalid invite has expired or was used, and forgets it', async () => {
    call.mockResolvedValue({
      ok: false,
      error: { code: 'INVITE_INVALID', message: 'Invite token unknown, expired or used' },
    })
    renderAt(`/invite#${TOKEN}`)
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
