import { expect, type Page, test } from '@playwright/test'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer, expectEmployerSettings } from './employer'
import { logIn, logInWithToken, setupUser } from './users'

// Deleting an archived group (#429, identity-and-invites.md#deleting-a-group), the first of
// #512's flows: it purges data. A run's users are made today, so one with a password is refused
// for 24 hours, and only a user made without one gets through (#512).

// The employer each test adds: archived after it, even when it fails, unless it was deleted.
let groupId: string | undefined
let archived = false
test.beforeEach(() => {
  groupId = undefined
  archived = false
})
test.afterEach(async ({ page }) => {
  if (groupId && !archived) await archiveEmployer(page, groupId)
})

/** Adds `who`'s employer, archives it, and opens Delete group from its settings. */
async function archivedEmployer(page: Page, who: 'ann' | 'bea'): Promise<string> {
  const name = `Co of ${who} ${runId()}`
  await page.goto('/groups/new-employer')
  groupId = await addEmployer(page, name, testEmail(`${who}-billing`))
  await expectEmployerSettings(page, name)
  await archiveEmployer(page, groupId)
  archived = true
  // Its admin, with nobody else joined, gets Delete group beside Unarchive.
  await page.getByRole('link', { name: 'Delete group', exact: true }).click()
  await page.waitForURL(`/groups/${groupId}/delete`)
  await expect(page.getByRole('heading', { level: 1, name: `Delete ${name}` })).toBeVisible()
  return name
}

test('refuses a delete for 24 hours after a password is set, and keeps the group', async ({
  page,
}) => {
  await logIn(page, setupUser('ann'))
  await archivedEmployer(page, 'ann')
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByRole('button', { name: 'Delete group', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('changed in the last 24 hours')
  // Still here: the delete never started.
  await expect(page).toHaveURL(`/groups/${groupId}/delete`)
  // Its admin unarchives it instead (F-15, #428), behind a confirmation. afterEach archives it
  // again.
  await page.goto(`/groups/${groupId}/settings`)
  await page.getByRole('button', { name: 'Unarchive group', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Unarchive group', exact: true })
    .click()
  // From the click on, afterEach archives it, even if a check below fails (#570's W40).
  archived = false
  await expect(
    page.getByText('This group is unarchived, so it can be changed again.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/^This group is archived\./)).toHaveCount(0)
  // Stored, not just shown: after a reload it can be archived again.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Archive group', exact: true })).toBeVisible()
})

test('deletes an archived group once DELETE is typed, after a link to Export', async ({ page }) => {
  await logInWithToken(page, setupUser('bea'))
  const name = await archivedEmployer(page, 'bea')
  // It preselects this group, so its whole history can be saved first (#542).
  await expect(page.getByRole('link', { name: 'export its records' })).toHaveAttribute(
    'href',
    `/export?groupId=${groupId}`,
  )
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByRole('button', { name: 'Delete group', exact: true }).click()
  await page.waitForURL('/groups')
  // Nothing left to archive.
  groupId = undefined
  await expect(page.getByText(`Deleted ${name}.`)).toBeVisible()
  await expect(page.getByRole('link', { name })).toHaveCount(0)
})
