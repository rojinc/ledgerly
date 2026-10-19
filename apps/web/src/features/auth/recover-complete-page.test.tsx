import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { queryKeys } from '../../lib/query-keys'
import { LoginPage } from './login-page'
import { RecoverCompletePage } from './recover-complete-page'
import { RedirectIfSignedIn } from './route-guards'

vi.mock('../../lib/appwrite', () => ({
  account: { get: vi.fn(), updateRecovery: vi.fn(), deleteSession: vi.fn() },
}))

const get = vi.mocked(account.get)
const update = vi.mocked(account.updateRecovery)
const remove = vi.mocked(account.deleteSession)
const NOTICE = 'Password changed. Sign in to finish.'
const INCOMPLETE = 'This link is incomplete. Open the link from the email again, or get a new one.'
const SECRET = 'link-secret-0123456789'
const PASSWORD = 'correct horse battery'
const LINK = `/recover/complete?userId=u1&secret=${SECRET}&expire=2026-10-19`

let router: ReturnType<typeof createBrowserRouter>

/**
 * Opens the page as the emailed link does, with the real browser history, in a browser signed in
 * as `user` or signed out. /login has its real guard, which sends a signed-in browser home.
 */
function open(url: string, user: { $id: string } | null = null) {
  window.history.replaceState(null, '', url)
  router = createBrowserRouter([
    { path: '/recover/complete', element: <RecoverCompletePage /> },
    { element: <RedirectIfSignedIn />, children: [{ path: '/login', element: <LoginPage /> }] },
    { path: '/', element: <p>Home page</p> },
    { path: '/recover', element: <p>Recover page</p> },
  ])
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.currentUser, user)
  if (user) get.mockResolvedValue(user as never)
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return queryClient
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function setPassword(password: string, again = password) {
  type('New password', password)
  type('New password again', again)
  fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
}

const logs: unknown[][] = []
beforeEach(() => {
  get.mockRejectedValue(new AppwriteException('No session', 401))
  remove.mockResolvedValue({})
  logs.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => logs.push(args))
  }
})

afterEach(() => {
  cleanup()
  router.dispose()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  // Never logged, whatever happened (#290 is `security`).
  expect(JSON.stringify(logs)).not.toContain(SECRET)
  expect(JSON.stringify(logs)).not.toContain(PASSWORD)
})

describe('RecoverCompletePage', () => {
  it.each([
    ['/recover/complete'],
    ['/recover/complete?userId=u1'],
    [`/recover/complete?secret=${SECRET}`],
  ])('says %s is incomplete, and links to /recover', (url) => {
    open(url)
    expect(screen.getByRole('alert').textContent).toBe(INCOMPLETE)
    expect(screen.getByRole('link', { name: 'Get a new link' }).getAttribute('href')).toBe(
      '/recover',
    )
    expect(screen.queryByLabelText('New password')).toBeNull()
  })

  it('takes the secret out of the address bar and history once it has read it', async () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    open(LINK)
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(window.location.href).toBe(`${window.location.origin}/recover/complete`)
    expect(router.state.location.search).toBe('')
    // The page still has the link.
    update.mockResolvedValue({} as never)
    setPassword(PASSWORD)
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ userId: 'u1', secret: SECRET, password: PASSWORD })
  })

  it('sets the password once, then sends them to sign in', async () => {
    let finish!: () => void
    update.mockReturnValue(new Promise((resolve) => (finish = () => resolve({} as never))))
    open(LINK)
    const field = screen.getByLabelText('New password') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('new-password')
    expect(field.maxLength).toBe(256)
    setPassword(PASSWORD)
    // Typed, it's in the field but not in the page's markup.
    expect(document.body.innerHTML).not.toContain(PASSWORD)
    const busy = await screen.findByRole('button', { name: 'Saving…' })
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    // false: preventDefault ran, so the password never reaches a URL.
    expect(fireEvent.submit(field.form as HTMLFormElement)).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(await screen.findByText(NOTICE)).toBeTruthy()
    expect(router.state.location.pathname + router.state.location.search).toBe('/login?reset=1')
  })

  it('signs a signed-in browser out first, so it lands on the notice, not in the app', async () => {
    update.mockResolvedValue({} as never)
    let signedOutFrom = ''
    remove.mockImplementation(async () => {
      signedOutFrom = router.state.location.pathname
      return {}
    })
    const queryClient = open(LINK, { $id: 'u1' })
    queryClient.setQueryData(queryKeys.profile('u1'), { $id: 'u1' })
    setPassword(PASSWORD)
    expect(await screen.findByText(NOTICE)).toBeTruthy()
    expect(remove).toHaveBeenCalledWith({ sessionId: 'current' })
    expect(signedOutFrom).toBe('/recover/complete')
    // As logging out does: nobody signed in, and nothing of theirs cached.
    expect(queryClient.getQueryData(queryKeys.currentUser)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.profile('u1'))).toBeUndefined()
    expect(router.state.location.pathname + router.state.location.search).toBe('/login?reset=1')
    expect(screen.queryByText('Home page')).toBeNull()
  })

  it('goes on to sign in when nobody was signed in here (a 401)', async () => {
    update.mockResolvedValue({} as never)
    remove.mockRejectedValue(new AppwriteException('No', 401, 'general_unauthorized_scope'))
    open(LINK)
    setPassword(PASSWORD)
    expect(await screen.findByText(NOTICE)).toBeTruthy()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['offline', new TypeError('Failed to fetch')],
    ['a 503', new AppwriteException('Down', 503, 'general_server_error')],
  ])(
    'says so when signing this browser out fails (%s), and tries only that again',
    async (_, error) => {
      update.mockResolvedValue({} as never)
      let finish!: () => void
      remove
        .mockRejectedValueOnce(error)
        .mockReturnValueOnce(new Promise((resolve) => (finish = () => resolve({}))))
      open(LINK)
      setPassword(PASSWORD)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(
        'Your password is changed, but we couldn’t sign this browser out. Check your connection and try again.',
      )
      // Focus moves from the form it replaced.
      expect(document.activeElement).toBe(alert)
      // The link is used up: no form to send it again.
      expect(screen.queryByLabelText('New password')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      const status = await screen.findByText('Password changed. Signing this browser out…')
      expect(document.activeElement).toBe(status)
      await act(async () => finish())
      expect(await screen.findByText(NOTICE)).toBeTruthy()
      expect(remove).toHaveBeenCalledTimes(2)
      expect(update).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['user_invalid_token', 401],
    ['user_not_found', 404],
  ])(
    'says the link is used up on %s, and links to /recover and to sign in',
    async (type_, code) => {
      update.mockRejectedValue(new AppwriteException('No', code, type_))
      open(LINK)
      setPassword(PASSWORD)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe('This link has expired or was already used.')
      expect(document.activeElement).toBe(alert)
      expect(screen.queryByLabelText('New password')).toBeNull()
      expect(screen.getByRole('link', { name: 'Get a new link' }).getAttribute('href')).toBe(
        '/recover',
      )
      // In case the reset went through after all: that sign-in still signs out the others.
      fireEvent.click(
        screen.getByRole('link', {
          name: 'If you just set a new password with this link, sign in with it.',
        }),
      )
      expect(await screen.findByText(NOTICE)).toBeTruthy()
      expect(router.state.location.pathname + router.state.location.search).toBe('/login?reset=1')
    },
  )

  it('says the link is incomplete after a reload, since the URL lost its parameters', async () => {
    open(LINK)
    await waitFor(() => expect(window.location.search).toBe(''))
    cleanup()
    router.dispose()
    open(window.location.pathname)
    expect(screen.getByRole('alert').textContent).toBe(INCOMPLETE)
  })

  it.each([
    ['general_rate_limit_exceeded', 'Too many tries. Try again in an hour.'],
    ['password_recently_used', 'Pick a password you haven’t used recently.'],
    ['', 'Something went wrong. Check your connection and try again.'],
  ])('words a %s refusal as Profile does, and lets them try again', async (type_, message) => {
    update.mockRejectedValueOnce(new AppwriteException('No', 429, type_))
    update.mockResolvedValue({} as never)
    open(LINK)
    setPassword(PASSWORD)
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe(PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    expect(await screen.findByText(NOTICE)).toBeTruthy()
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('refuses one under 8 characters, and sends nothing', () => {
    open(LINK)
    setPassword('1234567')
    expect(screen.getByText('Use at least 8 characters.').id).toBe('new-password-error')
    expect(screen.getByLabelText('New password').getAttribute('aria-invalid')).toBe('true')
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses two that differ, and sends nothing', () => {
    open(LINK)
    setPassword(PASSWORD, `${PASSWORD}!`)
    expect(screen.getByText('The passwords don’t match.').id).toBe('repeat-password-error')
    expect(screen.queryByText('Use at least 8 characters.')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})
