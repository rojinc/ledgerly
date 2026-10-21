import { addDays } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { expect, test } from '@playwright/test'
import { expectPlannedShifts } from './calendar'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer, expectEmployerSettings } from './employer'
import { addWeeklyShift } from './schedule'
import { logIn, setupUser } from './users'

// Pausing and resuming a shift schedule (#430, scheduling.md#pausing-a-schedule): a pause
// removes the planned shifts from its date on, and Resume makes them again from today.
const ZONE = 'Australia/Sydney'

let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveEmployer(page, groupId)
})

test('a pause removes the planned shifts from its date, and Resume brings them back', async ({
  page,
}) => {
  // Five weeks of the calendar, twice, on a Vite server that may be cold.
  test.slow()
  await logIn(page, setupUser('cal'))
  await page.goto('/groups/new-employer')
  const employer = `Cal Co ${runId()}`
  groupId = await addEmployer(page, employer, testEmail('cal-billing'))
  await expectEmployerSettings(page, employer)
  const today = localToday(ZONE, new Date())
  const weeks = [0, 7, 14, 21, 28].map((days) => addDays(today, days))
  await addWeeklyShift(page, groupId, today, addDays(today, 28))
  await expectPlannedShifts(page, new Map(weeks.map((day) => [day, true])))

  // Paused from the third week: it and the weeks after are removed; the first two stay.
  const pausedFrom = addDays(today, 14)
  await page.goto(`/schedules?groupId=${groupId}`)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByLabel('Pause from').fill(pausedFrom)
  await page.getByRole('button', { name: 'Pause schedule', exact: true }).click()
  await expect(page.getByText(/ · Paused from /)).toBeVisible()
  await expectPlannedShifts(page, new Map(weeks.map((day) => [day, day < pausedFrom])))

  // Resume makes them again from today: every week has its shift.
  await page.goto(`/schedules?groupId=${groupId}`)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(
    page.getByText('Resumed. Shifts carry on from today; the days in between aren’t added.'),
  ).toBeVisible()
  await expect(page.getByText(/ · Paused from /)).toHaveCount(0)
  await expectPlannedShifts(page, new Map(weeks.map((day) => [day, true])))
})
