import { addDays, type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import { expect, test } from '@playwright/test'
import { runId, testEmail } from './dev-project'
import { logIn, setupUser } from './users'

// User flow 2 (docs/product/user-flows.md#2-set-up-an-employer-with-a-weekly-shift). The
// browser is in Sydney, so bootstrap gives the profile Australia/Sydney, AU-NSW and AUD.
const ZONE = 'Australia/Sydney'
const THURSDAY = 4
// The scheduler creates a new schedule's shifts up to 56 days ahead (scheduling.md).
const HORIZON_DAYS = 56

test('sets up an employer and a weekly Thursday shift, shown dashed for 8 weeks', async ({
  page,
}) => {
  await logIn(page, setupUser('sam'))
  const employer = `Acme ${runId()}`

  // Step 1: Groups → New → Employer, from the guide.
  await page.getByRole('link', { name: /^Hours I work for someone/ }).click()
  await page.getByLabel('Employer name').fill(employer)
  await page.getByLabel('Billing emails').fill(testEmail('acme-billing'))
  await page.getByLabel('Default hourly rate (AUD)').fill('25')
  await page.getByLabel('Invoice cycle').selectOption({ label: 'Monthly' })
  await page.getByLabel('Payment terms (days)').fill('14')
  await page.getByRole('button', { name: 'Create employer' }).click()
  await expect(page.getByRole('heading', { level: 1, name: employer })).toBeVisible()
  const groupId = /\/groups\/([^/]+)\/settings/.exec(page.url())?.[1]
  expect(groupId).toBeTruthy()

  // Step 2: every Thursday, 5 hours at the employer's $25/h, from today, skipping NSW holidays.
  const today = localToday(ZONE, new Date())
  await page.goto(`/schedules/new?groupId=${groupId}`)
  await page.getByLabel('Paid hours per shift').fill('5')
  await expect(page.getByLabel('Hourly rate (AUD)')).toHaveValue('25.00')
  await page.getByLabel('Thursday', { exact: true }).check()
  await page.getByLabel('Starts on').fill(today)
  await page.getByLabel('Skip public holidays (AU-NSW)').check()
  await page.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByText(/^Every Thursday/)).toBeVisible()

  // Step 3: the calendar shows a dashed shift on each of those Thursdays, and on no other day.
  const isHoliday = publicHolidayChecker('AU-NSW')
  const days = Array.from({ length: HORIZON_DAYS + 1 }, (_, i) => addDays(today, i))
  const months = [...new Set(days.map((day) => day.slice(0, 7)))]
  for (const month of months) {
    await page.goto(`/calendar?month=${month}`)
    for (const day of days.filter((date) => date.startsWith(month))) {
      const shift = dayButton(page, day).locator('.border-dashed', { hasText: 'Shift' })
      const expected = weekdayOf(day) === THURSDAY && !isHoliday(day)
      await expect(shift, day).toHaveCount(expected ? 1 : 0)
    }
  }
})

/** A calendar day's button, named by its date ("Thursday 22 October, 1 item"). */
function dayButton(page: import('@playwright/test').Page, day: LocalDate) {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const label = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(Date.UTC(year, month - 1, date))
  return page.getByRole('button', { name: new RegExp(`^${label},`) })
}
