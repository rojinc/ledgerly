import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callFunction, type Result } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { InviteForm, inviteSentText } from './invite-member'

vi.mock('../../lib/api', () => ({ callFunction: vi.fn() }))
// Whether the caller's email is verified: some tests view it unverified.
let mockVerified = true
vi.mock('../auth/use-current-user', () => ({
  useCurrentUser: () => ({ data: { $id: 'u1', emailVerification: mockVerified } }),
}))

const call = vi.mocked(callFunction)

const GROUP = { $id: 'g1', type: 'house', name: 'Flat 3', archivedAt: null } as Groups
const SAM = {
  $id: 'm3',
  groupId: 'g1',
  personId: 'p3',
  displayName: 'Sam',
  role: 'member',
  status: 'placeholder',
} as Members
const SENT = { sentAt: '2026-10-20T09:00:00.000Z', expiresAt: '2026-11-03T09:00:00.000Z' }

const NOT_THEIR_EMAIL = "This email address isn't one this person was added with."

function ok(data: unknown): Result<unknown> {
  return { ok: true, data }
}

function refused(code: string, message: string): Result<unknown> {
  return { ok: false, error: { code, message } } as Result<unknown>
}

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const reload = vi.spyOn(queryClient, 'invalidateQueries')
  const onSent = vi.fn()
  const onCancel = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <InviteForm group={GROUP} member={SAM} personId="p1" onSent={onSent} onCancel={onCancel} />
    </QueryClientProvider>,
  )
  return { reload, onSent, onCancel }
}

const field = () => screen.getByLabelText('Their email address') as HTMLInputElement

function type(email: string) {
  fireEvent.change(field(), { target: { value: email } })
}

function send(email = 'sam@example.com') {
  type(email)
  // As a click would, so focus has somewhere to come back from.
  const button = screen.getByRole('button', { name: 'Send' })
  button.focus()
  fireEvent.click(button)
}

const errorText = () => document.getElementById(`${field().id}-error`)?.textContent ?? ''

beforeEach(() => {
  mockVerified = true
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('InviteForm (#399)', () => {
  it('is named for the member, focuses the empty field, and never offers saved addresses', () => {
    renderForm()
    expect(screen.getByRole('form', { name: 'Invite Sam by email' })).toBeTruthy()
    expect(document.activeElement).toBe(field())
    expect(field().value).toBe('')
    expect(field().getAttribute('autocomplete')).toBe('off')
    expect(
      document.getElementById(field().getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Use an address they were added with.')
  })

  it('sends the typed address once, and hands on the answer', async () => {
    call.mockResolvedValue(ok(SENT))
    const { onSent, reload } = renderForm()
    send()
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(SENT))
    expect(call).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith('identity', 'POST', '/invites', {
      groupId: 'g1',
      memberId: 'm3',
      email: 'sam@example.com',
    })
    expect(reload).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', '', 'Enter their email address'],
    ['not an address', 'sam', 'Enter an email address like name@example.com'],
  ])('checks the address before sending: %s', async (_case, email, shown) => {
    renderForm()
    send(email)
    await waitFor(() => expect(errorText()).toBe(shown))
    expect(call).not.toHaveBeenCalled()
    // The error stays until Send is pressed again.
    type('sam@example.com')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(errorText()).toBe(shown)
  })

  it('shows the fixed wrong-address message by the field and focuses it, reloading nothing', async () => {
    call.mockResolvedValue(refused('VALIDATION_FAILED', NOT_THEIR_EMAIL))
    const { reload, onSent } = renderForm()
    send()
    await waitFor(() => expect(errorText()).toBe(NOT_THEIR_EMAIL))
    expect(document.activeElement).toBe(field())
    expect(reload).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
  })

  it('says email isn’t sending after a failure, and never sends again by itself', async () => {
    call.mockResolvedValue(refused('INTERNAL', 'Something went wrong.'))
    renderForm()
    send()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Email isn’t sending right now. Try again later.',
    )
    // Give a retry the time it would take.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(call).toHaveBeenCalledOnce()
    // The form stays, with the address, for the person to send again.
    expect(field().value).toBe('sam@example.com')
  })

  it.each([
    ['RATE_LIMITED', 'Too many invites have been sent. Try again later.'],
    ['CONFLICT', 'Someone else changed this at the same time. Try again.'],
    ['NOT_FOUND', 'This member is not in the group.'],
    ['UNAUTHENTICATED', 'Please log in again.'],
  ])('shows the message for %s, reloading nothing', async (code, message) => {
    call.mockResolvedValue(refused(code, message))
    const { reload } = renderForm()
    send()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(reload).not.toHaveBeenCalled()
  })

  it('asks an unverified inviter to verify their email when refused as FORBIDDEN', async () => {
    mockVerified = false
    call.mockResolvedValue(
      refused('FORBIDDEN', 'Verify your email address before you send invites.'),
    )
    const { reload } = renderForm()
    send()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^Verify your email address before sending invites\. .*banner at the top of the page/,
    )
    // The role is checked first, so it may have changed too.
    expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.myMember('g1', 'p1') })
  })

  it('shows the role refusal while whether the email is verified isn’t known', async () => {
    mockVerified = undefined as never
    call.mockResolvedValue(refused('FORBIDDEN', 'Your role in this group can’t do this.'))
    renderForm()
    send()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your role in this group can’t do this.',
    )
  })

  it.each([
    ['FORBIDDEN', 'Your role in this group can’t do this.'],
    ['ARCHIVED', 'This group is archived, so it can no longer be changed.'],
    ['NOT_A_MEMBER', 'You are not a member of this group.'],
  ])('shows why, and reloads the group and role, when refused as %s', async (code, message) => {
    call.mockResolvedValue(refused(code, message))
    const { reload } = renderForm()
    send()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.group('g1') })
    expect(reload).toHaveBeenCalledWith({ queryKey: queryKeys.myMember('g1', 'p1') })
  })

  it('sends once while a send is under way, and holds Cancel', async () => {
    let answer: (result: Result<unknown>) => void = () => {}
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { onSent, onCancel } = renderForm()
    send()
    fireEvent.click(await screen.findByRole('button', { name: 'Sending…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).not.toHaveBeenCalled()
    answer(ok(SENT))
    await waitFor(() => expect(onSent).toHaveBeenCalledOnce())
    expect(call).toHaveBeenCalledOnce()
  })

  it('cancels, sending nothing', () => {
    const { onCancel } = renderForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('inviteSentText', () => {
  it('says when the link stops working, to the minute', () => {
    const at = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    expect(inviteSentText(SENT)).toBe(
      `Invite sent. It expires on ${at.format(new Date(SENT.expiresAt))}.`,
    )
  })
})
