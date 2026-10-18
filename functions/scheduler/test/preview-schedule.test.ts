import { describe, expect, it } from 'vitest'
import type { SchedulePreview } from '../src/routes/preview-schedule'
import { failure, fakes, group, member, ok, person } from './harness'

// Sam (u1) owns Acme; Alex (u2) is a viewer there; Sydney is a day ahead of UTC at NOW.
function seeded() {
  return fakes({
    persons: [person('pSam', 'u1'), person('pAlex', 'u2'), person('pKim', 'u3')],
    groups: [group('acme', 'pSam'), group('old', 'pSam', { archivedAt: '2026-10-01T00:00:00Z' })],
    members: [
      member('acme', 'pSam'),
      member('acme', 'pAlex', { role: 'viewer' }),
      member('old', 'pSam'),
    ],
  })
}

const thursdays = {
  groupId: 'acme',
  kind: 'shift',
  description: 'Thursday shift',
  template: { shift: { minutes: 300, rateCents: 2500 } },
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  startsOn: '2026-10-01',
  skipPublicHolidays: true,
  autoPost: true,
}

function preview(body: object, userId = 'u1') {
  return ok<SchedulePreview>(seeded(), 'POST', '/schedules/preview', { body, userId })
}

describe('POST /schedules/preview', () => {
  it('lists the next dates from today in the group’s timezone, 10 by default', async () => {
    const { dates, skipped } = await preview(thursdays)
    expect(dates).toEqual([
      '2026-10-22',
      '2026-10-29',
      '2026-11-05',
      '2026-11-12',
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
      '2026-12-10',
      '2026-12-17',
      '2026-12-24',
    ])
    expect(skipped).toEqual([])
  })

  it('counts today in the group’s timezone, not UTC', async () => {
    // Sunday 18 October is already over in Sydney.
    const { dates } = await preview({ ...thursdays, rrule: 'FREQ=WEEKLY;BYDAY=SU', count: 1 })
    expect(dates).toEqual(['2026-10-25'])
  })

  it('starts on startsOn when that is later than today', async () => {
    const { dates } = await preview({ ...thursdays, startsOn: '2027-03-01', count: 2 })
    expect(dates).toEqual(['2027-03-04', '2027-03-11'])
  })

  it('lists the skipped holidays and exdates with their reason, up to the last date', async () => {
    const { dates, skipped } = await preview({
      ...thursdays,
      // NSW: Christmas Day and New Year's Day 2027 are Fridays.
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
      startsOn: '2026-12-18',
      exdates: ['2027-01-08', '2027-02-05'],
      count: 3,
    })
    expect(dates).toEqual(['2026-12-18', '2027-01-15', '2027-01-22'])
    expect(skipped).toEqual([
      { date: '2026-12-25', reason: 'holiday' },
      { date: '2027-01-01', reason: 'holiday' },
      { date: '2027-01-08', reason: 'exdate' },
    ])
  })

  it('calls a skipped holiday that is also an exdate an exdate', async () => {
    const { skipped } = await preview({
      ...thursdays,
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
      startsOn: '2026-12-18',
      exdates: ['2026-12-25'],
      count: 2,
    })
    expect(skipped).toEqual([
      { date: '2026-12-25', reason: 'exdate' },
      { date: '2027-01-01', reason: 'holiday' },
    ])
  })

  it('keeps holidays when the schedule doesn’t skip them', async () => {
    const { dates, skipped } = await preview({
      ...thursdays,
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
      startsOn: '2026-12-25',
      skipPublicHolidays: false,
      count: 2,
    })
    expect(dates).toEqual(['2026-12-25', '2027-01-01'])
    expect(skipped).toEqual([])
  })

  it('stops at COUNT, UNTIL and endsOn', async () => {
    const future = { ...thursdays, startsOn: '2026-11-01' }
    expect((await preview({ ...future, rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=2' })).dates).toEqual([
      '2026-11-05',
      '2026-11-12',
    ])
    expect(
      (await preview({ ...future, rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261112' })).dates,
    ).toEqual(['2026-11-05', '2026-11-12'])
    expect((await preview({ ...future, endsOn: '2026-11-05' })).dates).toEqual(['2026-11-05'])
  })

  it('looks as far ahead as the skipped dates need', async () => {
    // Two years of exdates, plus every New Year's Day and some Labour Days as holidays.
    const exdates = Array.from({ length: 24 }, (_, index) => {
      const month = `${(index % 12) + 1}`.padStart(2, '0')
      return `${2027 + Math.floor(index / 12)}-${month}-01`
    })
    const { dates, skipped } = await preview({
      ...thursdays,
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      startsOn: '2026-11-01',
      exdates,
      count: 100,
    })
    expect(dates).toHaveLength(100)
    expect(dates.slice(0, 3)).toEqual(['2026-11-01', '2026-12-01', '2029-02-01'])
    expect(skipped.filter(({ reason }) => reason === 'exdate')).toHaveLength(24)
    expect(skipped.filter(({ reason }) => reason === 'holiday').length).toBeGreaterThan(0)
  })

  it('finds a date 31 days on, the longest gap a rule can have', async () => {
    // From the day after 28 February, the last day of the month is 31 days later.
    const { dates } = await preview({
      ...thursdays,
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
      startsOn: '2027-03-01',
      count: 1,
    })
    expect(dates).toEqual(['2027-03-31'])
  })

  it('stops at the last date there is', async () => {
    const { dates } = await preview({ ...thursdays, startsOn: '9999-12-01' })
    expect(dates).toEqual(['9999-12-02', '9999-12-09', '9999-12-16', '9999-12-23', '9999-12-30'])
  })

  it('lets any member preview, viewers included', async () => {
    expect((await preview({ ...thursdays, count: 1 }, 'u2')).dates).toEqual(['2026-10-22'])
  })

  it('refuses non-members, archived groups and invalid bodies', async () => {
    const services = seeded()
    const send = (body: object, userId: string | null = 'u1') =>
      failure(services, 'POST', '/schedules/preview', { body, userId })
    expect(await send(thursdays, 'u3')).toEqual({ status: 403, code: 'NOT_A_MEMBER' })
    expect(await send({ ...thursdays, groupId: 'old' })).toEqual({ status: 409, code: 'ARCHIVED' })
    expect(await send({ ...thursdays, rrule: 'FREQ=DAILY' })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(await send({ ...thursdays, count: 101 })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(await send(thursdays, null)).toEqual({ status: 401, code: 'UNAUTHENTICATED' })
  })
})
