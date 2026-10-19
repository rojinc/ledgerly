import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createUser, testEmail, testName, userIdByEmail, verifyEmail } from './dev-project'
import { logIn, setupUser } from './users'

// User flow 1 (docs/product/user-flows.md#1-first-login).

test('signs up, is verified, and lands on the dashboard with the guide', async ({ page }) => {
  const name = testName('Pat')
  const email = testEmail('signup')
  await page.goto('/signup')
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(randomBytes(18).toString('base64url'))
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${name}` })).toBeVisible()
  const banner = page.getByText(`Check ${email} for a link to verify your email.`)
  await expect(banner).toBeVisible()

  // The link in the email, which a test can't open.
  await verifyEmail(await userIdByEmail(email))
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${name}` })).toBeVisible()
  await expect(banner).toBeHidden()
  await expect(
    page.getByRole('heading', { name: 'What do you want to track first?' }),
  ).toBeVisible()
})

test('finds the group someone added them to by email', async ({ page }) => {
  // A adds B to a lend & borrow by email, before B has an account.
  const alex = setupUser('alex')
  await logIn(page, alex)
  await page.goto('/people/new')
  const bo = testName('Bo')
  await page.getByLabel('Name', { exact: true }).fill(bo)
  await page.getByLabel('Email (optional)').fill(testEmail('bo'))
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { level: 1, name: bo })).toBeVisible()

  // B's account is made and verified before B's first login, as an invite link would leave it.
  // Signing up in the app bootstraps B with an unverified email, and claiming after verifying
  // then needs a merge of the two persons (#39); see #38.
  const b = await createUser('bo', 'Bo')
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  await logIn(page, b)
  await expect(page.getByText('We found 1 group you were added to.')).toBeVisible()
})
