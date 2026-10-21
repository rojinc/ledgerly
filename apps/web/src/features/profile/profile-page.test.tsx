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

describe('ProfilePage', () => {
  afterEach(cleanup)

  it('links your data’s export and deletion, and both legal pages (#566)', () => {
    vi.mocked(useProfile).mockReturnValue({
      data: { personId: 'p1' },
      isError: false,
    } as ReturnType<typeof useProfile>)
    vi.mocked(usePerson).mockReturnValue({
      data: { displayName: 'Ann' },
      isError: false,
    } as ReturnType<typeof usePerson>)
    render(
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>,
    )
    const links = within(screen.getByRole('region', { name: 'Your data' })).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Export your data', '/export'],
      ['Delete your account', '/account/delete'],
      ['Terms of use', '/terms'],
      ['Privacy policy', '/privacy'],
    ])
  })
})
