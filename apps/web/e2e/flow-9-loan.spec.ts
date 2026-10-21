import { expect, type Page, test } from '@playwright/test'
import { expectBalanceShown } from './balances'
import { createUser, testEmail, testName } from './dev-project'
import { archiveGroup } from './groups'
import { logIn, setupUser } from './users'

// User flow 9 (docs/product/user-flows.md#9-lend-to-a-friend): a loan to someone who isn't
// registered, then their claim. The doc adds them by mobile; this adds them by email, since the
// app has no phone sign-up yet (#40), a phone identity on a run user would stop the e2e pass from
// deleting it, and a typed number could reach a real person (#526's Q1). The pending path, for
// someone who already had an account, isn't covered here: identity's tests cover it.

/** The pair page's balance, when it reads `text`. */
const balance = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Balance', exact: true }).getByText(text, { exact: true })

// The pair this test adds, archived after it even when it fails.
let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveGroup(page, `/people/${groupId}`)
})

test('lends $50 to someone not registered, who then signs in and sees it', async ({
  page,
  browser,
}) => {
  const ivy = setupUser('ivy')
  const pat = testName('Pat')
  // A label no setup user has, so this address belongs to nobody yet: a claim, not the pending
  // path (`sam` is flow 2's user).
  const email = testEmail('pat')
  await logIn(page, ivy)

  await test.step('a lend & borrow with Pat, by email', async () => {
    await page.goto('/people/new')
    await page.getByLabel('Name', { exact: true }).fill(pat)
    await page.getByLabel('Email (optional)', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForURL(/\/people\/(?!new$)[^/]+$/)
    groupId = new URL(page.url()).pathname.split('/').at(-1)
    await expect(page.getByRole('heading', { level: 1, name: pat })).toBeVisible()
    await expect(page.getByText('Not joined yet', { exact: true })).toBeVisible()
  })

  await test.step('lends Pat $50', async () => {
    // The entry form comes with the balance.
    await expectBalanceShown(page, balance(page, 'All square'), balance(page, 'Not available yet'))
    await page.getByRole('radio', { name: `I lent ${pat} money`, exact: true }).check()
    await page.getByLabel('Amount (AUD)').fill('50')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Added.', { exact: true })).toBeVisible()
    await expect(balance(page, `${pat} owes you $50.00`)).toBeVisible()
  })

  await test.step('Pat signs in, claims the pair, and sees the loan', async () => {
    // Made now, verified, with Ivy's address for them: their first sign-in claims it.
    const user = await createUser('pat', 'Pat')
    // Pat's own browser, on the same app, zone and locale as Ivy's.
    const { baseURL, timezoneId, locale } = test.info().project.use
    const context = await browser.newContext({ baseURL, timezoneId, locale })
    try {
      const patPage = await context.newPage()
      await logIn(patPage, user)
      await expect(
        patPage.getByText('We found 1 group you were added to.', { exact: true }),
      ).toBeVisible()
      await patPage.goto(`/people/${groupId}`)
      await expectBalanceShown(
        patPage,
        balance(patPage, `You owe ${ivy.name} $50.00`),
        balance(patPage, 'Not available yet'),
      )
    } finally {
      await context.close()
    }
  })

  await test.step('Ivy sees that Pat joined', async () => {
    await page.reload()
    // Loaded first: "Not joined yet" is part of the details the balance comes with.
    await expect(balance(page, `${pat} owes you $50.00`)).toBeVisible()
    await expect(page.getByText('Not joined yet', { exact: true })).toHaveCount(0)
  })
})
