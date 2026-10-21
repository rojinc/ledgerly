import { localToday } from '@ledgerly/core/dates/time-zone'
import { expect, test } from '@playwright/test'
import { expectBalanceShown } from './balances'
import { testName } from './dev-project'
import { archiveGroup } from './groups'
import { addHouse, addHousemate } from './house'
import { waitOutFinalize } from './statements'
import { logIn, setupUser } from './users'

// User flow 8 (docs/product/user-flows.md#8-settle-up-and-the-monthly-divide): an expense, the
// suggested payment recorded, then the period closed and its divide finalized. The job drafts a
// month's divide only once the month is over, so the flow closes the period now (statements.md#6)
// and finalizes it without email ("Finalize only"). Finalizing locks the period's transactions.
const ZONE = 'Australia/Sydney'

// The house this test adds, archived after it even when it fails, its divide, and when Finalize
// was clicked.
let groupId: string | undefined
let statementId: string | undefined
let finalizedAt: number | undefined
test.afterEach(async ({ page }, testInfo) => {
  if (!groupId) return
  try {
    await waitOutFinalize(page, testInfo, statementId, finalizedAt)
  } finally {
    await archiveGroup(page, `/groups/${groupId}`)
  }
})

// The final divide never changes (D-010), but it doesn't stay in dev: Bob never joined, so when
// the `account` job deletes the run's users, Hal's deletion purges the house with its statements
// and PDF (identity-and-invites.md#purging-a-group).
test('settles up, then closes the period and finalizes its divide', async ({ page }) => {
  const hal = setupUser('hal')
  const bob = testName('Bob')
  await logIn(page, hal)
  // Today in the house's time zone, taken once and filled in wherever a date goes, as flow 5
  // does: a run across midnight then dates the move-in, the expense and the close alike.
  const today = localToday(ZONE, new Date())
  groupId = await addHouse(page, testName('Oak Lane'), 'Equally')
  await addHousemate(page, bob, today)

  const expenseId = await test.step('Hal pays $80, split equally', async () => {
    await page.goto(`/transactions/new?groupId=${groupId}`)
    await page.getByLabel('Amount (AUD)').fill('80')
    await page.getByLabel('Date', { exact: true }).fill(today)
    await page.getByLabel('Description', { exact: true }).fill('Cleaning')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Cleaning', exact: true }),
    ).toBeVisible()
    // Open for now: Edit is there, and nothing says it's locked.
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    await expect(page.getByText(/, so it can’t be changed\.$/)).toHaveCount(0)
    return new URL(page.url()).pathname.split('/').at(-1) as string
  })

  await test.step('records the suggested payment', async () => {
    await page.goto(`/groups/${groupId}`)
    const settle = page.getByRole('region', { name: 'Settle up', exact: true })
    await expectBalanceShown(
      page,
      settle.getByText(`${bob} owes $40.00`, { exact: true }),
      settle.getByText('We couldn’t load the balances.', { exact: true }),
    )
    // The viewer's own line names them "(you)".
    await expect(
      settle.getByText(`${hal.name} (you) is owed $40.00`, { exact: true }),
    ).toBeVisible()
    const transfer = settle.getByRole('listitem').filter({ hasText: `${bob} pays ${hal.name}` })
    await expect(transfer).toContainText('$40.00')
    await transfer.getByRole('button', { name: 'Record', exact: true }).click()
    await settle.getByRole('button', { name: 'Record payment', exact: true }).click()
    await expect(settle.getByText('Payment recorded.', { exact: true })).toBeVisible()
    await expect(settle.getByText('Everyone is square.', { exact: true })).toBeVisible()
  })

  statementId = await test.step('closes the period now', async (): Promise<string> => {
    await page.goto(`/groups/${groupId}/statements`)
    await page.getByRole('button', { name: 'Close period now…', exact: true }).click()
    // Up to today, the expense's date.
    await page.getByLabel('Last day').fill(today)
    await page.getByRole('button', { name: 'Close period', exact: true }).click()
    await page.waitForURL(new RegExp(`/groups/${groupId}/statements/[^/]+$`))
    await expect(page.getByText('Draft', { exact: true })).toBeVisible()
    return new URL(page.url()).pathname.split('/').at(-1) as string
  })

  await test.step('finalizes the divide without email', async () => {
    await page.getByRole('button', { name: 'Finalize…', exact: true }).click()
    await page.getByRole('button', { name: 'Finalize only', exact: true }).click()
    // After the click, which waits for the button: the finalize starts then.
    finalizedAt = Date.now()
    // Finalize is an async execution, which the app polls for up to about 320 s; a minute here.
    await expect(page.getByText('Final', { exact: true })).toBeVisible({ timeout: 60_000 })
  })

  await test.step('the expense is locked', async () => {
    await page.goto(`/transactions/${expenseId}`)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Cleaning', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText('It’s on a final divide, so it can’t be changed.', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  })
})
