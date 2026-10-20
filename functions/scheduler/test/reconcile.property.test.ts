import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Items, Schedules, Transactions } from '@ledgerly/core/generated/rows'
import { expandSchedule, occurrenceId } from '@ledgerly/core/recurrence/expand-schedule'
import { publicHolidayChecker } from '@ledgerly/core/recurrence/public-holidays'
import type { TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { type Ledger, loadGroupLedger, plan } from '@ledgerly/server/ledger/transactions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../src/routes/run'
import { call, type Fakes, fakes, group, member, person } from './harness'

// Random edits, ends, cron runs on later days, manual edits, timeouts and runs that run out of
// time against one schedule, a shift in Sydney or a bill in Los Angeles, with scheduling.md's
// promises checked after every step. Seeded, so a failure repeats.

const ID = 'propertySchedule0001'
const RULES = [
  'FREQ=WEEKLY;BYDAY=TH',
  'FREQ=WEEKLY;BYDAY=FR',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
  'FREQ=MONTHLY;BYMONTHDAY=1',
  'FREQ=MONTHLY;BYMONTHDAY=-1',
  'FREQ=WEEKLY;BYDAY=SA,SU',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'FREQ=WEEKLY;BYDAY=TU,WE,TH,FR,SA',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
]
const SEEDS = 20
const STEPS = 30
const DAY_MS = 86_400_000
const BOTH = { mode: 'equal', personIds: ['pSam', 'pAlex'] }

type Random = (n: number) => number
type Request = (services: Fakes) => ReturnType<typeof call>

// Shifts in Acme, an employer group in Sydney; bills in Elm St, a house in Los Angeles.
function seeded() {
  return fakes(
    {
      persons: [person('pSam', 'u1'), person('pAlex', 'u2'), person('pAcme', null)],
      groups: [
        group('acme', 'pSam'),
        group('elm', 'pSam', {
          type: 'house',
          name: 'Elm St',
          currency: 'USD',
          timezone: 'America/Los_Angeles',
          region: 'US-CA',
          settingsJson: '{"type":"house"}',
        }),
      ],
      members: [
        member('acme', 'pSam'),
        member('acme', 'pAcme', { status: 'placeholder' }),
        member('elm', 'pSam'),
        member('elm', 'pAlex', { role: 'member' }),
      ],
    },
    { accounts: {} },
  )
}

// A small linear congruential generator: random(n) is 0 to n − 1.
function generator(seed: number): Random {
  let state = seed
  return (n) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % n
  }
}

// FakeDb stamps $createdAt from the clock, and step 2 reads it, so the clock is services.now,
// never the machine's.
function setNow(services: Fakes, now: Date): void {
  services.now = now
  vi.setSystemTime(now)
}

// A valid POST body (scheduling.md#rules-the-ui-builds) that starts on `startsOn`, by default a
// day at most 31 days ago (scheduling.md#schedule-routes).
function newSchedule(
  random: Random,
  kind: 'shift' | 'bill',
  today: LocalDate,
  startsOn = addDays(today, random(60) - 31),
) {
  const rule = RULES[random(RULES.length)] as string
  const ruleEnd = random(4)
  const rrule =
    ruleEnd === 0
      ? `${rule};COUNT=${1 + random(60)}`
      : ruleEnd === 1
        ? `${rule};UNTIL=${addDays(startsOn, random(240)).replaceAll('-', '')}`
        : rule
  // A few of the rule's own dates, so that skipping them matters.
  const days = expandSchedule(
    { rrule, startsOn, skipPublicHolidays: false },
    startsOn,
    addDays(startsOn, 120),
    () => false,
  )
  const exdates =
    days.length > 0 && random(2) === 0
      ? [...new Set(Array.from({ length: 1 + random(3) }, () => days[random(days.length)]))]
      : undefined
  const endsOn = random(3) === 0 ? addDays(startsOn, random(240)) : undefined
  return {
    id: ID,
    groupId: kind === 'bill' ? 'elm' : 'acme',
    kind,
    description: (kind === 'bill' ? ['Power', 'Water', 'Rent'] : ['Early', 'Late', 'Night'])[
      random(3)
    ],
    template: kind === 'bill' ? billTemplate(random) : shiftTemplate(random),
    rrule,
    startsOn,
    ...(endsOn ? { endsOn } : {}),
    ...(exdates ? { exdates } : {}),
    skipPublicHolidays: random(2) === 0,
    autoPost: random(2) === 0,
    horizonDays: 7 + random(114),
  }
}

// A PATCH body: the schedule as it is, with some of its parts changed: its dates (rule, start, end
// and skipped days, together), template, description, switches or horizon. It may keep its start,
// which can be longer ago.
function editedSchedule(
  random: Random,
  kind: 'shift' | 'bill',
  today: LocalDate,
  schedule: Schedules,
) {
  const changed = newSchedule(
    random,
    kind,
    today,
    random(2) === 0 ? (schedule.startsOn as LocalDate) : undefined,
  )
  const keep = () => random(2) === 0
  return {
    ...changed,
    ...(keep()
      ? {
          rrule: schedule.rrule,
          startsOn: schedule.startsOn,
          endsOn: schedule.endsOn ?? undefined,
          exdates: schedule.exdates ?? undefined,
        }
      : {}),
    ...(keep() ? { template: JSON.parse(schedule.templateJson) } : {}),
    ...(keep() ? { description: schedule.description } : {}),
    ...(keep()
      ? { skipPublicHolidays: schedule.skipPublicHolidays, autoPost: schedule.autoPost }
      : {}),
    ...(keep() ? { horizonDays: schedule.horizonDays } : {}),
  }
}

function shiftTemplate(random: Random) {
  const shift = { minutes: 30 * (1 + random(16)), rateCents: 2_000 + 500 * random(4) }
  return { category: 'work', shift }
}

// Due on each date, with no dueOn or billing period (scheduling.md#what-a-schedule-is): a total
// split between both, or 8 to 16 items, so that an expansion often takes several batches.
function billTemplate(random: Random) {
  const category = ['electricity', 'water', 'rent'][random(3)]
  const bill = { status: 'due' }
  if (random(3) === 0) return { category, totalCents: 100 * (50 + random(100)), split: BOTH, bill }
  const items = Array.from({ length: 8 + random(9) }, (_, line) => ({
    name: `Line ${line + 1}`,
    amountCents: 100 * (1 + random(80)),
    split: BOTH,
  }))
  return { category, items, bill }
}

function rows(services: Fakes): Transactions[] {
  return services.db.rows('transactions') as unknown as Transactions[]
}

function stored(services: Fakes): Schedules | undefined {
  return services.db.rows('schedules').find((row) => row.$id === ID) as unknown as
    | Schedules
    | undefined
}

function groupRow(services: Fakes, groupId: string): Groups {
  return services.db.rows('groups').find((row) => row.$id === groupId) as unknown as Groups
}

function isDue(schedule: Schedules, now: Date): boolean {
  return schedule.nextRunAt !== null && schedule.nextRunAt <= now.toISOString()
}

// Still `scheduled` or `due`, and not edited: the schedule may change or delete it.
function changeable(row: Transactions): boolean {
  return (row.status === 'scheduled' || row.status === 'due') && !row.overridden
}

// Never changed by the scheduler again: posted, voided, edited, or before today and already
// reached by the schedule (up to its generatedThrough).
function settled(row: Transactions, today: LocalDate, through: LocalDate | null): boolean {
  const date = row.date as LocalDate
  return (
    !changeable(row) ||
    (compareDates(date, today) < 0 && through !== null && compareDates(date, through) <= 0)
  )
}

// The row without what other steps may still set on it.
function kept(row: Transactions): string {
  const { $updatedAt, $sequence, remindedAt, ...rest } = row as unknown as Record<string, unknown>
  return JSON.stringify(rest)
}

// Step 2 posts a past occurrence of a schedule that auto-posts (scheduling.md#step-2-auto-post):
// only its status changes, and a bill that names no payers records the creator as paying.
function autoPosted(was: Transactions, schedule: Schedules): Transactions {
  const input = JSON.parse(was.inputJson) as { payers?: unknown }
  const payers =
    was.kind === 'bill' && !input.payers
      ? [{ personId: schedule.createdBy, cents: was.totalCents }]
      : undefined
  return { ...was, status: 'posted', inputJson: JSON.stringify({ payers, ...input }) }
}

// The last day the schedule can fall on (scheduling.md#expanding-occurrences): the first of its
// endsOn, its rule's UNTIL and its COUNTth date, counted before exdates and holidays. Null when it
// never ends.
function endOf(schedule: Schedules): LocalDate | null {
  const startsOn = schedule.startsOn as LocalDate
  const parts = new Map(
    schedule.rrule.split(';').map((part) => part.split('=') as [string, string]),
  )
  const ends = schedule.endsOn ? [schedule.endsOn as LocalDate] : []
  const until = parts.get('UNTIL')
  if (until) ends.push(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}` as LocalDate)
  const count = Number(parts.get('COUNT') ?? 0)
  if (count > 0) {
    // The same rule without its COUNT. No rule here has more than 31 days between dates.
    const dates = expandSchedule(
      { rrule: schedule.rrule.replace(/;COUNT=\d+/, ''), startsOn, skipPublicHolidays: false },
      startsOn,
      addDays(startsOn, 31 * (count + 1)),
      () => false,
    )
    ends.push(dates[count - 1] as LocalDate)
  }
  return ends.sort(compareDates)[0] ?? null
}

const holidayCheckers = new Map<string, (date: LocalDate) => boolean>()

function holidaysIn(region: string): (date: LocalDate) => boolean {
  const checker = holidayCheckers.get(region) ?? publicHolidayChecker(region)
  holidayCheckers.set(region, checker)
  return checker
}

// The occurrence on `date` as step 1 makes it (scheduling.md#step-1-expand-due-schedules): kind,
// description, category, totalCents, inputJson and items from the template, and `scheduled`, or
// for a bill `due`, with dueOn its own date.
function occurrence(schedule: Schedules, date: LocalDate, ledger: Ledger) {
  const template = JSON.parse(schedule.templateJson) as TransactionTemplate
  const bill = schedule.kind === 'bill'
  const planned = plan(
    {
      ...template,
      kind: schedule.kind,
      date,
      ...(bill ? { bill: { ...template.bill, status: 'due' as const, dueOn: date } } : {}),
    },
    bill ? 'due' : 'scheduled',
    ledger,
    schedule.createdBy,
  )
  return {
    columns: {
      scheduleId: schedule.$id,
      groupId: schedule.groupId,
      kind: schedule.kind,
      status: planned.status,
      date,
      dueOn: bill ? date : null,
      description: schedule.description,
      category: template.category ?? null,
      totalCents: planned.totalCents,
      inputJson: planned.inputJson,
    },
    items: planned.items,
  }
}

const COLUMNS = [
  'scheduleId',
  'groupId',
  'kind',
  'status',
  'date',
  'dueOn',
  'description',
  'category',
  'totalCents',
  'inputJson',
] as const

function columnsOf(row: Transactions) {
  return Object.fromEntries(COLUMNS.map((column) => [column, row[column]]))
}

function itemsOf(items: Items[], transactionId: string) {
  return items
    .filter((item) => item.transactionId === transactionId)
    .sort((a, b) => a.position - b.position)
    .map(({ position, name, quantity, amountCents, category, splitJson }) => ({
      position,
      name,
      quantity,
      amountCents,
      category: category ?? null,
      splitJson,
    }))
}

// How many commits `request` makes, tried first on a copy of the database, so that a timeout can
// land on one it really reaches.
async function commitsOf(services: Fakes, request: Request): Promise<number> {
  const db = new FakeDb(
    Object.fromEntries(Object.values(TABLES).map((table) => [table, services.db.rows(table)])),
  )
  const commit = db.updateTransaction.bind(db)
  let commits = 0
  vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit) commits += 1
    return commit(params)
  })
  await request({ ...services, db })
  return commits
}

type Fault = { at: number; lands: boolean; short: boolean }

// Sends `request` with its fault: commit `at` times out, after it lands with `lands`; with
// `short`, the cron run's time is up after its first commit.
async function withFault(services: Fakes, request: Request, fault: Fault) {
  const commit = services.db.updateTransaction.bind(services.db)
  let commits = 0
  const spy = vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
    if (!params.commit) return commit(params)
    commits += 1
    if (commits !== fault.at) return commit(params)
    if (fault.lands) await commit(params)
    throw new Error('Timed out')
  })
  services.outOfTime = () => fault.short && commits >= 1
  try {
    return await request(services)
  } finally {
    spy.mockRestore()
    services.outOfTime = () => false
  }
}

// scheduling.md's promises after a step: no item is left without its transaction; a posted, voided
// or edited occurrence, or a past one the schedule had reached, is never changed or deleted (step 2
// may post one); and once the schedule isn't due, it has expanded as far as it should, and every
// changeable occurrence from where the step could reach is on its rule with its template.
async function check(
  services: Fakes,
  groupId: string,
  before: Transactions[],
  touched: Set<string>,
  reached: LocalDate | null,
  // A cron run may reach back to where the schedule had got to; an edit or end starts today.
  byCron: boolean,
): Promise<void> {
  const group = groupRow(services, groupId)
  const today = localToday(group.timezone, services.now)
  const all = rows(services)
  const byId = new Map(all.map((row) => [row.$id, row]))
  const items = services.db.rows('items') as unknown as Items[]
  for (const item of items) {
    expect(byId.has(item.transactionId), 'an item without its transaction').toBe(true)
  }
  const schedule = stored(services)
  for (const was of before) {
    if (!settled(was, today, reached) || touched.has(was.$id)) continue
    const row = byId.get(was.$id)
    expect(row, `${was.$id} was deleted`).toBeDefined()
    const posted =
      byCron &&
      schedule?.autoPost &&
      (was.status === 'scheduled' || was.status === 'due') &&
      row?.status === 'posted'
    const expected = posted && schedule ? autoPosted(was, schedule) : was
    if (row) expect(kept(row), `${was.$id} was changed`).toBe(kept(expected))
  }
  if (!schedule || isDue(schedule, services.now)) return

  // Once the schedule isn't due, it has expanded to its end or the horizon, whichever is first,
  // and has nothing more to do once that is its end (scheduling.md#step-1-expand-due-schedules).
  const through = schedule.generatedThrough as LocalDate | null
  if (through === null) throw new Error('A schedule that isn’t due has never expanded')
  const end = endOf(schedule)
  const horizon = addDays(today, schedule.horizonDays)
  const reach = end && compareDates(end, horizon) < 0 ? end : horizon
  expect(compareDates(through, reach) >= 0, `generatedThrough ${through} is before ${reach}`).toBe(
    true,
  )
  expect(schedule.nextRunAt === null, 'nextRunAt is empty once the end is reached').toBe(
    end !== null && compareDates(end, horizon) <= 0,
  )

  // And it is in line with its rule and template up to generatedThrough, from where this step
  // could reach: today, or earlier when the schedule hadn't got that far.
  const upTo = end && compareDates(end, through) < 0 ? end : through
  const startsOn = schedule.startsOn as LocalDate
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
          schedule.skipPublicHolidays ? holidaysIn(group.region) : () => false,
        )
      : []
  // By ID: an occurrence moved to another day still holds its date (scheduling.md#idempotency).
  const planned = new Map(dates.map((date) => [occurrenceId(ID, date), date]))
  for (const id of planned.keys()) expect(byId.has(id), `${id} is missing`).toBe(true)
  const ledger = await loadGroupLedger(services.db, group, schedule.createdBy)
  for (const row of all) {
    const date = row.date as LocalDate
    if (!changeable(row) || compareDates(date, window) < 0) continue
    // Later ones wait until the window reaches them, unless they are after the end.
    if (compareDates(date, through) > 0 && !(end && compareDates(date, end) > 0)) continue
    const on = planned.get(row.$id)
    if (!on) throw new Error(`${row.$id} is not on the rule`)
    const expected = occurrence(schedule, on, ledger)
    expect(columnsOf(row), `${row.$id} has an old template`).toEqual(expected.columns)
    expect(itemsOf(items, row.$id), `${row.$id} has old items`).toEqual(expected.items)
  }
}

describe('reconcile, under random edits, ends, runs and timeouts', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(Array.from({ length: SEEDS }, (_, index) => index + 1))('seed %i', async (seed) => {
    const random = generator(seed)
    const services = seeded()
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow(services, services.now)
    // Every other seed has a bill instead of a shift.
    const kind = seed % 2 === 0 ? 'bill' : 'shift'
    const groupId = kind === 'bill' ? 'elm' : 'acme'
    const steps: string[] = []
    // Set while a timeout or a run that ran out of time has left the schedule due.
    let unfinished = false
    for (let step = 0; step < STEPS; step++) {
      const before = rows(services)
      const schedule = stored(services)
      const reached = (schedule?.generatedThrough ?? null) as LocalDate | null
      const today = localToday(groupRow(services, groupId).timezone, services.now)
      const touched = new Set<string>()
      // After a timeout or a run that ran out of time, the next hourly run usually comes first.
      const action = !schedule ? 0 : unfinished && random(3) !== 0 ? 2 + random(3) : random(7)
      const cron = action >= 2 && action <= 4
      try {
        let request: Request | undefined
        let label = ''
        if (action === 0) {
          const input = schedule
            ? editedSchedule(random, kind, today, schedule)
            : newSchedule(random, kind, today)
          const method = schedule ? 'PATCH' : 'POST'
          const path = schedule ? `/schedules/${ID}` : '/schedules'
          request = (on) => call(on, method, path, { body: input })
          label = `${method} ${JSON.stringify(input)}`
        } else if (action === 1) {
          const startsOn = schedule?.startsOn as LocalDate
          const day = addDays(today, random(150) - 30)
          const body = { endsOn: compareDates(day, startsOn) < 0 ? startsOn : day }
          request = (on) => call(on, 'POST', `/schedules/${ID}/end`, { body })
          label = `END ${body.endsOn}`
        } else if (cron) {
          // A later day, now and then after an outage of weeks, or the same hour again.
          if (action < 4) {
            const days = random(5) === 0 ? 14 + random(28) : 1 + random(10)
            setNow(services, new Date(services.now.getTime() + days * DAY_MS))
          }
          request = (on) => call(on, 'POST', '/', { userId: null, scheduled: true })
          label = `CRON at ${services.now.toISOString()}`
        }
        if (request) {
          // One request in three times out at one of the commits it makes, before or after the
          // commit lands. One cron run in two is out of time after its first commit, which is
          // step 1's first batch when the schedule is due, so the next run must carry on from
          // the progress saved.
          const commits = !cron && random(3) === 0 ? await commitsOf(services, request) : 0
          const fault: Fault = {
            at: commits > 0 ? 1 + random(commits) : 0,
            lands: random(2) === 0,
            short: cron && random(2) === 0,
          }
          const { status, body } = await withFault(services, request, fault)
          const after = stored(services)
          unfinished =
            (fault.at > 0 || fault.short) && after !== undefined && isDue(after, services.now)
          const note =
            fault.at > 0
              ? ` (timed out at commit ${fault.at} of ${commits}${fault.lands ? ', after it landed' : ''})`
              : fault.short
                ? ' (out of time after its first commit)'
                : ''
          steps.push(`${label}${note} → ${status}${cron ? ` ${JSON.stringify(body)}` : ''}`)
          expect(status, 'status').toBe(fault.at > 0 ? 500 : 200)
          if (cron) {
            const result = body.ok ? (body.data as RunResult) : undefined
            expect(result?.expanded.failed, 'expanded.failed').toBe(0)
          }
          // Without a fault a POST, a PATCH and a cron run finish the expansion; an end leaves
          // the rest to the next run.
          if (after && fault.at === 0 && !fault.short) {
            expect(isDue(after, services.now), 'due').toBe(action === 1)
          }
        } else {
          const open = rows(services).filter(changeable)
          const row = open[random(Math.max(1, open.length))]
          if (row) {
            const moved = addDays(
              row.date as LocalDate,
              (1 + random(3)) * (random(2) === 0 ? 1 : -1),
            )
            const changes: Record<string, unknown>[] = [
              { overridden: true, description: 'Edited' },
              { overridden: true, date: moved, ...(row.kind === 'bill' ? { dueOn: moved } : {}) },
              { status: 'void', voidReason: 'Sick' },
              { status: 'posted' },
              // Posted early or late, on another day.
              { status: 'posted', date: moved },
            ]
            const change = changes[random(changes.length)] as Record<string, unknown>
            await withTransaction(services.db, (tx) =>
              tx.write({ action: 'update', tableId: 'transactions', rowId: row.$id, data: change }),
            )
            touched.add(row.$id)
            steps.push(`MANUAL ${row.$id} ${JSON.stringify(change)}`)
          }
        }
        await check(services, groupId, before, touched, reached, cron)
      } catch (error) {
        throw new Error(`${(error as Error).message}\nafter:\n${steps.join('\n')}`)
      }
    }
  })
})
