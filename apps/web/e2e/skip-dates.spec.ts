import { addDays } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { test } from '@playwright/test'
import { expectPlannedShifts } from './calendar'
import { runId, testEmail } from './dev-project'
import { addEmployer, archiveEmployer, expectEmployerSettings } from './employer'
import { addWeeklyShift } from './schedule'
import { logIn, setupUser } from './users'

// Skipping a date on a shift schedule (#487, the schedule form's Skipped dates): no planned
// shift that day, and the weeks either side keep theirs.
const ZONE = 'Australia/Sydney'

let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveEmployer(page, groupId)
})

test('a skipped date has no planned shift, and the weeks either side still do', async ({
  page,
}) => {
  test.slow()
  await logIn(page, setupUser('dee'))
  await page.goto('/groups/new-employer')
  const employer = `Dee Co ${runId()}`
  groupId = await addEmployer(page, employer, testEmail('dee-billing'))
  await expectEmployerSettings(page, employer)
  const today = localToday(ZONE, new Date())
  const skipped = addDays(today, 14)
  await addWeeklyShift(page, groupId, today, addDays(today, 28), [skipped])
  const weeks = [7, 14, 21].map((days) => addDays(today, days))
  await expectPlannedShifts(page, new Map(weeks.map((day) => [day, day !== skipped])))
})
