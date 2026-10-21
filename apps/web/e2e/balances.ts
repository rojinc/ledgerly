import { expect, type Locator, type Page, test } from '@playwright/test'

/**
 * Waits for `expected`, a balance as the page words it. The balances query doesn't retry
 * (use-groups.ts), so one call that fails on a cold start after a deploy shows `unavailable`
 * instead: the page is reloaded once, and that's noted in the report (#406).
 */
export async function expectBalanceShown(
  page: Page,
  expected: Locator,
  unavailable: Locator,
): Promise<void> {
  await expect(expected.or(unavailable)).toBeVisible()
  if (await unavailable.isVisible()) {
    // In the report, so a reload that keeps happening is seen.
    test.info().annotations.push({ type: 'reloaded', description: 'balances unavailable' })
    await page.reload()
  }
  await expect(expected).toBeVisible()
}
