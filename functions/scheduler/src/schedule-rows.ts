import { compareDates, daysBetween, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Schedules } from '@ledgerly/core/generated/rows'
import type { ScheduleInput } from '@ledgerly/core/schemas/scheduler'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { type Membership, requireMemberOf } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { refuseDeletedCreator, refuseDeletedPeople } from '@ledgerly/server/ledger/deleted-people'
import { guardGroupAndMembers, type Ledger, loadLedger } from '@ledgerly/server/ledger/transactions'
import { guardSchedule } from '@ledgerly/server/scheduler/end-schedule'
import { AppwriteException } from 'node-appwrite'
import { planOccurrence, type ScheduleTemplate } from './occurrences'
import type { Services } from './services'

/** A schedule's own columns, as `POST` and `PATCH /schedules` store them. */
export function scheduleColumns(input: Omit<ScheduleInput, 'id' | 'groupId'>) {
  return {
    kind: input.kind,
    description: input.description,
    templateJson: JSON.stringify(input.template),
    rrule: input.rrule,
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
    exdates: input.exdates ?? null,
    skipPublicHolidays: input.skipPublicHolidays,
    autoPost: input.autoPost,
    // data-model.md#schedules: the column's default.
    horizonDays: input.horizonDays ?? 56,
  }
}

const NO_SUCH_SCHEDULE = 'There is no such schedule.'

/** The schedule, or NOT_FOUND (a DELETE may have got there first). */
export async function getSchedule(db: Db, scheduleId: string): Promise<Schedules> {
  const schedule = await findSchedule(db, scheduleId)
  if (!schedule) throw new AppError('NOT_FOUND', NO_SUCH_SCHEDULE)
  return schedule
}

export async function findSchedule(db: Db, scheduleId: string): Promise<Schedules | undefined> {
  try {
    return await db.getRow<Schedules>({
      databaseId: DATABASE_ID,
      tableId: TABLES.schedules,
      rowId: scheduleId,
    })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}

/**
 * The schedule and the caller's membership, for `PATCH`, `end` and `DELETE`: its creator or an
 * admin of its group (functions-api.md#scheduler). Viewers can't change schedules
 * (permissions.md#roles). Someone who isn't a member gets NOT_FOUND, the same as for an ID that
 * doesn't exist, so schedule IDs can't be probed (#121).
 */
export async function requireScheduleWriter(
  services: Services,
  userId: string | null,
  scheduleId: string,
): Promise<{ schedule: Schedules; membership: Membership }> {
  const schedule = await getSchedule(services.db, scheduleId)
  const membership = await requireMemberOf(
    services.db,
    services.teams,
    userId,
    schedule.groupId,
    NO_SUCH_SCHEDULE,
    { roles: ['admin', 'member'] },
  )
  if (membership.member.role !== 'admin' && schedule.createdBy !== membership.person.$id) {
    throw new AppError('FORBIDDEN', 'Only its creator or an admin can change this schedule.')
  }
  return { schedule, membership }
}

/**
 * Checks a template against the ledger rules (members, sums, signs) with a trial occurrence on
 * `startsOn`, so a schedule that could never post is refused when it's made, not hours later.
 * Returns everyone the template names, whose member rows the write must guard.
 */
export function checkTemplate(
  schedule: ScheduleTemplate & Pick<Schedules, 'startsOn'>,
  ledger: Ledger,
): string[] {
  return planOccurrence(schedule, schedule.startsOn as LocalDate, ledger).planned.people
}

/**
 * Saves `changes`, which make the schedule expand again from `today`, for `PATCH` and `resume`
 * (scheduling.md#schedule-routes). The template, as it will be, must fit the ledger (a trial on
 * `startsOn`) and name nobody who deleted their account (a trial on the first day it can make an
 * occurrence). In one transaction with the schedule, group and named members' guards. Returns
 * the ledger, for the expansion.
 */
export async function saveToExpand(
  db: Db,
  membership: Membership,
  schedule: Schedules,
  changes: Partial<Schedules>,
  today: LocalDate,
): Promise<Ledger> {
  const next = { ...schedule, ...changes }
  const ledger = await loadLedger(db, membership)
  const people = checkTemplate(next, ledger)
  // Deleted people (functions-api.md#ledger): a trial on the first day this can make an
  // occurrence.
  const startsOn = next.startsOn as LocalDate
  const firstDay = compareDates(startsOn, today) > 0 ? startsOn : today
  const named = planOccurrence(next, firstDay, ledger).planned.people
  await withTransaction(db, async (tx) => {
    await guardSchedule(tx, db, schedule, changes)
    // The people the template names stay members while it exists (ledger.md#concurrency).
    await guardGroupAndMembers(tx, db, membership.group, ledger, people)
    // Deleting their account ended the schedules they made or that name them, and this could
    // start one again (functions-api.md#ledger). The creator is checked, and guarded, first;
    // then the whole template, also people it named already.
    await refuseDeletedCreator(tx, db, schedule.createdBy)
    await refuseDeletedPeople(tx, db, ledger, {
      kind: next.kind,
      people: named.filter((personId) => personId !== schedule.createdBy),
      guard: true,
    })
  })
  return ledger
}

// A new schedule's past occurrences are made at once and wait for the user, so a start date is at
// most this many days ago: a mistyped year can't make years of them.
const MAX_DAYS_BACK = 31

/**
 * VALIDATION_FAILED for a `startsOn` more than 31 days before today in the group's time zone, on
 * `POST /schedules` and a `PATCH` that changes it (scheduling.md#schedule-routes).
 */
export function requireRecentStart(startsOn: LocalDate, group: Groups, now: Date): void {
  if (daysBetween(startsOn, localToday(group.timezone, now)) > MAX_DAYS_BACK) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The start date can be at most ${MAX_DAYS_BACK} days ago.`,
    )
  }
}
