import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { expect, type Page } from '@playwright/test'

/**
 * A calendar day's button, named by its date ("Thursday 22 October, 1 item"). The date is
 * worded in the browser, as the calendar words it.
 */
export async function dayButton(page: Page, day: LocalDate) {
  const label = await page.evaluate((date) => {
    const [year, month, dayOfMonth] = date.split('-').map(Number) as [number, number, number]
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(Date.UTC(year, month - 1, dayOfMonth))
  }, day)
  return page.getByRole('button', { name: new RegExp(`^${label}, \\d+ items?$`) })
}

/** Checks each day's planned (dashed) shift on the calendar: one where `planned` says so, else none. */
export async function expectPlannedShifts(page: Page, planned: Map<LocalDate, boolean>) {
  const days = [...planned.keys()].toSorted()
  for (const month of new Set(days.map((day) => day.slice(0, 7)))) {
    await page.goto(`/calendar?month=${month}`)
    for (const day of days.filter((date) => date.startsWith(month))) {
      const button = await dayButton(page, day)
      // The grid renders once the month's shifts are read: a count of 0 means nothing before.
      await expect(button, day).toBeVisible()
      await expect(button.locator('.border-dashed', { hasText: 'Shift' }), day).toHaveCount(
        planned.get(day) ? 1 : 0,
      )
    }
  }
}
