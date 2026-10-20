import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { VerifyEmailBanner } from './verify-email-banner'

vi.mock('../../lib/appwrite', () => ({
  account: { get: vi.fn(), createEmailVerification: vi.fn() },
}))

const get = vi.mocked(account.get)
const verify = vi.mocked(account.createEmailVerification)

function user(email: string, emailVerification = false) {
  return { $id: 'u1', email, emailVerification } as never
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('VerifyEmailBanner', () => {
  it('sends the link again, and starts over for a new email (#403)', async () => {
    get.mockResolvedValue(user('sam@example.com'))
    verify.mockResolvedValue({} as never)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.prefetchQuery({
      queryKey: queryKeys.currentUser,
      queryFn: () => account.get(),
    })
    render(
      <QueryClientProvider client={queryClient}>
        <VerifyEmailBanner />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Check sam@example.com for a link to verify your email.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send it again' }))
    expect(await screen.findByText('We sent a new link to sam@example.com.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send it again' })).toBeNull()
    // The email changed on Profile: the new address hasn't been sent anything from here.
    act(() => queryClient.setQueryData(queryKeys.currentUser, user('sam.new@example.com')))
    expect(
      await screen.findByText('Check sam.new@example.com for a link to verify your email.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send it again' })).toBeTruthy()
  })

  it('shows nothing once the email is verified', async () => {
    get.mockResolvedValue(user('sam@example.com', true))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.prefetchQuery({
      queryKey: queryKeys.currentUser,
      queryFn: () => account.get(),
    })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <VerifyEmailBanner />
      </QueryClientProvider>,
    )
    expect(container.innerHTML).toBe('')
  })
})
