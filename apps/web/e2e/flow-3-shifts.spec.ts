import { addDays, type LocalDate, weekdayOf } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { expect, type Page, test } from '@playwright/test'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer } from './employer'
import { logIn, setupUser } from './users'

// User flow 3 (docs/product/user-flows.md#3-a-normal-thursday-extra-hours-or-a-missed-day), on
// a schedule of its own: 5 h at $25/h on today's weekday, today and a week on.
const ZONE = 'Australia/Sydney'
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Chooses a day on the calendar: its items, each a link reading "description, group · status, amount". */
async function dayItems(page: Page, day: LocalDate) {
  await page.goto(`/calendar?month=${day.slice(0, 7)}&day=${day}`)
  return page
    .getByRole('region')
    .filter({ has: page.locator('#day-heading') })
    .getByRole('link')
}

// The employer this test adds, archived after it even when it fails.
let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveEmployer(page, groupId)
})

test('changes a shift, adds another, voids one and times one', async ({ page }) => {
  await logIn(page, setupUser('kim'))
  const employer = `Kiosk ${runId()}`
  await page.goto('/groups/new-employer')
  groupId = await addEmployer(page, employer, testEmail('kiosk-billing'))

  const today = localToday(ZONE, new Date())
  const weekday = WEEKDAYS[weekdayOf(today) - 1] as string
  await page.goto(`/schedules/new?groupId=${groupId}`)
  await page.getByLabel('Paid hours per shift').fill('5')
  await page.getByLabel(weekday, { exact: true }).check()
  await page.getByLabel('Starts on').fill(today)
  await page.getByLabel('After a number of shifts').check()
  await page.getByLabel('Number of shifts', { exact: true }).fill('2')
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click()
  await expect(page.getByText(`Every ${weekday}, 2 shifts`)).toBeVisible()

  await test.step('worked 2 extra hours: today’s shift goes from 5 h to 7 h', async () => {
    const items = await dayItems(page, today)
    await expect(items).toHaveCount(1)
    await expect(items).toHaveText(/^Shift.*· Scheduled\s*\$125\.00$/)
    await items.click()
    await page.getByRole('link', { name: 'Change this shift', exact: true }).click()
    await expect(page.getByLabel('Hours worked')).toHaveValue('5')
    await page.getByLabel('Hours worked').fill('7')
    await expect(page.getByText('7 h 0 min paid · $175.00', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
    // Shown as edited: the group's activity has the change. The occurrence itself carries no
    // mark on screen (see #38).
    await page.goto(`/activity?groupId=${groupId}`)
    await expect(
      page.getByText('Changed “Shift”: $125.00 → $175.00', { exact: true }),
    ).toBeVisible()
  })

  await test.step('extra hours at another rate: a second shift the same day', async () => {
    await page.goto(`/shifts/new?groupId=${groupId}&date=${today}`)
    await page.getByLabel('Description', { exact: true }).fill('Extra hours')
    await page.getByLabel('Hours', { exact: true }).check()
    await page.getByLabel('Hours worked').fill('2')
    await page.getByLabel('Hourly rate (AUD)').fill('30')
    await expect(page.getByText('2 h 0 min paid · $60.00', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add shift', exact: true }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Extra hours', exact: true }),
    ).toBeVisible()
    const items = await dayItems(page, today)
    await expect(items).toHaveCount(2)
    await expect(items.filter({ hasText: 'Extra hours' })).toHaveText(/· Posted\s*\$60\.00$/)
    await expect(items.filter({ hasText: '$175.00' })).toHaveText(/^Shift.*· Scheduled/)
  })

  await test.step('didn’t go: next week’s shift is voided with a reason', async () => {
    const nextWeek = addDays(today, 7)
    const items = await dayItems(page, nextWeek)
    await expect(items).toHaveCount(1)
    await items.click()
    await page.getByLabel('Reason for voiding').fill('Didn’t go')
    // The page shows the void before the server answers, so wait for the answer before leaving:
    // a navigation could cancel the request. Every call is an execution, so match the void's.
    const answered = page.waitForResponse(
      (response) =>
        response.url().includes('/executions') &&
        /\/transactions\/[^/"]+\/void/.test(response.request().postData() ?? ''),
    )
    await page.getByRole('button', { name: 'Void', exact: true }).click()
    await expect(page.getByText('Void. Reason: Didn’t go', { exact: true })).toBeVisible()
    // The function's own answer, so a refused void fails here, not at the calendar.
    const execution = await (await answered).json()
    expect(JSON.parse(execution.responseBody)).toMatchObject({ ok: true })
    // It stays on the calendar, struck through.
    const voided = await dayItems(page, nextWeek)
    await expect(voided).toHaveText(/^Shift.*· Void/)
    await expect(voided.getByText('Shift', { exact: true })).toHaveCSS(
      'text-decoration-line',
      'line-through',
    )
  })

  await test.step('an unplanned shift: Start, then Stop, on the Today screen', async () => {
    await page.goto('/today')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: `Timer running · ${employer}`, exact: true }),
    ).toBeVisible()
    // Shown once the server has the timer, with the link to its shift.
    const href = await page
      .getByRole('link', { name: 'Can’t stop it? Open the shift to void it', exact: true })
      .getAttribute('href')
    expect(href).toMatch(/^\/shifts\/[^/]+$/)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    const timed = page
      .getByRole('region', { name: 'Today’s shifts', exact: true })
      .locator(`a[href="${href}"]`)
    await expect(timed).toHaveText(/^Shift.*· Confirmed/)
  })
})
