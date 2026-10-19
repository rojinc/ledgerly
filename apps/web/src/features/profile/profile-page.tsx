import { useCurrentUser } from '../auth/use-current-user'
import { BusinessForm } from './business-form'
import { HoursCapForm } from './hours-cap-form'
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
      <PasswordSection />
    </div>
  )
}
