import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { PasswordSection } from './password-section'

vi.mock('../../lib/appwrite', () => ({
  account: { get: vi.fn(), updatePassword: vi.fn() },
}))

const get = vi.mocked(account.get)
const update = vi.mocked(account.updatePassword)
const SECRET = 'correct horse battery'

/** The signed-in user: `passwordUpdate` is empty for an account made with an email code. */
function user(passwordUpdate: string) {
  return { $id: 'u1', passwordUpdate } as never
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PasswordSection />
    </QueryClientProvider>,
  )
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

const logs: unknown[][] = []
beforeEach(() => {
  logs.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => logs.push(args))
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  // Never logged, whatever happened (#203 is `security`).
  expect(JSON.stringify(logs)).not.toContain(SECRET)
})

describe('PasswordSection, an account without a password', () => {
  beforeEach(() => {
    get.mockResolvedValueOnce(user('')).mockResolvedValue(user('2026-10-19T06:00:00.000Z'))
  })

  it('sets one with no old password, then says so and offers a change', async () => {
    update.mockResolvedValue(user('2026-10-19T06:00:00.000Z'))
    renderSection()
    expect(await screen.findByText(/has no password yet/)).toBeTruthy()
    expect(document.getElementById('password')?.tagName).toBe('SECTION')
    const field = screen.getByLabelText('New password') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('new-password')
    type('New password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[0]).toStrictEqual({ password: SECRET })
    const status = await screen.findByText('Password set.')
    expect(status.getAttribute('role')).toBe('status')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Password' }))
    // Read again: the account has one now, so the phone section stops asking (#176).
    expect(await screen.findByRole('button', { name: 'Change password' })).toBeTruthy()
    expect(get).toHaveBeenCalledTimes(2)
    // Nothing keeps it.
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('shows the change form at once, even when reading the user again fails', async () => {
    get.mockReset()
    get.mockResolvedValueOnce(user('')).mockRejectedValue(new Error('offline'))
    update.mockResolvedValue(user('2026-10-19T06:00:00.000Z'))
    renderSection()
    await screen.findByText(/has no password yet/)
    type('New password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    expect(await screen.findByRole('button', { name: 'Change password' })).toBeTruthy()
    expect(screen.queryByText(/has no password yet/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set password' })).toBeNull()
  })

  it('refuses one under 8 characters, under the field, and sends nothing', async () => {
    renderSection()
    await screen.findByText(/has no password yet/)
    type('New password', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    const field = screen.getByLabelText('New password')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Use at least 8 characters.').id).toBe('new-password-error')
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps Set password from sending twice while it saves', async () => {
    let finish!: () => void
    update.mockReturnValue(
      new Promise((resolve) => (finish = () => resolve(user('2026-10-19T06:00:00.000Z')))),
    )
    renderSection()
    await screen.findByText(/has no password yet/)
    type('New password', SECRET)
    const button = screen.getByRole('button', { name: 'Set password' })
    fireEvent.click(button)
    const busy = await screen.findByRole('button', { name: 'Saving…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect(busy.hasAttribute('disabled')).toBe(false)
    fireEvent.click(busy)
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => finish())
  })
})

describe('PasswordSection, an account with a password', () => {
  beforeEach(() => {
    get.mockResolvedValue(user('2026-01-01T00:00:00.000Z'))
  })

  async function openChange() {
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Current password'))
  }

  it('changes it with the current one, then closes and says so', async () => {
    update.mockResolvedValue(user('2026-10-19T06:00:00.000Z'))
    renderSection()
    await openChange()
    expect((screen.getByLabelText('Current password') as HTMLInputElement).autocomplete).toBe(
      'current-password',
    )
    type('Current password', 'old secret 1')
    type('New password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[0]).toStrictEqual({
      password: SECRET,
      oldPassword: 'old secret 1',
    })
    expect(await screen.findByText('Password changed.')).toBeTruthy()
    expect(screen.queryByLabelText('New password')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Password' }))
    // Opened again, it starts empty.
    await openChange()
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('')
  })

  it('asks for the current password', async () => {
    renderSection()
    await openChange()
    type('New password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter your current password.')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it.each([
    ['user_invalid_credentials', 'Your current password isn’t right.'],
    ['password_recently_used', 'Pick a password you haven’t used recently.'],
    ['password_personal_data', 'Pick a password that doesn’t include your name, email or phone.'],
    ['password_pwned', 'This password has appeared in a data breach. Pick another one.'],
    [
      'general_argument_invalid',
      'Pick a stronger password: at least 8 characters, not a common one.',
    ],
    ['general_rate_limit_exceeded', 'Too many tries. Wait a few minutes and try again.'],
    ['something_else', 'Something went wrong. Check your connection and try again.'],
  ])('words a %s refusal and keeps what was typed', async (type_, message) => {
    update.mockRejectedValue(new AppwriteException('refused', 400, type_))
    renderSection()
    await openChange()
    type('Current password', 'old secret 1')
    type('New password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe(SECRET)
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('false')
  })

  it('cancels without sending, clears the fields and puts focus back', async () => {
    renderSection()
    await openChange()
    type('New password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change password' }))
    expect(update).not.toHaveBeenCalled()
    expect(document.body.innerHTML).not.toContain(SECRET)
    // Opened again, nothing typed before is there.
    await openChange()
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('')
  })
})
