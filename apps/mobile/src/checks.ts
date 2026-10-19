import { addDays, type LocalDate } from '@ledgerly/core/dates/local-date'
import { closeAtFor, localTimeToUtc, localToday } from '@ledgerly/core/dates/time-zone'
import { normalizePhone } from '@ledgerly/core/identity/normalize'
import { formatMoney, formatNet } from '@ledgerly/core/money/format'
import { expandSchedule } from '@ledgerly/core/recurrence/expand-schedule'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import { startTimerBodySchema } from '@ledgerly/core/schemas/ledger'

/**
 * Core run on the phone (#57). The expected values are what the same calls give under Node
 * (checks.test.ts writes checks.expected.json), so none is typed by hand. Instants are fixed,
 * so neither the phone's nor the machine's time zone changes a value.
 */
const date = (text: string) => text as LocalDate
const at = (iso: string) => new Date(iso)

function holidays(region: string, year: number): string[] {
  const isHoliday = publicHolidayChecker(region)
  const found: string[] = []
  for (let day = date(`${year}-01-01`); day <= `${year}-12-31`; day = addDays(day, 1)) {
    if (isHoliday(day)) found.push(day)
  }
  return found
}

export const CHECKS: Record<string, () => unknown> = {
  // Sydney's DST starts 2026-10-04 at 02:00 (UTC+10 to +11); New York's 2026-03-08 and ends 2026-11-01.
  'localToday Sydney, last second of 3 Oct': () =>
    localToday('Australia/Sydney', at('2026-10-03T13:59:59Z')),
  'localToday Sydney, first second of 4 Oct': () =>
    localToday('Australia/Sydney', at('2026-10-03T14:00:00Z')),
  'localToday New York, last second of 7 Mar': () =>
    localToday('America/New_York', at('2026-03-08T04:59:59Z')),
  'localToday New York, first second of 8 Mar (DST day)': () =>
    localToday('America/New_York', at('2026-03-08T05:00:00Z')),
  'localTimeToUtc Sydney 06:00, day before DST': () =>
    localTimeToUtc(date('2026-10-03'), 6, 'Australia/Sydney'),
  'localTimeToUtc Sydney 06:00, DST day': () =>
    localTimeToUtc(date('2026-10-04'), 6, 'Australia/Sydney'),
  'localTimeToUtc New York 06:00, DST day': () =>
    localTimeToUtc(date('2026-03-08'), 6, 'America/New_York'),
  'localTimeToUtc New York 01:00, end of DST': () =>
    localTimeToUtc(date('2026-11-01'), 1, 'America/New_York'),
  'closeAtFor Sydney, period ending 3 Oct': () =>
    closeAtFor(date('2026-10-03'), 'Australia/Sydney'),
  'closeAtFor New York, period ending 31 Oct': () =>
    closeAtFor(date('2026-10-31'), 'America/New_York'),
  'formatMoney AUD': () => formatMoney(123456, 'AUD', 'en-AU'),
  'formatMoney JPY': () => formatMoney(1234, 'JPY', 'en-AU'),
  'formatNet AUD, negative': () => formatNet(-1230, 'AUD', 'en-AU'),
  'zod accepts a timer start': () =>
    startTimerBodySchema.safeParse({ id: 'timer1', groupId: 'group1' }).success,
  'zod refuses fractional cents': () =>
    startTimerBodySchema.safeParse({ id: 'timer1', groupId: 'group1', rateCents: 1.5 }).success,
  'rrule: Thursdays in Oct 2026': () =>
    expandSchedule(
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', startsOn: date('2026-10-01'), skipPublicHolidays: false },
      date('2026-10-01'),
      date('2026-10-31'),
      () => false,
    ),
  'AU-NSW public holidays 2027': () => holidays('AU-NSW', 2027),
  // A number from the range set aside for fiction.
  'normalizePhone AU mobile': () => normalizePhone('0491 570 156', 'AU'),
}

export type CheckResult = { value: unknown } | { error: string }

export function runCheck(run: () => unknown): CheckResult {
  try {
    return { value: run() }
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

/** Every check's result, by name. */
export function runChecks(): Record<string, CheckResult> {
  return Object.fromEntries(Object.entries(CHECKS).map(([name, run]) => [name, runCheck(run)]))
}
