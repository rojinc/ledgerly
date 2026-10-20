import { expect, type Page } from '@playwright/test'
import type { TestUser } from './dev-project'

/** The users global setup made for this run. */
export function setupUser(key: 'alex' | 'sam'): TestUser {
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
