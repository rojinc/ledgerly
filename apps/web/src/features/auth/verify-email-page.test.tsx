import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { VerifyEmailPage } from './verify-email-page'

vi.mock('../../lib/appwrite', () => ({ account: { updateEmailVerification: vi.fn() } }))

describe('VerifyEmailPage', () => {
  afterEach(cleanup)

  it('focuses the result, which replaces the waiting line, so it is read out (#539)', async () => {
    vi.mocked(account.updateEmailVerification).mockResolvedValue({} as never)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider
          router={createMemoryRouter([{ path: '/verify-email', element: <VerifyEmailPage /> }], {
            initialEntries: ['/verify-email?userId=u1&secret=s1'],
          })}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('status').textContent).toBe('Checking your link…')
    const verified = await screen.findByText('Your email is verified.')
    expect(document.activeElement).toBe(verified)
    expect(account.updateEmailVerification).toHaveBeenCalledWith({ userId: 'u1', secret: 's1' })
  })
})
