import { addDays, daysBetween, type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { expect, type Page, test } from '@playwright/test'
import { logIn, setupUser } from './users'

// User flow 10 (docs/product/user-flows.md#10-personal-rent): weekly rent in the personal group,
// one week marked paid, then a pause and a resume from the bills page. The reminder two days
// before each bill comes from the hourly scheduler, which a test can't wait for: its own tests
// cover it (functions/scheduler/test/bills.test.ts).
const ZONE = 'Australia/Sydney'

/** `26 Oct 2026`, worded in the browser, as the bills pages word a date. */
function dateText(page: Page, date: LocalDate): Promise<string> {
  return page.evaluate((date) => {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number]
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(Date.UTC(year, month - 1, day))
  }, date)
}

/** The recurring rent's row on the bills page. */
const rentRow = (page: Page) =>
  page
    .getByRole('region', { name: 'Recurring', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Rent' })

// Whether this test added the rent, stopped after it even when it fails: a personal group can't
// be archived, so a stop is what ends its bills before the run's users are deleted.
let added = false
test.afterEach(async ({ page }) => {
  if (!added) return
  await page.goto('/bills')
  await page.getByRole('button', { name: 'Stop Rent', exact: true }).click()
  await page.getByRole('button', { name: /^(Stop|Remove) it$/ }).click()
  // Stopped: its end date is set, so Stop goes. One not started yet, with its first bill paid
  // early, ends on its first due date, so it reads "Last due …" rather than "Ended" until then.
  await expect(page.getByText(/^(Stopped|Removed) Rent\./)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop Rent', exact: true })).toHaveCount(0)
})

test('adds weekly rent, pays a week, then pauses and resumes it', async ({ page }) => {
  await logIn(page, setupUser('jon'))
  const today = localToday(ZONE, new Date())
  // The first rent due: a Monday at least 3 days away, so no reminder is due during the flow
  // (the scheduler's reminder goes 2 days before, scheduling.md#step-3-reminders).
  const nextMonday = addDays(today, 8 - weekdayOf(today))
  const firstDue = daysBetween(today, nextMonday) < 3 ? addDays(nextMonday, 7) : nextMonday

  await test.step('$400 rent every Monday', async () => {
    await page.goto('/bills')
    await page.getByRole('link', { name: 'New recurring bill', exact: true }).click()
    await page.getByLabel('Description', { exact: true }).fill('Rent')
    await page.getByLabel('Category').selectOption({ label: 'Rent' })
    await page.getByLabel('Amount (AUD)').fill('400')
    await page.getByRole('radio', { name: 'Every week', exact: true }).check()
    await page.getByLabel('Day of the week').selectOption({ label: 'Monday' })
    await page.getByLabel('First due date').fill(firstDue)
    await page.getByRole('button', { name: 'Add recurring bill', exact: true }).click()
    added = true
    await page.waitForURL(/\/bills$/)
    await expect(rentRow(page)).toContainText('$400.00')
  })

  await test.step('the first week is due, and is marked paid', async () => {
    // The schedule is made up to 56 days ahead as it's saved, the first Monday among them.
    const first = page
      .getByRole('region', { name: 'Due', exact: true })
      .getByRole('link')
      .filter({ hasText: `Due ${await dateText(page, firstDue)}` })
    await expect(first).toContainText('Rent')
    await expect(first).toContainText('$400.00')
    await first.click()
    await expect(page.getByRole('heading', { level: 1, name: 'Rent', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Mark paid', exact: true }).click()
    await expect(page.getByText('Marked paid.', { exact: true })).toBeVisible()
  })

  await test.step('pauses it from today, then resumes it', async () => {
    await page.goto('/bills')
    // Today as the page has it when it pauses: taken here, so a run that crossed midnight since
    // the start still matches.
    const pausedOn = localToday(ZONE, new Date())
    await page.getByRole('button', { name: 'Pause Rent', exact: true }).click()
    await page.getByRole('button', { name: 'Pause it', exact: true }).click()
    await expect(
      page.getByText('Paused Rent from today. Resume it to carry on.', { exact: true }),
    ).toBeVisible()
    await expect(rentRow(page)).toContainText(`Paused from ${await dateText(page, pausedOn)}`)
    // The week already paid stays; the unpaid ones from today on go. "Nothing due." shows only
    // once the list has loaded.
    await expect(
      page
        .getByRole('region', { name: 'Due', exact: true })
        .getByText('Nothing due.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Resume Rent', exact: true }).click()
    await expect(page.getByText(/^Resumed Rent\. Bills are made again from today/)).toBeVisible()
    await expect(rentRow(page)).not.toContainText('Paused from')
    // Made again from today: the second Monday is due, and the paid first one isn't made twice.
    const due = page.getByRole('region', { name: 'Due', exact: true }).getByRole('link')
    await expect(
      due.filter({ hasText: `Due ${await dateText(page, addDays(firstDue, 7))}` }),
    ).toHaveCount(1)
    await expect(due.filter({ hasText: `Due ${await dateText(page, firstDue)}` })).toHaveCount(0)
  })
})
