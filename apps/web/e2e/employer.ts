import { expect, type Page } from '@playwright/test'
import { archiveGroup } from './groups'

/**
 * Fills in the open New employer form as user flow 2's step 1 does ($25/h, monthly invoices,
 * 14-day terms), with `billing` (a Resend test address) as its billing email, and saves it.
 * Returns the group's ID as soon as the settings page saving opens has it, so the caller can
 * archive it whatever comes next, as `addHouse` does: the caller checks the page (#556's W6).
 */
export async function addEmployer(page: Page, name: string, billing: string): Promise<string> {
  await page.getByLabel('Employer name').fill(name)
  await page.getByLabel('Billing emails', { exact: true }).fill(billing)
  await page.getByLabel('Default hourly rate (AUD)').fill('25')
  await page.getByLabel('Invoice cycle').selectOption({ label: 'Monthly' })
  await page.getByLabel('Payment terms (days)').fill('14')
  await page.getByRole('button', { name: 'Create employer', exact: true }).click()
  await page.waitForURL(/\/groups\/[^/]+\/settings$/)
  const groupId = /^\/groups\/([^/]+)\/settings$/.exec(new URL(page.url()).pathname)?.[1]
  if (!groupId) throw new Error('Saving the employer didn’t open its settings')
  return groupId
}

/** The settings page saving opened, under the employer's name. */
export async function expectEmployerSettings(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
}

/**
 * Archives the employer, so a run leaves no group in dev that the statements job drafts an
 * invoice for every month (the lead's (b) on #38). Archiving stops its schedules too.
 */
export async function archiveEmployer(page: Page, groupId: string): Promise<void> {
  await archiveGroup(page, `/groups/${groupId}/settings`)
}
