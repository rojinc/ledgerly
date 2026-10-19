import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { LoginPage } from './login-page'
import { signOutOtherSessions } from './sign-out-other-sessions'

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

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: <p>Home page</p> },
      { path: '/recover', element: <p>Recover page</p> },
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
})
