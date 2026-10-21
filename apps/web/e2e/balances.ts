import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Waits for `expected`, a balance as the page words it. The balances query doesn't retry
 * (use-groups.ts), so one call that fails on a cold start after a deploy shows `unavailable`
 * instead: the page is reloaded once, with a warning in the run's output (#406).
 */
export async function expectBalanceShown(
  page: Page,
  expected: Locator,
  unavailable: Locator,
): Promise<void> {
  await expect(expected.or(unavailable)).toBeVisible()
  if (await unavailable.isVisible()) {
    // Printed by the list reporter, so a reload that happens on every run is seen on green runs
    // too. No personal data: the page's words only.
    console.warn('balances unavailable: reloaded once (#406)')
    await page.reload()
  }
  await expect(expected).toBeVisible()
}
