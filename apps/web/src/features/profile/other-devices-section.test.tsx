import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signOutOtherSessions } from '../auth/sign-out-other-sessions'
import { OtherDevicesSection } from './other-devices-section'

vi.mock('../auth/sign-out-other-sessions', () => ({ signOutOtherSessions: vi.fn() }))

const signOut = vi.mocked(signOutOtherSessions)

function renderSection() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OtherDevicesSection />
    </QueryClientProvider>,
  )
  return screen.getByRole('button', { name: 'Sign out other devices' })
}

describe('OtherDevicesSection', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it.each([
    [0, 'You weren’t signed in anywhere else.'],
    [1, 'Signed out of 1 other device.'],
    [3, 'Signed out of 3 other devices.'],
  ])('signs out the other sessions and says how many (%i)', async (count, message) => {
    signOut.mockResolvedValue(count)
    fireEvent.click(renderSection())
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.getByText(message).getAttribute('role')).toBe('status')
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('shows a failure, and can try again', async () => {
    signOut.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(2)
    const button = renderSection()
    fireEvent.click(button)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Check your connection and try again.',
    )
    fireEvent.click(button)
    expect(await screen.findByText('Signed out of 2 other devices.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends once while it works', async () => {
    let finish!: () => void
    signOut.mockReturnValue(new Promise((resolve) => (finish = () => resolve(1))))
    fireEvent.click(renderSection())
    const busy = await screen.findByRole('button', { name: 'Signing out…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(busy)
    expect(signOut).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(await screen.findByText('Signed out of 1 other device.')).toBeTruthy()
  })
})
