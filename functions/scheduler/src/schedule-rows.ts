import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Schedules } from '@ledgerly/core/generated/rows'
import type { ScheduleInput } from '@ledgerly/core/schemas/scheduler'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Membership, requireMemberOf } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import type { Ledger } from '@ledgerly/server/ledger/transactions'
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
