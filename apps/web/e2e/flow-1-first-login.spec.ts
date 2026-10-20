import { randomBytes } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { testEmail, testName, userIdByEmail, verifyEmail } from './dev-project'
import { logIn, setupUser } from './users'

// User flow 1 (docs/product/user-flows.md#1-first-login).

/** Signs up in the app, which signs them in, unverified, on the dashboard. */
async function signUp(page: Page, name: string, email: string) {
  await page.goto('/signup')
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(randomBytes(18).toString('base64url'))
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${name}` })).toBeVisible()
  await expect(page.getByText(`Check ${email} for a link to verify your email.`)).toBeVisible()
}

/**
 * The link in the email, which a test can't open: verified through the API. The reload
 * bootstraps again, which claims with the verified address.
 */
async function verify(page: Page, name: string, email: string) {
  await verifyEmail(await userIdByEmail(email))
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${name}` })).toBeVisible()
  await expect(page.getByText(`Check ${email} for a link to verify your email.`)).toBeHidden()
}

test('signs up, is verified, and lands on the dashboard with the guide', async ({ page }) => {
  const name = testName('Pat')
  const email = testEmail('signup')
  await signUp(page, name, email)
  await verify(page, name, email)
  await expect(
    page.getByRole('heading', { name: 'What do you want to track first?' }),
  ).toBeVisible()
})

test('finds the group someone added them to by email', async ({ page }) => {
  // A adds B to a lend & borrow by email, before B has an account.
  await logIn(page, setupUser('alex'))
  await page.goto('/people/new')
  const bo = testName('Bo')
  const email = testEmail('bo')
  await page.getByLabel('Name', { exact: true }).fill(bo)
  await page.getByLabel('Email (optional)', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: bo })).toBeVisible()
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible()

  // B signs up in the app. Unverified, B gets a person of their own and nothing is claimed; once
  // verified, A's placeholder is merged into it (#39) and B joins A's group.
  const notice = page.getByText(/^We found \d+ groups? you were added to\.$/)
  await signUp(page, bo, email)
  await expect(notice).toBeHidden()
  await verify(page, bo, email)
  await expect(notice).toHaveText('We found 1 group you were added to.')
})
