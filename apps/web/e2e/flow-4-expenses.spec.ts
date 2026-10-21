import { formatNet } from '@ledgerly/core/money/format'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { expectBalanceShown } from './balances'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer } from './employer'
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
})
