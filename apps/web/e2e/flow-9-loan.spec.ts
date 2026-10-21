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

  // Getting started (F-07): with a group but nothing in it, Home asks for a first entry.
  const firstEntry = page.getByRole('heading', { name: 'Record your first entry', exact: true })
  await test.step('Home asks for a first entry', async () => {
    await page.goto('/')
    await expect(firstEntry).toBeVisible()
    await page.goto(`/people/${groupId}`)
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

  await test.step('Home asks no more, once something is recorded', async () => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(firstEntry).toHaveCount(0)
    await page.goto(`/people/${groupId}`)
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

  // A part repayment (F-61): the balance goes down by it.
  await test.step('Pia pays back $20', async () => {
    await page.getByRole('radio', { name: 'Money was paid back', exact: true }).check()
    await page.getByLabel('Who paid back?').selectOption({ label: `${pia} paid me` })
    await page.getByLabel('Amount (AUD)').fill('20')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Added.', { exact: true })).toBeVisible()
    await expect(balance(page, `${pia} owes you $30.00`)).toBeVisible()
  })

  // Send a reminder (F-63), to the address Ivy added Pia with: one the group has for them. The
  // app says it went. No spec reads an inbox.
  await test.step('reminds Pia', async () => {
    await page.getByRole('button', { name: 'Send a reminder', exact: true }).click()
    await page.getByLabel('Their email address').fill(email)
    // The function's own answer, so a send the server never took fails here, not just the words.
    const answered = page.waitForResponse(
      (response) =>
        response.url().includes('/executions') &&
        (response.request().postData() ?? '').includes('/reminders'),
    )
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const execution = await (await answered).json()
    expect(JSON.parse(execution.responseBody)).toMatchObject({ ok: true })
    await expect(page.getByText('Reminder sent.', { exact: true })).toBeVisible()
  })

  // Each group keeps its own name for a person (F-11): Ivy renames Pia in the pair's Settings.
  await test.step('renames Pia here', async () => {
    const renamed = `${pia} R`
    const settings = page.getByRole('region', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Change their name', exact: true }).click()
    await settings.getByLabel('Their name').fill(renamed)
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible()
  })
})
