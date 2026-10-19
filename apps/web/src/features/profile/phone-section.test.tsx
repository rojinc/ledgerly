import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppwriteException } from 'appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { account } from '../../lib/appwrite'
import { PhoneSection, RESEND_SECONDS } from './phone-section'

vi.mock('../../lib/appwrite', () => ({
  account: {
    updatePhone: vi.fn(),
    createPhoneVerification: vi.fn(),
    updatePhoneVerification: vi.fn(),
  },
}))
// A password account in Sydney with no phone yet; tests change it.
let mockUser: Record<string, unknown>
vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: mockUser }) }))
vi.mock('./use-profile', () => ({ useProfile: () => ({ data: { region: 'AU-NSW' } }) }))

const updatePhone = vi.mocked(account.updatePhone)
const sendCode = vi.mocked(account.createPhoneVerification)
const verifyCode = vi.mocked(account.updatePhoneVerification)

function renderSection(onVerified?: () => void) {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <PhoneSection onVerified={onVerified} />
    </QueryClientProvider>,
  )
  return { invalidate }
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function appwriteError(type: string) {
  return new AppwriteException('Appwrite says no', 400, type)
}

beforeEach(() => {
  mockUser = {
    $id: 'u1',
    phone: '',
    phoneVerification: false,
    passwordUpdate: '2026-10-01T00:00:00.000+00:00',
  }
  updatePhone.mockResolvedValue({} as never)
  sendCode.mockResolvedValue({} as never)
  verifyCode.mockResolvedValue({} as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('PhoneSection', () => {
  it('shows the phone and whether it’s verified', () => {
    mockUser = { ...mockUser, phone: '+61491570006', phoneVerification: true }
    renderSection()
    expect(screen.getByText('+61491570006')).toBeTruthy()
    expect(screen.getByText(/Verified/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send a code to verify it' })).toBeNull()
    cleanup()
    mockUser = { ...mockUser, phoneVerification: false }
    renderSection()
    expect(screen.getByText(/Not verified yet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send a code to verify it' })).toBeTruthy()
    cleanup()
    mockUser = { ...mockUser, phone: '' }
    renderSection()
    expect(screen.getByText('No phone number yet.')).toBeTruthy()
  })

  it('refuses a number that isn’t one, calling nothing', async () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add a phone number' }))
    type('Mobile number', '12')
    type('Your Ledgerly password', 'secret-pass')
    fireEvent.click(screen.getByRole('button', { name: 'Save and send a code' }))
    const message = await screen.findByText(
      'Enter a mobile number, with its country code if it’s from another country.',
    )
    expect(screen.getByLabelText('Mobile number').getAttribute('aria-describedby')).toBe(message.id)
    expect(updatePhone).not.toHaveBeenCalled()
  })

  it('saves the number in E.164 for the profile’s region, sends a code, and verifies it', async () => {
    const onVerified = vi.fn()
    const { invalidate } = renderSection(onVerified)
    fireEvent.click(screen.getByRole('button', { name: 'Add a phone number' }))
    type('Mobile number', '0491 570 006')
    type('Your Ledgerly password', 'secret-pass')
    fireEvent.click(screen.getByRole('button', { name: 'Save and send a code' }))
    await waitFor(() =>
      expect(updatePhone).toHaveBeenCalledWith({ phone: '+61491570006', password: 'secret-pass' }),
    )
    expect(await screen.findByLabelText('Code from the SMS')).toBeTruthy()
    expect(sendCode).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Enter the code from the SMS.')).toBeTruthy()
    expect(verifyCode).not.toHaveBeenCalled()
    type('Code from the SMS', ' 123456 ')
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1))
    expect(verifyCode).toHaveBeenCalledWith({ userId: 'u1', secret: '123456' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['currentUser'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bootstrap', 'u1'] })
  })

  it('makes a new code wait 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    mockUser = { ...mockUser, phone: '+61491570006' }
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Send a code to verify it' }))
    expect(
      await screen.findByText(`You can ask for a new code in ${RESEND_SECONDS} s.`),
    ).toBeTruthy()
    const resend = screen.getByRole('button', { name: 'Send a new code' })
    expect(resend.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(resend)
    expect(sendCode).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime((RESEND_SECONDS - 1) * 1000))
    expect(screen.getByText('You can ask for a new code in 1 s.')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('You can ask for a new code now.')).toBeTruthy()
    fireEvent.click(resend)
    await waitFor(() => expect(sendCode).toHaveBeenCalledTimes(2))
    // And waits again.
    expect(
      await screen.findByText(`You can ask for a new code in ${RESEND_SECONDS} s.`),
    ).toBeTruthy()
  })

  it.each([
    ['user_invalid_credentials', 'save', 'That password isn’t right.'],
    ['user_phone_already_exists', 'save', 'This number is already on another account.'],
    ['user_invalid_token', 'verify', 'That code is wrong or has expired. Ask for a new one.'],
    ['general_rate_limit_exceeded', 'verify', 'Too many tries. Wait a few minutes and try again.'],
    ['something_else', 'verify', 'Something went wrong. Check your connection and try again.'],
  ])('says %s in plain words', async (code, step, message) => {
    if (step === 'save') updatePhone.mockRejectedValue(appwriteError(code))
    else verifyCode.mockRejectedValue(appwriteError(code))
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add a phone number' }))
    type('Mobile number', '0491 570 006')
    type('Your Ledgerly password', 'secret-pass')
    fireEvent.click(screen.getByRole('button', { name: 'Save and send a code' }))
    if (step === 'verify') {
      await screen.findByLabelText('Code from the SMS')
      type('Code from the SMS', '1')
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    }
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  it('asks an account without a password to set one first', () => {
    mockUser = { ...mockUser, passwordUpdate: '' }
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add a phone number' }))
    // It links to the Password section on the same page (#203).
    expect(screen.getByRole('link', { name: 'Set a password' }).getAttribute('href')).toBe(
      '#password',
    )
    expect(screen.getByText(/first: changing the phone on your account needs it/)).toBeTruthy()
    expect(screen.queryByLabelText('Mobile number')).toBeNull()
  })
})
