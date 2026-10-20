import { expect, type Page } from '@playwright/test'

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
