import { expect, type Page } from '@playwright/test'

/**
 * Archives a group from `path`, the page with its Archive group button: a house's or a pair's
 * page, or an employer's settings. So a run leaves no group in dev that the jobs keep working on
 * (the lead's (b) on #38): archiving stops its schedules, reminders and statements.
 */
export async function archiveGroup(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.getByRole('button', { name: 'Archive group', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Archive group', exact: true })
    .click()
  await expect(page.getByText(/^This group is archived\./)).toBeVisible()
}
