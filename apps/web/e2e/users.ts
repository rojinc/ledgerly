import { expect, type Page } from '@playwright/test'
import { createToken, env, type TestUser } from './dev-project'

/** The users global setup made for this run. */
export function setupUser(
  key:
    | 'alex'
    | 'sam'
    | 'kim'
    | 'lee'
    | 'max'
    | 'ann'
    | 'bea'
    | 'cal'
    | 'dee'
    | 'eve'
    | 'fay'
    | 'gil'
    | 'ida'
    | 'gus'
    | 'hal'
    | 'ivy'
    | 'jon',
): TestUser {
  const users = JSON.parse(process.env.E2E_USERS ?? '{}') as Record<string, TestUser>
  const user = users[key]
  if (!user) throw new Error(`Global setup made no user "${key}"`)
  return user
}

/** Logs in through the app with a password, and waits for the dashboard. */
export async function logIn(page: Page, user: TestUser) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${user.name}` })).toBeVisible()
}

/**
 * Signs in a user made without a password: an API token, exchanged for a session by the browser
 * itself, as the app's email code is. Then waits for the dashboard.
 */
export async function logInWithToken(page: Page, user: TestUser) {
  const secret = await createToken(user.id)
  // The app's origin, so Appwrite lets the browser call it.
  await page.goto('/login')
  await page.evaluate(
    async ({ endpoint, project, userId, secret }) => {
      const response = await fetch(`${endpoint}/account/sessions/token`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-appwrite-project': project },
        body: JSON.stringify({ userId, secret }),
      })
      if (!response.ok) throw new Error(`Signing in with a token: ${response.status}`)
      // Kept as the SDK keeps it when the browser won't take Appwrite's cookie.
      const fallback = response.headers.get('X-Fallback-Cookies')
      if (fallback) window.localStorage.setItem('cookieFallback', fallback)
    },
    {
      endpoint: env('VITE_APPWRITE_ENDPOINT'),
      project: env('VITE_APPWRITE_PROJECT_ID'),
      userId: user.id,
      secret,
    },
  )
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${user.name}` })).toBeVisible()
}
