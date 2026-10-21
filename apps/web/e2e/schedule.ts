import { type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { expect, type Page } from '@playwright/test'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * A weekly 5-hour shift at the employer's rate, on `startsOn`'s weekday, through `lastDate`, with
 * no public holidays skipped, so every week has one. `skip` goes in the form's Skipped dates.
 */
export async function addWeeklyShift(
  page: Page,
  groupId: string,
  startsOn: LocalDate,
  lastDate: LocalDate,
  skip: LocalDate[] = [],
): Promise<void> {
  await page.goto(`/schedules/new?groupId=${groupId}`)
  await page.getByLabel('Paid hours per shift').fill('5')
  await page.getByLabel(WEEKDAYS[weekdayOf(startsOn) - 1] ?? '', { exact: true }).check()
  await page.getByLabel('Starts on').fill(startsOn)
  await page.getByLabel('On a date').check()
  await page.getByLabel('Last date').fill(lastDate)
  for (const day of skip) {
    await page.getByLabel('Date to skip').fill(day)
    await page.getByRole('button', { name: 'Skip this date', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click()
  await expect(page.getByText(/^Every /)).toBeVisible()
}
