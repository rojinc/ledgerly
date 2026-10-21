import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfilePage } from './profile-page'
import { usePerson, useProfile } from './use-profile'

vi.mock('../auth/use-current-user', () => ({ useCurrentUser: () => ({ data: { $id: 'u1' } }) }))
vi.mock('./use-profile', () => ({
  useProfile: vi.fn(),
  usePerson: vi.fn(),
  useUpdateProfile: () => ({ mutateAsync: vi.fn() }),
}))
// The sections have tests of their own; here they only show the page has loaded.
vi.mock('./profile-form', () => ({ ProfileForm: () => <p>Profile form</p> }))
vi.mock('./business-form', () => ({ BusinessForm: () => null }))
vi.mock('./hours-cap-form', () => ({ HoursCapForm: () => null }))
vi.mock('./email-settings-form', () => ({ EmailSettingsForm: () => null }))
vi.mock('./email-section', () => ({ EmailSection: () => null }))
vi.mock('./password-section', () => ({ PasswordSection: () => null }))
vi.mock('./other-devices-section', () => ({ OtherDevicesSection: () => null }))

const profileHook = vi.mocked(useProfile)
const personHook = vi.mocked(usePerson)

function show(
  profile: Partial<ReturnType<typeof useProfile>>,
  person: Partial<ReturnType<typeof usePerson>> = { data: undefined, isError: false },
) {
  profileHook.mockReturnValue(profile as ReturnType<typeof useProfile>)
  personHook.mockReturnValue(person as ReturnType<typeof usePerson>)
  return (
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>
  )
}

const LOADED = { data: { personId: 'p1' }, isError: false } as Partial<
  ReturnType<typeof useProfile>
>

describe('ProfilePage', () => {
  afterEach(cleanup)

  it('names the page while it loads, and keeps that h1 once it has', () => {
    const { rerender } = render(show({ data: undefined, isError: false }))
    const h1 = screen.getByRole('heading', { level: 1, name: 'Profile' })
    expect(screen.getByRole('status').textContent).toBe('Loading…')

    // The same h1 node stays, so focus a move put on it stays too.
    rerender(show(LOADED, { data: { displayName: 'Ann' }, isError: false } as never))
    expect(screen.getByText('Profile form')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBe(h1)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('links your data’s export and deletion, and both legal pages (#566)', () => {
    render(show(LOADED, { data: { displayName: 'Ann' }, isError: false } as never))
    const links = within(screen.getByRole('region', { name: 'Your data' })).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Export your data', '/export'],
      ['Delete your account', '/account/delete'],
      ['Terms of use', '/terms'],
      ['Privacy policy', '/privacy'],
    ])
  })

  it.each([
    ['the profile', { data: undefined, isError: true }, undefined],
    ['the person', LOADED, { data: undefined, isError: true }],
  ])('names the page when %s can’t load', (_name, profile, person) => {
    render(show(profile, person))
    expect(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(
      'We couldn’t load your profile. Reload the page to try again.',
    )
    expect(screen.queryByText('Profile form')).toBeNull()
  })
})
