import { addDays, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import { expect, test } from '@playwright/test'
import { dayButton } from './calendar'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer, expectEmployerSettings } from './employer'
import { logIn, setupUser } from './users'

// User flow 2 (docs/product/user-flows.md#2-set-up-an-employer-with-a-weekly-shift). The
// browser is in Sydney, so bootstrap gives the profile Australia/Sydney, AU-NSW and AUD.
const ZONE = 'Australia/Sydney'
const THURSDAY = 4
// The scheduler creates a new schedule's shifts up to 56 days ahead (scheduling.md).
const HORIZON_DAYS = 56

// The employer this test adds, archived after it even when it fails.
let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveEmployer(page, groupId)
})

test('sets up an employer and a weekly Thursday shift, shown dashed for 8 weeks', async ({
  page,
}) => {
  // 57 days of the calendar, on a Vite server that may be cold.
  test.slow()
  await logIn(page, setupUser('sam'))
  const employer = `Acme ${runId()}`

  // Step 1: Groups → New → Employer, from the guide.
  await page.getByRole('link', { name: /^Hours I work for someone/ }).click()
  const billing = testEmail('acme-billing')
  groupId = await addEmployer(page, employer, billing)
  await expectEmployerSettings(page, employer)
  // Its settings, as saved.
  await expect(page.getByLabel('Billing emails', { exact: true })).toHaveValue(billing)
  await expect(page.getByLabel('Default hourly rate (AUD)')).toHaveValue('25.00')
  await expect(page.getByLabel('Invoice cycle')).toHaveValue('monthly')
  await expect(page.getByLabel('Payment terms (days)')).toHaveValue('14')

  // Step 2: every Thursday, 5 hours at the employer's $25/h, from today, skipping NSW holidays.
  // It ends with the horizon, so runs don't leave schedules in dev that go on for ever.
  const today = localToday(ZONE, new Date())
  await page.goto(`/schedules/new?groupId=${groupId}`)
  await page.getByLabel('Paid hours per shift').fill('5')
  await expect(page.getByLabel('Hourly rate (AUD)')).toHaveValue('25.00')
  await page.getByLabel('Thursday', { exact: true }).check()
  await page.getByLabel('Starts on').fill(today)
  await page.getByLabel('On a date').check()
  await page.getByLabel('Last date').fill(addDays(today, HORIZON_DAYS))
  await page.getByLabel('Skip public holidays (AU-NSW)').check()
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click()
  await expect(page.getByText(/^Every Thursday/)).toBeVisible()

  // Step 3: the calendar shows a dashed shift on each of those Thursdays, and on no other day.
  const isHoliday = publicHolidayChecker('AU-NSW')
  const days = Array.from({ length: HORIZON_DAYS + 1 }, (_, i) => addDays(today, i))
  const months = [...new Set(days.map((day) => day.slice(0, 7)))]
  for (const month of months) {
    await page.goto(`/calendar?month=${month}`)
    for (const day of days.filter((date) => date.startsWith(month))) {
      const button = await dayButton(page, day)
      // The grid renders once the month's shifts are read: a count of 0 means nothing before.
      await expect(button, day).toBeVisible()
      const expected = weekdayOf(day) === THURSDAY && !isHoliday(day)
      await expect(button.locator('.border-dashed', { hasText: 'Shift' }), day).toHaveCount(
        expected ? 1 : 0,
      )
    }
  }
})
