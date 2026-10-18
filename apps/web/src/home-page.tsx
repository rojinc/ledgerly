import { useCurrentUser } from './features/auth/use-current-user'

export function HomePage() {
  const { data: user } = useCurrentUser()
  return (
    <>
      <h1 className="text-2xl font-semibold">Hi{user?.name ? `, ${user.name}` : ''}</h1>
      <p className="mt-2 text-muted-foreground">Your groups will show up here.</p>
    </>
  )
}
