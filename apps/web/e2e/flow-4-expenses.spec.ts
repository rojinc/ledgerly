import { readFile } from 'node:fs/promises'
import { formatNet } from '@ledgerly/core/money/format'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { expectBalanceShown } from './balances'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer, expectEmployerSettings } from './employer'
import { logIn, setupUser } from './users'

// User flow 4 (docs/product/user-flows.md#4-employer-expenses-and-payments), in a group with
// nothing else in it: each expense preset, then a payment received. After each, the balance
// card shows the worker's balance to the cent (ledger.md#employer-presets).
const STEPS = [
  // They owe you $40 more.
  { choice: /^I paid for them/, amount: '40', description: 'Cleaning supplies', netCents: 4000 },
  // No change; it's listed on the invoice.
  { choice: /^Bought on their card/, amount: '120', description: 'Work boots', netCents: 4000 },
  // They owe you $12.35 less.
  { choice: /^Personal, on their card/, amount: '12.35', description: 'Lunch', netCents: 2765 },
  // They owe you $500 less: with no shifts here, the worker now owes them.
  { choice: /^Payment received/, amount: '500', description: 'October pay', netCents: -47235 },
]

/** The balance card's words for the worker's balance (history-page.tsx). */
function balanceText(netCents: number, employer: string): string {
  const amount = formatNet(Math.abs(netCents), 'AUD', 'en-AU')
  if (netCents > 0) return `${employer} owes you ${amount}`
  if (netCents < 0) return `You owe ${employer} ${amount}`
  return 'All square'
}

const UNAVAILABLE = 'Balance not available right now.'

/** Waits for the balance card to read `text`, reloading once after a cold start (#406). */
async function expectBalance(page: Page, card: Locator, text: string): Promise<void> {
  await expectBalanceShown(
    page,
    card.getByText(text, { exact: true }),
    card.getByText(UNAVAILABLE, { exact: true }),
  )
}

// The employer this test adds, archived after it even when it fails.
let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveEmployer(page, groupId)
})

test('records each expense preset and a payment, with the balance after each', async ({ page }) => {
  await logIn(page, setupUser('lee'))
  const employer = `Lumen ${runId()}`
  await page.goto('/groups/new-employer')
  groupId = await addEmployer(page, employer, testEmail('lumen-billing'))
  await expectEmployerSettings(page, employer)
  const card = page.getByRole('region', { name: `Balance with ${employer}`, exact: true })
  await page.goto(`/transactions?groupId=${groupId}`)
  await expectBalance(page, card, balanceText(0, employer))

  for (const step of STEPS) {
    await test.step(step.description, async () => {
      await page.goto(`/transactions/new?groupId=${groupId}`)
      await page.getByRole('radio', { name: step.choice }).check()
      await page.getByLabel('Amount (AUD)').fill(step.amount)
      await page.getByLabel('Description', { exact: true }).fill(step.description)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      // Saved: the new entry's own page.
      await expect(
        page.getByRole('heading', { level: 1, name: step.description, exact: true }),
      ).toBeVisible()
      await page.goto(`/transactions?groupId=${groupId}`)
      await expectBalance(page, card, balanceText(step.netCents, employer))
    })
  }

  // History's filters (F-71, #424): by kind, by a search of descriptions, then every group's rows.
  await test.step('filters History', async () => {
    const list = page.getByRole('region', { name: 'Transactions', exact: true })
    const rows = list.getByRole('link')
    await page.getByLabel('Kind', { exact: true }).selectOption({ label: 'Payment' })
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('October pay')
    await page.getByLabel('Kind', { exact: true }).selectOption({ label: 'All' })
    // Each filter builds on the one before as rendered, so the next waits for this one's rows.
    await expect(rows).toHaveCount(STEPS.length)
    await page.getByLabel('Search descriptions').fill('boots')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Work boots')
    await page.getByLabel('Group', { exact: true }).selectOption({ label: 'All groups' })
    // Across groups, each row names its group.
    await expect(rows.filter({ hasText: 'Work boots' })).toContainText(employer)
  })

  // The group's CSV (F-72), from Export, which opens on this group and its whole history.
  await test.step('exports the group as CSV', async () => {
    await page.goto(`/export?groupId=${groupId}`)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download CSV', exact: true }).click()
    const csv = await readFile(await (await download).path(), 'utf8')
    for (const step of STEPS) expect(csv).toContain(step.description)
  })

  // The payment received is this month's income on Home, from employers (F-54).
  await test.step('counts the payment as income', async () => {
    await page.goto('/')
    const month = page.getByRole('region', { name: 'AUD', exact: true })
    const income = formatNet(50000, 'AUD', 'en-AU')
    await expect(month.locator('dt', { hasText: /^Income$/ }).locator('+ dd')).toHaveText(income)
    await expect(month.locator('dt', { hasText: 'From employers' }).locator('+ dd')).toHaveText(
      income,
    )
  })
})
