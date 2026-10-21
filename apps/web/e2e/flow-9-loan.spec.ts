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
  const pia = testName('Pia')
  // A label no setup user has, so this address belongs to nobody yet: a claim, not the pending
  // path (`sam` is flow 2's user).
  const email = testEmail('pia')
  await logIn(page, ivy)

  await test.step('a lend & borrow with Pia, by email', async () => {
    await page.goto('/people/new')
    await page.getByLabel('Name', { exact: true }).fill(pia)
    await page.getByLabel('Email (optional)', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForURL(/\/people\/(?!new$)[^/]+$/)
    groupId = new URL(page.url()).pathname.split('/').at(-1)
    await expect(page.getByRole('heading', { level: 1, name: pia })).toBeVisible()
    await expect(page.getByText('Not joined yet', { exact: true })).toBeVisible()
  })

  await test.step('lends Pia $50', async () => {
    // The entry form comes with the balance.
    await expectBalanceShown(page, balance(page, 'All square'), balance(page, 'Not available yet'))
    await page.getByRole('radio', { name: `I lent ${pia} money`, exact: true }).check()
    await page.getByLabel('Amount (AUD)').fill('50')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Added.', { exact: true })).toBeVisible()
    await expect(balance(page, `${pia} owes you $50.00`)).toBeVisible()
  })

  await test.step('Pia signs in, claims the pair, and sees the loan', async () => {
    // Made now, verified, with Ivy's address for them: their first sign-in claims it.
    const user = await createUser('pia', 'Pia')
    // Pia's own browser, on the same app, zone and locale as Ivy's.
    const { baseURL, timezoneId, locale } = test.info().project.use
    const context = await browser.newContext({ baseURL, timezoneId, locale })
    try {
      const piaPage = await context.newPage()
      await logIn(piaPage, user)
      await expect(
        piaPage.getByText('We found 1 group you were added to.', { exact: true }),
      ).toBeVisible()
      await piaPage.goto(`/people/${groupId}`)
      await expectBalanceShown(
        piaPage,
        balance(piaPage, `You owe ${ivy.name} $50.00`),
        balance(piaPage, 'Not available yet'),
      )
    } finally {
      await context.close()
    }
  })

  await test.step('Ivy sees that Pia joined', async () => {
    await page.reload()
    // Loaded first: "Not joined yet" is part of the details the balance comes with.
    await expectBalanceShown(
      page,
      balance(page, `${pia} owes you $50.00`),
      balance(page, 'Not available yet'),
    )
    await expect(page.getByText('Not joined yet', { exact: true })).toHaveCount(0)
  })
})
