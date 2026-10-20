import { Link } from 'react-router'
import { useCurrentUser } from '../auth/use-current-user'
import { BusinessForm } from './business-form'
import { EmailSection } from './email-section'
import { EmailSettingsForm } from './email-settings-form'
import { HoursCapForm } from './hours-cap-form'
import { OtherDevicesSection } from './other-devices-section'
import { PasswordSection } from './password-section'
import { ProfileForm } from './profile-form'
import { usePerson, useProfile, useUpdateProfile } from './use-profile'

export function ProfilePage() {
  // RequireAuth renders this page only for a signed-in, bootstrapped user.
  const userId = useCurrentUser().data?.$id ?? ''
  const profile = useProfile(userId)
  const personId = profile.data?.personId ?? ''
  const person = usePerson(personId)
  const update = useUpdateProfile(userId, personId)

  if (profile.isError || person.isError) {
    return (
      <p role="alert" className="text-destructive">
        We couldn’t load your profile. Reload the page to try again.
      </p>
    )
  }
  if (!profile.data || !person.data) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading…
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-2xl font-semibold">Profile</h1>
      <ProfileForm
        profile={profile.data}
        displayName={person.data.displayName}
        onSave={update.mutateAsync}
      />
      <BusinessForm profile={profile.data} onSave={update.mutateAsync} />
      <HoursCapForm profile={profile.data} onSave={update.mutateAsync} />
      <EmailSettingsForm profile={profile.data} onSave={update.mutateAsync} />
      <EmailSection />
      <PasswordSection />
      <OtherDevicesSection />
      <section aria-labelledby="your-data-heading" className="flex flex-col gap-2">
        <h2 id="your-data-heading" className="text-lg font-semibold">
          Your data
        </h2>
        <Link to="/export" className="self-start text-sm underline underline-offset-4">
          Export your data
        </Link>
        <Link to="/account/delete" className="self-start text-sm underline underline-offset-4">
          Delete your account
        </Link>
      </section>
    </div>
  )
}
