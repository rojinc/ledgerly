import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { EmailSection } from './email-section'

vi.mock('../../lib/appwrite', () => ({
  account: { get: vi.fn(), updateEmail: vi.fn(), createEmailVerification: vi.fn() },
}))

const get = vi.mocked(account.get)
const updateEmail = vi.mocked(account.updateEmail)
const verify = vi.mocked(account.createEmailVerification)
const SECRET = 'correct horse battery'

/** The signed-in user: `passwordUpdate` is empty for an account made with an email code. */
function user(extra: Record<string, unknown> = {}) {
  return {
    $id: 'u1',
    email: 'sam@example.com',
    emailVerification: true,
    passwordUpdate: '2026-10-01T06:00:00.000Z',
    ...extra,
  } as never
}

/** As ProfilePage does, mounted once the user is known. */
async function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await queryClient.prefetchQuery({ queryKey: queryKeys.currentUser, queryFn: () => account.get() })
  render(
    <QueryClientProvider client={queryClient}>
      <EmailSection />
    </QueryClientProvider>,
  )
  return queryClient
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Change email' }))
  expect(document.activeElement).toBe(screen.getByLabelText('New email'))
}

function send(email: string, password = SECRET) {
  type('New email', email)
  type('Your password', password)
  fireEvent.click(screen.getByRole('button', { name: 'Change email' }))
}

const errorOf = (label: string) =>
  document.getElementById(`${screen.getByLabelText(label).id}-error`)?.textContent ?? ''

function appwriteError(type: string, code = 400) {
  return new AppwriteException('Refused.', code, type)
}

const logs: unknown[][] = []
beforeEach(() => {
  logs.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => logs.push(args))
  }
  get.mockResolvedValue(user())
})

afterEach(() => {
  // Never logged or in the page's HTML, whatever happened (#403 item 5 is `security`).
  expect(JSON.stringify(logs)).not.toContain(SECRET)
  expect(document.body.innerHTML).not.toContain(SECRET)
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('EmailSection (#403 item 5)', () => {
  it('asks an account with no password to set one first, and offers no change', async () => {
    get.mockResolvedValue(user({ passwordUpdate: '' }))
    await renderSection()
    expect(screen.getByText('You sign in with sam@example.com.')).toBeTruthy()
    expect(screen.getByText(/set a password first/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Change email' })).toBeNull()
  })

  it('changes it with the password, sends the link to the new address, and says so', async () => {
    const updated = user({ email: 'sam.new@example.com', emailVerification: false })
    updateEmail.mockResolvedValue(updated)
    verify.mockResolvedValue({} as never)
    const queryClient = await renderSection()
    get.mockResolvedValue(updated)
    open()
    send('  sam.new@example.com ')
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Your email is now sam.new@example.com. We sent a link there to verify it.',
      ),
    )
    expect(updateEmail).toHaveBeenCalledOnce()
    expect(updateEmail).toHaveBeenCalledWith({ email: 'sam.new@example.com', password: SECRET })
    expect(verify).toHaveBeenCalledWith({ url: `${window.location.origin}/verify-email` })
    // The link is sent after the change, so it goes to the new address.
    expect(updateEmail.mock.invocationCallOrder[0]).toBeLessThan(
      verify.mock.invocationCallOrder[0] ?? 0,
    )
    expect(queryClient.getQueryData(queryKeys.currentUser)).toEqual(updated)
    expect(screen.getByText('You sign in with sam.new@example.com.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Email' }))
    expect(screen.queryByLabelText('Your password')).toBeNull()
    // Another change: the last one's news goes, and it can be sent.
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(screen.getByRole('status').textContent).toBe('')
    send('sam.other@example.com')
    await waitFor(() => expect(updateEmail).toHaveBeenCalledTimes(2))
  })

  it('says how to send the link again when it couldn’t be sent, the change done', async () => {
    const updated = user({ email: 'sam.new@example.com', emailVerification: false })
    updateEmail.mockResolvedValue(updated)
    verify.mockRejectedValue(appwriteError('general_rate_limit_exceeded', 429))
    const queryClient = await renderSection()
    get.mockResolvedValue(updated)
    open()
    send('sam.new@example.com')
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Your email is now sam.new@example.com. We couldn’t send the link to verify it: use Send it again at the top of the page.',
      ),
    )
    expect(queryClient.getQueryData(queryKeys.currentUser)).toEqual(updated)
    expect(screen.queryByLabelText('Your password')).toBeNull()
  })

  it('sends once while the link is being sent too', async () => {
    updateEmail.mockResolvedValue(user({ email: 'sam.new@example.com', emailVerification: false }))
    let sent: (value: never) => void = () => {}
    verify.mockReturnValue(new Promise((resolve) => (sent = resolve)))
    await renderSection()
    open()
    send('sam.new@example.com')
    await waitFor(() => expect(verify).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }))
    // Not sent again, nor checked again: the fields, already cleared, would show errors.
    expect(screen.queryByText('Enter your new email address.')).toBeNull()
    sent({} as never)
    await screen.findByText(/^Your email is now/)
    expect(updateEmail).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each([
    ['no email', '', SECRET, 'New email', 'Enter your new email address.'],
    ['not an address', 'sam', SECRET, 'New email', 'Enter an email address like name@example.com'],
    ['the same one', 'SAM@example.com', SECRET, 'New email', 'That’s already your email.'],
    ['no password', 'sam.new@example.com', '', 'Your password', 'Enter your password.'],
    [
      'a password too short to be one',
      'sam.new@example.com',
      'short',
      'Your password',
      'Your password isn’t right.',
    ],
  ])('checks before sending: %s', async (_case, email, password, field, message) => {
    await renderSection()
    open()
    send(email, password)
    await waitFor(() => expect(errorOf(field)).toBe(message))
    expect(document.activeElement).toBe(screen.getByLabelText(field))
    expect(updateEmail).not.toHaveBeenCalled()
  })

  it('says by the password field when Appwrite refuses the password, focuses it, and sends again', async () => {
    updateEmail.mockRejectedValueOnce(appwriteError('user_invalid_credentials', 401))
    updateEmail.mockResolvedValue(user({ email: 'sam.new@example.com', emailVerification: false }))
    verify.mockResolvedValue({} as never)
    await renderSection()
    open()
    send('sam.new@example.com')
    await waitFor(() => expect(errorOf('Your password')).toBe('Your password isn’t right.'))
    // A field's error isn't read out on its own: focus takes the reader there.
    expect(document.activeElement).toBe(screen.getByLabelText('Your password'))
    expect(verify).not.toHaveBeenCalled()
    // The refused password is never kept to check against: the account is read for nothing.
    expect(get).toHaveBeenCalledOnce()
    type('Your password', `${SECRET} 2`)
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }))
    await waitFor(() => expect(updateEmail).toHaveBeenCalledTimes(2))
    expect(updateEmail.mock.calls[1]?.[0]).toStrictEqual({
      email: 'sam.new@example.com',
      password: `${SECRET} 2`,
    })
    expect(await screen.findByText(/^Your email is now sam\.new@example\.com\./)).toBeTruthy()
  })

  it.each([
    ['user_target_already_exists', 409, 'Another account already uses this email.'],
    ['general_bad_request', 400, 'Another account already uses this email.'],
    ['user_email_already_exists', 409, 'Another account already uses this email.'],
    ['general_rate_limit_exceeded', 429, 'Too many attempts. Wait a minute and try again.'],
    ['something_else', 500, 'Something went wrong. Check your connection and try again.'],
  ])('shows why Appwrite refused it: %s', async (type, code, message) => {
    updateEmail.mockRejectedValue(appwriteError(type, code))
    await renderSection()
    open()
    send('sam.new@example.com')
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(verify).not.toHaveBeenCalled()
    expect(screen.getByLabelText('New email')).toBeTruthy()
  })

  it('counts a retry refused as taken as done when an earlier try changed it, its answer lost', async () => {
    const changed = user({ email: 'sam.new@example.com', emailVerification: false })
    updateEmail.mockRejectedValue(appwriteError('user_target_already_exists', 409))
    verify.mockResolvedValue({} as never)
    const queryClient = await renderSection()
    get.mockResolvedValue(changed)
    open()
    send('Sam.New@example.com')
    expect(await screen.findByText(/^Your email is now sam\.new@example\.com\./)).toBeTruthy()
    expect(verify).toHaveBeenCalledOnce()
    expect(queryClient.getQueryData(queryKeys.currentUser)).toEqual(changed)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the refusal when the account can’t be read again', async () => {
    updateEmail.mockRejectedValue(appwriteError('user_target_already_exists', 409))
    await renderSection()
    get.mockRejectedValue(new Error('offline'))
    open()
    send('sam.new@example.com')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Another account already uses this email.',
    )
  })

  it('sends a password exactly as long as the shortest allowed', async () => {
    updateEmail.mockResolvedValue(user({ email: 'sam.new@example.com', emailVerification: false }))
    verify.mockResolvedValue({} as never)
    await renderSection()
    open()
    send('sam.new@example.com', '12345678')
    await waitFor(() => expect(updateEmail).toHaveBeenCalledOnce())
  })

  it('never submits the form itself, and keeps the password out of the cache', async () => {
    updateEmail.mockResolvedValue(user({ email: 'sam.new@example.com', emailVerification: false }))
    verify.mockResolvedValue({} as never)
    const queryClient = await renderSection()
    open()
    const field = screen.getByLabelText('Your password') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('current-password')
    const form = field.form as HTMLFormElement
    expect(form.method).toBe('post')
    type('New email', 'sam.new@example.com')
    type('Your password', SECRET)
    // false: preventDefault ran, so the password never reaches a URL or a request of its own.
    expect(fireEvent.submit(form)).toBe(false)
    await screen.findByText(/^Your email is now/)
    const cached = [
      ...queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
      ...queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ]
    expect(JSON.stringify(cached)).not.toContain(SECRET)
  })

  it('sends once while a change is under way, and holds Cancel', async () => {
    let answer: (value: never) => void = () => {}
    updateEmail.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    verify.mockResolvedValue({} as never)
    await renderSection()
    open()
    send('sam.new@example.com')
    fireEvent.click(await screen.findByRole('button', { name: 'Saving…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('Your password')).toBeTruthy()
    answer(user({ email: 'sam.new@example.com', emailVerification: false }))
    await waitFor(() => expect(screen.queryByLabelText('Your password')).toBeNull())
    expect(updateEmail).toHaveBeenCalledOnce()
  })

  it('clears the fields and goes back to the button on Cancel, sending nothing', async () => {
    await renderSection()
    open()
    type('New email', 'sam.new@example.com')
    type('Your password', SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change email' }))
    open()
    expect((screen.getByLabelText('Your password') as HTMLInputElement).value).toBe('')
    expect(updateEmail).not.toHaveBeenCalled()
  })
})
