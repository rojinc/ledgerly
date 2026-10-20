import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { LoginPage } from './login-page'
import { SignupPage } from './signup-page'

vi.mock('../../lib/appwrite', () => ({
  account: {
    create: vi.fn(),
    createEmailPasswordSession: vi.fn(),
    createEmailVerification: vi.fn(),
  },
}))

function renderAt(entry: { pathname: string; state: unknown }) {
  const router = createMemoryRouter(
    [
      { path: '/signup', element: <SignupPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: <p>Home page</p> },
      { path: '/invite', element: <p>Invite page</p> },
    ],
    { initialEntries: [entry] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('SignupPage', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('still goes where they were going after a detour to log-in and back', async () => {
    vi.mocked(account.create).mockResolvedValue({} as never)
    vi.mocked(account.createEmailPasswordSession).mockResolvedValue({} as never)
    vi.mocked(account.createEmailVerification).mockResolvedValue({} as never)
    renderAt({ pathname: '/signup', state: { from: '/invite' } })
    fireEvent.click(screen.getByRole('link', { name: 'Log in' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Create an account' }))
    await screen.findByRole('link', { name: 'Log in' })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sam' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new secret 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Invite page')).toBeTruthy()
    expect(account.create).toHaveBeenCalledTimes(1)
  })
})
