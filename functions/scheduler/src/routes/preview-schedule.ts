import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import { expandSchedule } from '@ledgerly/core/recurrence/expand-schedule'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import { previewScheduleBodySchema } from '@ledgerly/core/schemas/scheduler'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { parseBody } from '../parse-body'
import type { Services } from '../services'

export type SkipReason = 'exdate' | 'holiday'

export type SchedulePreview = {
  dates: LocalDate[]
  skipped: { date: LocalDate; reason: SkipReason }[]
}

const DEFAULT_COUNT = 10
// The rules the API accepts (scheduling.md#rules-the-ui-builds) fall at least once every
// 31 days, so a 31-day window without a date means the schedule has ended.
const MAX_GAP_DAYS = 31

/**
 * `scheduler POST /schedules/preview` (functions-api.md#scheduler): the next dates of an
 * unsaved schedule, from the later of `startsOn` and today in the group's timezone, and the
 * dates it skips on the way, for the form preview.
 */
export async function previewSchedule(
  { db, now }: Services,
  userId: string | null,
  body: unknown,
): Promise<SchedulePreview> {
  const { count = DEFAULT_COUNT, ...schedule } = parseBody(previewScheduleBodySchema, body)
  const { group } = await requireMember(db, userId, schedule.groupId)
  const today = localToday(group.timezone, now)
  const isHoliday = schedule.skipPublicHolidays ? publicHolidayChecker(group.region) : null
  const exdates = new Set(schedule.exdates)
  const preview: SchedulePreview = { dates: [], skipped: [] }
  let from = compareDates(schedule.startsOn, today) < 0 ? today : schedule.startsOn
  while (preview.dates.length < count) {
    // A window long enough for the dates still missing if none were skipped; every skip
    // makes it look further.
    const to = addDays(from, MAX_GAP_DAYS * (count - preview.dates.length))
    // Every date the rule hits, so the skipped ones can be listed with their reason.
    const hits = expandSchedule(
      { ...schedule, exdates: null, skipPublicHolidays: false },
      from,
      to,
      () => false,
    )
    if (hits.length === 0) break
    for (const date of hits) {
      if (preview.dates.length === count) break
      if (exdates.has(date)) preview.skipped.push({ date, reason: 'exdate' })
      else if (isHoliday?.(date)) preview.skipped.push({ date, reason: 'holiday' })
      else preview.dates.push(date)
    }
    from = addDays(to, 1)
  }
  return preview
}
