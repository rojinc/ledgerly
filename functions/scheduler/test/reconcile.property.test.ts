import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { expandSchedule, occurrenceId } from '@ledgerly/core/recurrence/expand-schedule'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import { scheduleEnd } from '../src/occurrences'
import { call, type Fakes, fakes, group, member, person } from './harness'

// Random edits, ends, cron runs on later days, manual edits and timeouts against one schedule,
// with scheduling.md's promises checked after every step. Seeded, so a failure repeats.

const ID = 'propertySchedule0001'
const RULES = [
  'FREQ=WEEKLY;BYDAY=TH',
  'FREQ=WEEKLY;BYDAY=FR',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
  'FREQ=MONTHLY;BYMONTHDAY=1',
  'FREQ=MONTHLY;BYMONTHDAY=-1',
  'FREQ=WEEKLY;BYDAY=TH;COUNT=6',
  'FREQ=WEEKLY;BYDAY=SA,SU;UNTIL=20261231',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
]
const START = '2026-10-19' as LocalDate
const SEEDS = 20
const STEPS = 30

function seeded() {
  return fakes(
    {
      persons: [person('pSam', 'u1'), person('pAcme', null)],
      groups: [group('acme', 'pSam')],
      members: [member('acme', 'pSam'), member('acme', 'pAcme', { status: 'placeholder' })],
    },
    { accounts: {} },
  )
}

// A small linear congruential generator: random(n) is 0 to n − 1.
function generator(seed: number): (n: number) => number {
  let state = seed
  return (n) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % n
  }
}

function rows(services: Fakes): Transactions[] {
  return services.db.rows('transactions') as unknown as Transactions[]
}

function stored(services: Fakes): Schedules | undefined {
  return services.db.rows('schedules').find((row) => row.$id === ID) as unknown as
    | Schedules
    | undefined
}

// Never changed by the scheduler again: posted, voided, edited, or before today and already
// reached by the schedule (up to its generatedThrough).
function settled(row: Transactions, today: LocalDate, through: LocalDate | null): boolean {
  const date = row.date as LocalDate
  return (
    row.status === 'posted' ||
    row.status === 'void' ||
    row.overridden ||
    (compareDates(date, today) < 0 && through !== null && compareDates(date, through) <= 0)
  )
}

// The row without what other steps may still set on it.
function kept(row: Transactions): string {
  const { $updatedAt, $sequence, remindedAt, ...rest } = row as unknown as Record<string, unknown>
  return JSON.stringify(rest)
}

function check(
  services: Fakes,
  before: Transactions[],
  touched: Set<string>,
  reached: LocalDate | null,
  // A cron run may reach back to where the schedule had got to; an edit or end starts today.
  byCron: boolean,
): void {
  const today = localToday('Australia/Sydney', services.now)
  const all = rows(services)
  const byId = new Map(all.map((row) => [row.$id, row]))
  for (const item of services.db.rows('items')) {
    expect(byId.has(item.transactionId as string), 'an item without its transaction').toBe(true)
  }
  for (const was of before) {
    if (!settled(was, today, reached) || touched.has(was.$id)) continue
    const row = byId.get(was.$id)
    expect(row, `${was.$id} was deleted`).toBeDefined()
    // Step 2 posts a past shift of a schedule that auto-posts (scheduling.md#step-2-auto-post),
    // and changes nothing else on it.
    const autoPosted = byCron && stored(services)?.autoPost === true && was.status === 'scheduled'
    const expected = autoPosted && row?.status === 'posted' ? { ...was, status: 'posted' } : was
    if (row) expect(kept(row), `${was.$id} was changed`).toBe(kept(expected as Transactions))
  }
  // Once the schedule isn't due, it is in line with its rule from today to generatedThrough.
  const schedule = stored(services)
  const through = schedule?.generatedThrough as LocalDate | null | undefined
  if (!schedule || !through) return
  if (schedule.nextRunAt !== null && schedule.nextRunAt <= services.now.toISOString()) return
  const end = scheduleEnd(schedule)
  const upTo = end && compareDates(end, through) < 0 ? end : through
  const startsOn = schedule.startsOn as LocalDate
  // From where this step could reach: today, or earlier when the schedule hadn't got that far.
  const next = reached ? addDays(reached, 1) : startsOn
  const window = byCron && compareDates(next, today) < 0 ? next : reached ? today : startsOn
  const from = compareDates(startsOn, window) > 0 ? startsOn : window
  const dates =
    compareDates(from, upTo) <= 0
      ? expandSchedule(
          {
            rrule: schedule.rrule,
            startsOn,
            endsOn: schedule.endsOn as LocalDate | null,
            exdates: schedule.exdates as LocalDate[] | null,
            skipPublicHolidays: schedule.skipPublicHolidays,
          },
          from,
          upTo,
          schedule.skipPublicHolidays ? publicHolidayChecker('AU-NSW') : () => false,
        )
      : []
  const planned = new Set(dates.map((date) => occurrenceId(ID, date)))
  for (const id of planned) expect(byId.has(id), `${id} is missing`).toBe(true)
  for (const row of all) {
    if (
      settled(row, today, '9999-12-31' as LocalDate) &&
      compareDates(row.date as LocalDate, window) < 0
    )
      continue
    if (row.status === 'posted' || row.status === 'void' || row.overridden) continue
    const date = row.date as LocalDate
    if (compareDates(date, through) > 0 && !(end && compareDates(date, end) > 0)) continue
    expect(planned.has(row.$id), `${row.$id} is not on the rule`).toBe(true)
    expect(row.description, `${row.$id} has the old template`).toBe(schedule.description)
  }
}

describe('reconcile, under random edits, ends, runs and timeouts', () => {
  it.each(Array.from({ length: SEEDS }, (_, index) => index + 1))('seed %i', async (seed) => {
    const random = generator(seed)
    const services = seeded()
    const steps: string[] = []
    const body = () => {
      const startsOn = addDays(START, random(90) - 40)
      const endsOn = random(3) === 0 ? addDays(startsOn, random(150)) : undefined
      return {
        id: ID,
        groupId: 'acme',
        kind: 'shift',
        description: ['Early', 'Late', 'Night'][random(3)],
        template: { category: 'work', shift: { minutes: 60 * (1 + random(8)), rateCents: 2500 } },
        rrule: RULES[random(RULES.length)],
        startsOn,
        ...(endsOn ? { endsOn } : {}),
        skipPublicHolidays: random(2) === 0,
        autoPost: random(2) === 0,
        horizonDays: 7 + random(114),
      }
    }
    for (let step = 0; step < STEPS; step++) {
      const before = rows(services)
      const through = (stored(services)?.generatedThrough ?? null) as LocalDate | null
      const touched = new Set<string>()
      const exists = stored(services) !== undefined
      const action = exists ? random(7) : 0
      // About one step in five has a commit time out.
      const timeout = random(5) === 0 ? 1 + random(4) : 0
      const commit = services.db.updateTransaction.bind(services.db)
      let commits = 0
      const spy = vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
        if (params.commit && ++commits === timeout) throw new Error('Timed out')
        return commit(params)
      })
      if (action === 0) {
        const input = body()
        const path = exists ? `/schedules/${ID}` : '/schedules'
        const { status } = await call(services, exists ? 'PATCH' : 'POST', path, { body: input })
        steps.push(`${exists ? 'PATCH' : 'POST'} ${JSON.stringify(input)} → ${status}`)
      } else if (action === 1) {
        const endsOn = addDays(stored(services)?.startsOn as LocalDate, random(120))
        const { status } = await call(services, 'POST', `/schedules/${ID}/end`, {
          body: { endsOn },
        })
        steps.push(`END ${endsOn} → ${status}`)
      } else if (action <= 4) {
        spy.mockRestore()
        // A later day, or the same hour again.
        if (action < 4)
          services.now = new Date(services.now.getTime() + (1 + random(10)) * 86_400_000)
        const { status, body: result } = await call(services, 'POST', '/', {
          userId: null,
          scheduled: true,
        })
        steps.push(`CRON at ${services.now.toISOString()} → ${status} ${JSON.stringify(result)}`)
        expect(status, steps.join('\n')).toBe(200)
      } else {
        spy.mockRestore()
        const open = rows(services).filter((row) => row.status === 'scheduled' && !row.overridden)
        const row = open[random(Math.max(1, open.length))]
        if (row) {
          const changes: Record<string, unknown>[] = [
            { overridden: true, description: 'Edited' },
            { status: 'void', voidReason: 'Sick' },
            { status: 'posted' },
          ]
          const change = changes[random(changes.length)] as Record<string, unknown>
          await withTransaction(services.db, (tx) =>
            tx.write({ action: 'update', tableId: 'transactions', rowId: row.$id, data: change }),
          )
          touched.add(row.$id)
          steps.push(`MANUAL ${row.$id} ${JSON.stringify(change)}`)
        }
      }
      spy.mockRestore()
      try {
        check(services, before, touched, through, action >= 2 && action <= 4)
      } catch (error) {
        throw new Error(`${(error as Error).message}\nafter:\n${steps.join('\n')}`)
      }
    }
  })
})
