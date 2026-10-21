import { readFile } from 'node:fs/promises'
import { addDays, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { expect, test } from '@playwright/test'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer } from './employer'
import { waitOutFinalize } from './statements'
import { logIn, setupUser } from './users'

// User flow 5 (docs/product/user-flows.md#5-month-end-invoice). The statements job drafts a
// month's invoice once the month is over, which a test can't wait for. So the entries go in last
// month, and `statements POST /statements/reissue` drafts that month (statements.md#4-void).
const ZONE = 'Australia/Sydney'

// The employer this test adds, archived after it even when it fails, its invoice, and when
// Finalize was clicked.
let groupId: string | undefined
let statementId: string | undefined
let finalizedAt: number | undefined
test.afterEach(async ({ page }, testInfo) => {
  if (!groupId) return
  try {
    await waitOutFinalize(page, testInfo, statementId, finalizedAt)
  } finally {
    await archiveEmployer(page, groupId)
  }
})

// Its final invoice never changes (D-010), but it doesn't stay in dev, which is production: the
// employer never joined, so when the `account` job deletes the run's users, Max's deletion
// purges the group with its statements and PDFs (#386, identity-and-invites.md#purging-a-group).
test('invoices last month: the draft, finalize and send, its number and PDF', async ({ page }) => {
  await logIn(page, setupUser('max'))
  // Last month, in the group's time zone, worked out before the group is made: after it, across
  // midnight at a month's end, it would be the group's first month, which reissue refuses (#406).
  const periodEnd = addDays(`${localToday(ZONE, new Date()).slice(0, 7)}-01` as LocalDate, -1)
  const month = periodEnd.slice(0, 7)
  const periodStart = `${month}-01` as LocalDate
  const employer = `Nimbus ${runId()}`
  const billing = testEmail('nimbus-billing')
  await page.goto('/groups/new-employer')
  groupId = await addEmployer(page, employer, billing)

  await test.step('back-dated into last month: a shift and an expense', async () => {
    await page.goto(`/shifts/new?groupId=${groupId}&date=${month}-15`)
    await page.getByLabel('Hours', { exact: true }).check()
    await page.getByLabel('Hours worked').fill('5')
    await expect(page.getByText('5 h 0 min paid · $125.00', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add shift', exact: true }).click()
    await expect(page.getByText('Confirmed.', { exact: true })).toBeVisible()
    await page.goto(`/transactions/new?groupId=${groupId}`)
    await page.getByRole('radio', { name: /^I paid for them/ }).check()
    await page.getByLabel('Amount (AUD)').fill('40')
    await page.getByLabel('Date', { exact: true }).fill(`${month}-20`)
    await page.getByLabel('Description', { exact: true }).fill('Cleaning supplies')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Cleaning supplies', exact: true }),
    ).toBeVisible()
  })

  statementId = await test.step('reissue drafts last month', async (): Promise<string> => {
    // Through the app's own function client, as the signed-in user, never with the API key: the
    // dev server serves the app's modules, so this is the instance the app itself calls with.
    const result = await page.evaluate(
      async ({ path, body }) => {
        const { callFunction } = await import(path)
        return callFunction('statements', 'POST', '/statements/reissue', body)
      },
      { path: '/src/lib/api.ts', body: { groupId, periodStart, periodEnd } },
    )
    expect(result).toMatchObject({ ok: true, data: { status: 'draft', periodStart, periodEnd } })
    return result.data.$id
  })

  await test.step('opens the draft', async () => {
    await page.goto(`/groups/${groupId}/statements`)
    await page.getByRole('link', { name: /^Draft invoice/ }).click()
    await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/statements/${statementId}$`))
    const draft = page.getByRole('article', { name: 'Draft invoice', exact: true })
    await expect(draft.getByRole('row', { name: /Shift/ })).toContainText('5 h at $25.00/h')
    await expect(draft.getByRole('row', { name: /Cleaning supplies/ })).toContainText('$40.00')
    await expect(draft.locator('p', { hasText: 'Balance due' })).toHaveText(
      /^Balance due\s*\$165\.00$/,
    )
  })

  await test.step('finalizes and sends it', async () => {
    await page.getByRole('button', { name: 'Finalize…', exact: true }).click()
    await expect(page.getByText(`Sending emails it to ${billing}.`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Finalize and send', exact: true }).click()
    // After the click, which waits for the button: the finalize starts then.
    finalizedAt = Date.now()
    // Finalize is an async execution, which the app polls until it ends: a minute at most.
    await expect(page.getByText(/^Final · Sent /)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Finalized as INV-0001 and sent.', { exact: true })).toBeVisible()
  })

  await test.step('shows its number and its PDF', async () => {
    // The worker's first invoice.
    await expect(
      page.getByRole('heading', { level: 1, name: 'INV-0001', exact: true }),
    ).toBeVisible()
    const invoice = page.getByRole('article', { name: 'Invoice INV-0001', exact: true })
    await expect(invoice.getByText('INV-0001', { exact: true })).toBeVisible()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click()
    const pdf = await download
    expect(pdf.suggestedFilename()).toBe('INV-0001.pdf')
    expect((await readFile(await pdf.path())).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
