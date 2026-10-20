import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { RecoverPage } from './recover-page'

vi.mock('../../lib/appwrite', () => ({ account: { createRecovery: vi.fn() } }))

const createRecovery = vi.mocked(account.createRecovery)
const SENT = 'If that address has an account, we’ve sent a link. It works for 1 hour.'

function ask(email: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider
        router={createMemoryRouter([{ path: '/recover', element: <RecoverPage /> }], {
          initialEntries: ['/recover'],
        })}
      />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
}

describe('RecoverPage', () => {
  afterEach(() => {
    cleanup()
    createRecovery.mockReset()
  })

  it('asks Appwrite to email a link back to /recover/complete, then says it was sent', async () => {
    createRecovery.mockResolvedValue({} as never)
    ask(' sam@example.com ')
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(SENT)
    // It replaces the form, so it takes focus: read out, and focus isn't lost.
    expect(document.activeElement).toBe(status)
    expect(createRecovery).toHaveBeenCalledTimes(1)
    // No query string: Appwrite adds its own.
    expect(createRecovery).toHaveBeenCalledWith({
      email: 'sam@example.com',
      url: `${window.location.origin}/recover/complete`,
    })
    expect(screen.queryByLabelText('Email')).toBeNull()
  })

  it.each([
    ['user_not_found', 404],
    ['user_blocked', 401],
  ])('says the same for %s, so it never shows who has an account', async (type, code) => {
    createRecovery.mockRejectedValue(new AppwriteException('No', code, type))
    ask('nobody@example.com')
    expect((await screen.findByRole('status')).textContent).toBe(SENT)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('has its own message for the rate limit, and keeps the form', async () => {
    createRecovery.mockRejectedValue(
      new AppwriteException('Slow', 429, 'general_rate_limit_exceeded'),
    )
    ask('sam@example.com')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You’ve asked for too many links. Try again in an hour.',
    )
    expect(screen.getByLabelText('Email')).toBeTruthy()
  })

  it('shows the generic error for anything else', async () => {
    createRecovery.mockRejectedValue(new TypeError('Failed to fetch'))
    ask('sam@example.com')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Check your connection and try again.',
    )
    expect(screen.queryByText(SENT)).toBeNull()
  })

  it('keeps Send link focusable while sending, and sends once', async () => {
    createRecovery.mockReturnValue(new Promise(() => {}) as never)
    ask('sam@example.com')
    const busy = await screen.findByRole('button', { name: 'Sending…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    busy.focus()
    expect(document.activeElement).toBe(busy)
    fireEvent.click(busy)
    expect(fireEvent.submit(busy.closest('form') as HTMLFormElement)).toBe(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(createRecovery).toHaveBeenCalledTimes(1)
  })
})
