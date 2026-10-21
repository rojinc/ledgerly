import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Adds a house from New house, splitting bills `split` by default, and returns its ID as soon as
 * the house page saving opens has it, so the caller can archive it whatever comes next. Its time
 * zone, region and currency are the profile's.
 */
export async function addHouse(
  page: Page,
  name: string,
  split: 'By days each person lived here' | 'Equally',
): Promise<string> {
  await page.goto('/groups/new-house')
  await page.getByLabel('House name').fill(name)
  await page.getByLabel('Split bills').selectOption({ label: split })
  await page.getByRole('button', { name: 'Create house', exact: true }).click()
  await page.waitForURL((url) => /^\/groups\/(?!new-house$)[^/]+$/.test(url.pathname))
  const groupId = /^\/groups\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
  if (!groupId) throw new Error('Saving the house didn’t open its page')
  return groupId
}

/**
 * Adds a housemate who hasn't joined (a placeholder: a name only) on the open house page, moved
 * in on `movedIn`, or today in the house's time zone, as the form starts.
 */
export async function addHousemate(page: Page, name: string, movedIn?: string): Promise<void> {
  const form = page.getByRole('region', { name: 'Add a housemate', exact: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  if (movedIn) await form.getByLabel('Moved in').fill(movedIn)
  await form.getByRole('button', { name: 'Add housemate', exact: true }).click()
  await expect(form.getByText(`Added ${name}.`, { exact: true })).toBeVisible()
}

/** Changes the signed-in user's own "Moved in" on the open house page, as its admin. */
export async function changeMyMoveIn(page: Page, movedIn: string): Promise<void> {
  const row = page
    .getByRole('region', { name: 'Housemates', exact: true })
    .getByRole('listitem')
    .filter({ hasText: '(you)' })
  await row.getByRole('button', { name: 'Change', exact: true }).click()
  await row.getByLabel('Moved in').fill(movedIn)
  await row.getByRole('button', { name: 'Save', exact: true }).click()
  // Saved: the form closes. The bill's days present, later, show the stored date was used.
  await expect(row.getByRole('button', { name: 'Change', exact: true })).toBeVisible()
}

/** The list in `region` has exactly these lines, in any order: the page sorts names its way. */
export async function expectLines(region: Locator, lines: string[]): Promise<void> {
  await expect(region.getByRole('listitem')).toHaveCount(lines.length)
  for (const line of lines) {
    await expect(region.getByRole('listitem').filter({ hasText: line })).toHaveText(line)
  }
}
