import { expect, type Page } from '@playwright/test'

/**
 * Fills in the open New employer form as user flow 2's step 1 does ($25/h, monthly invoices,
 * 14-day terms), with `billing` (a Resend test address) as its billing email, and saves it.
 * Returns the group's ID, from the settings page saving opens.
 */
export async function addEmployer(page: Page, name: string, billing: string): Promise<string> {
  await page.getByLabel('Employer name').fill(name)
  await page.getByLabel('Billing emails').fill(billing)
  await page.getByLabel('Default hourly rate (AUD)').fill('25')
  await page.getByLabel('Invoice cycle').selectOption({ label: 'Monthly' })
  await page.getByLabel('Payment terms (days)').fill('14')
  await page.getByRole('button', { name: 'Create employer', exact: true }).click()
  // The ID first, so a check that fails after saving still leaves something to archive.
  await page.waitForURL(/\/groups\/[^/]+\/settings$/)
  const groupId = /^\/groups\/([^/]+)\/settings$/.exec(new URL(page.url()).pathname)?.[1]
  if (!groupId) throw new Error('Saving the employer didn’t open its settings')
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
  return groupId
}

/**
 * Archives the employer, so a run leaves no group in dev that the statements job drafts an
 * invoice for every month (the lead's (b) on #38). Archiving stops its schedules too.
 */
export async function archiveEmployer(page: Page, groupId: string): Promise<void> {
  await page.goto(`/groups/${groupId}/settings`)
  await page.getByRole('button', { name: 'Archive group', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Archive group', exact: true })
    .click()
  await expect(page.getByText(/^This group is archived\./)).toBeVisible()
}
