import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { LoginPage } from './login-page'
import { signOutOtherSessions } from './sign-out-other-sessions'
import { SignupPage } from './signup-page'

vi.mock('../../lib/appwrite', () => ({
  account: {
    createEmailPasswordSession: vi.fn(),
    createEmailToken: vi.fn(),
    createSession: vi.fn(),
  },
}))
vi.mock('./sign-out-other-sessions', () => ({ signOutOtherSessions: vi.fn() }))

const signIn = vi.mocked(account.createEmailPasswordSession)
const others = vi.mocked(signOutOtherSessions)

function renderAt(path: string | { pathname: string; state: unknown }) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/', element: <p>Home page</p> },
      { path: '/recover', element: <p>Recover page</p> },
      { path: '/invite', element: <p>Invite page</p> },
    ],
    { initialEntries: [path] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function logIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new secret 1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

/** A busy submit keeps focus, and pressing it or submitting again is cancelled and sends nothing. */
async function pressWhileBusy(button: HTMLElement) {
  expect(button.getAttribute('aria-disabled')).toBe('true')
  button.focus()
  expect(document.activeElement).toBe(button)
  fireEvent.click(button)
  expect(fireEvent.submit(button.closest('form') as HTMLFormElement)).toBe(false)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('LoginPage', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('links to /recover from the password form', async () => {
    renderAt('/login')
    fireEvent.click(screen.getByRole('link', { name: 'Forgot your password?' }))
    expect(await screen.findByText('Recover page')).toBeTruthy()
  })

  it('still goes where they were going after a detour to sign-up and back', async () => {
    signIn.mockResolvedValue({} as never)
    renderAt({ pathname: '/login', state: { from: '/invite' } })
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Log in' }))
    await screen.findByRole('link', { name: 'Create an account' })
    logIn()
    expect(await screen.findByText('Invite page')).toBeTruthy()
  })

  it('leaves other sessions alone on an ordinary sign-in', async () => {
    signIn.mockResolvedValue({} as never)
    renderAt('/login')
    expect(screen.queryByText(/Password changed/)).toBeNull()
    logIn()
    expect(await screen.findByText('Home page')).toBeTruthy()
    expect(others).not.toHaveBeenCalled()
  })

  it('after a reset, signs out every other session once signed in, then goes on', async () => {
    signIn.mockResolvedValue({} as never)
    others.mockResolvedValue(2)
    renderAt('/login?reset=1')
    expect(screen.getByRole('status').textContent).toBe('Password changed. Sign in to finish.')
    logIn()
    expect(await screen.findByText('Home page')).toBeTruthy()
    expect(signIn).toHaveBeenCalledWith({ email: 'sam@example.com', password: 'new secret 1' })
    expect(others).toHaveBeenCalledTimes(1)
    expect(signIn.mock.invocationCallOrder[0]).toBeLessThan(others.mock.invocationCallOrder[0] ?? 0)
  })

  it('after a reset, does the same for a sign-in with an email code', async () => {
    vi.mocked(account.createEmailToken).mockResolvedValue({ userId: 'u1' } as never)
    vi.mocked(account.createSession).mockResolvedValue({} as never)
    others.mockResolvedValue(0)
    renderAt('/login?reset=1')
    fireEvent.click(screen.getByRole('button', { name: 'Email code' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Home page')).toBeTruthy()
    expect(others).toHaveBeenCalledTimes(1)
  })

  it('focuses the Code field, which says where the code went (#539)', async () => {
    vi.mocked(account.createEmailToken).mockResolvedValue({ userId: 'u1' } as never)
    renderAt('/login')
    fireEvent.click(screen.getByRole('button', { name: 'Email code' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    const code = await screen.findByLabelText('Code')
    expect(document.activeElement).toBe(code)
    const sent = document.getElementById(code.getAttribute('aria-describedby') ?? '')
    expect(sent?.textContent).toBe('We sent a 6-digit code to sam@example.com.')
  })

  it('shows a failure to sign out the others, and tries again', async () => {
    signIn.mockResolvedValue({} as never)
    others.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(1)
    renderAt('/login?reset=1')
    logIn()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      'You’re signed in, but we couldn’t sign out your other devices. Check your connection and try again.',
    )
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByText('Home page')).toBeNull()
    // Signed in already: only the sign-out is tried again.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Home page')).toBeTruthy()
    expect(others).toHaveBeenCalledTimes(2)
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('keeps Log in focusable while logging in, and logs in once', async () => {
    signIn.mockReturnValue(new Promise(() => {}) as never)
    renderAt('/login')
    logIn()
    await pressWhileBusy(await screen.findByRole('button', { name: 'Logging in…' }))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('keeps the email code buttons focusable while they wait, and sends each once', async () => {
    let sent!: (token: unknown) => void
    vi.mocked(account.createEmailToken).mockReturnValue(
      new Promise((resolve) => {
        sent = resolve
      }) as never,
    )
    vi.mocked(account.createSession).mockReturnValue(new Promise(() => {}) as never)
    renderAt('/login')
    fireEvent.click(screen.getByRole('button', { name: 'Email code' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    await pressWhileBusy(await screen.findByRole('button', { name: 'Sending…' }))
    expect(account.createEmailToken).toHaveBeenCalledTimes(1)
    await act(async () => sent({ userId: 'u1' }))
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await pressWhileBusy(await screen.findByRole('button', { name: 'Checking…' }))
    expect(account.createSession).toHaveBeenCalledTimes(1)
  })
})
