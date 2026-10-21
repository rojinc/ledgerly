import { randomBytes, randomUUID } from 'node:crypto'

/**
 * The dev project's REST API, with the dev-only E2E_APPWRITE_API_KEY (scopes `users.read` and
 * `users.write`): users for the flows, marked verified because tests can't open an inbox, and
 * handed to the `account` job to delete after the run. Everything else goes through the app, as a
 * user would.
 */
export const ENV_NAMES = [
  'VITE_APPWRITE_ENDPOINT',
  'VITE_APPWRITE_PROJECT_ID',
  'E2E_APPWRITE_API_KEY',
] as const

export type TestUser = { id: string; name: string; email: string; password: string }

export function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} isn't set (docs/engineering/testing.md#end-to-end)`)
  return value
}

/** This run's ID, from global setup: in every name and address the run makes. */
export function runId(): string {
  return env('E2E_RUN_ID')
}

/** A Resend test address, never a real inbox: unique to this run and `label`. */
export function testEmail(label: string): string {
  return `delivered+${runId()}-${label}@resend.dev`
}

/** A display name that carries the run ID, so dev rows show which run made them. */
export function testName(name: string): string {
  return `${name} ${runId()}`
}

async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const response = await fetch(`${env('VITE_APPWRITE_ENDPOINT')}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-appwrite-project': env('VITE_APPWRITE_PROJECT_ID'),
      'x-appwrite-key': env('E2E_APPWRITE_API_KEY'),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    // The route and Appwrite's error type only: no address ends up in a log.
    const { type } = (await response.json().catch(() => ({}))) as { type?: string }
    const message = `${method} ${path.split('?')[0]}: ${response.status} ${type ?? ''}`
    throw Object.assign(new Error(message), { status: response.status })
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

const query = (method: string, values: unknown[], attribute?: string) =>
  `queries[]=${encodeURIComponent(JSON.stringify({ method, values, ...(attribute ? { attribute } : {}) }))}`

/**
 * A verified user, made through the API: for the flows that start signed in. One made without a
 * password (`password` empty) never has `passwordUpdate` set, so `account` doesn't refuse it a
 * delete for 24 hours (identity-and-invites.md#refusals, #512); it signs in with `createToken`.
 */
export async function createUser(
  label: string,
  name: string,
  { password = true } = {},
): Promise<TestUser> {
  const user = {
    id: randomUUID(),
    name: testName(name),
    email: testEmail(label),
    password: password ? randomBytes(18).toString('base64url') : '',
  }
  await api('POST', '/users', {
    userId: user.id,
    email: user.email,
    ...(user.password ? { password: user.password } : {}),
    name: user.name,
  })
  await verifyEmail(user.id)
  return user
}

/** A one-off secret the user's browser exchanges for a session (`POST /account/sessions/token`). */
export async function createToken(userId: string): Promise<string> {
  const { secret } = await api<{ secret: string }>('POST', `/users/${userId}/tokens`, {})
  return secret
}

/** Marks a user's email verified, as the link in the email would. */
export async function verifyEmail(userId: string): Promise<void> {
  await api('PATCH', `/users/${userId}/verification`, { emailVerification: true })
}

/** The user with this address, such as one who signed up through the app. */
export async function userIdByEmail(email: string): Promise<string> {
  const { users } = await api<{ users: { $id: string }[] }>(
    'GET',
    `/users?${query('equal', [email], 'email')}`,
  )
  const [user] = users
  if (!user) throw new Error('No user has that address yet')
  return user.$id
}

/**
 * Where a user the run made stands at teardown: handed over (labelled `e2e` and blocked), gone (a
 * flow deleted its own account, #525), or still live, which teardown fails on.
 */
export async function userState(userId: string): Promise<'handed over' | 'gone' | 'live'> {
  try {
    const user = await api<{ labels: string[]; status: boolean }>('GET', `/users/${userId}`)
    return user.labels.includes(E2E_LABEL) && !user.status ? 'handed over' : 'live'
  } catch (error) {
    if ((error as { status?: number }).status === 404) return 'gone'
    throw error
  }
}

/** A run ID as global setup makes it: nothing else is ever used to pick users to hand over. */
export const RUN_ID = /^e2e[a-z0-9]{10,}$/

/** What the `account` job deletes a run's users by (identity-and-invites.md#finishing-purges). */
const E2E_LABEL = 'e2e'

/**
 * Hands every user the run made, through the API or the app (those whose address starts with its
 * mark), to the `account` job: labelled `e2e` and blocked, so the job deletes each one as an
 * account deletion does, with the rows and files they made (#386). The server does the filtering,
 * so no other user of dev is ever read, let alone changed. One it can't label and block it deletes
 * outright, as before. One failure doesn't stop the others; any failure is thrown at the end.
 */
export async function handOverRunUsers(id: string): Promise<void> {
  if (!RUN_ID.test(id)) throw new Error('Not a run ID: nothing handed over')
  const ours: { $id: string; email: string; labels: string[] }[] = []
  // All of them first, as when they were deleted here: a deleted user can't be a cursor.
  let cursor: string | undefined
  for (;;) {
    const page = [
      query('startsWith', [`delivered+${id}-`], 'email'),
      query('limit', [100]),
      ...(cursor ? [query('cursorAfter', [cursor])] : []),
    ].join('&')
    const { users } = await api<{ users: { $id: string; email: string; labels: string[] }[] }>(
      'GET',
      `/users?${page}`,
    )
    ours.push(...users)
    if (users.length < 100) break
    cursor = users.at(-1)?.$id
  }
  const failed: string[] = []
  for (const user of ours) {
    // Checked here too: only this run's addresses, whatever the server answered.
    if (!user.email.startsWith(`delivered+${id}-`)) continue
    try {
      const labels = [...new Set([...user.labels, E2E_LABEL])]
      await api('PUT', `/users/${user.$id}/labels`, { labels })
      await api('PATCH', `/users/${user.$id}/status`, { status: false })
    } catch (error) {
      // Not left to sign in with: deleted outright, though the rows it made stay in dev.
      failed.push((error as Error).message)
      await api('DELETE', `/users/${user.$id}`).catch((deleting: Error) =>
        failed.push(deleting.message),
      )
    }
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} failures handing users over: ${failed.join('; ')}`)
  }
}
