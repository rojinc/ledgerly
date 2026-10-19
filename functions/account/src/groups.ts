import { addDays, compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type {
  Groups,
  Members,
  Persons,
  Schedules,
  Statements,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { everyPersonId, type TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { othersInTeam, removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { leftOnTheirOwn } from '@ledgerly/server/auth/left-on-their-own'
import { randomId } from '@ledgerly/server/identity/random-id'
import { guardGroup, Raced } from '@ledgerly/server/ledger/transactions'
import {
  deleteScheduleRows,
  endScheduleOn,
  hasOccurrence,
  laterOf,
} from '@ledgerly/server/scheduler/end-schedule'
import { ID, Permission, Query, Role } from 'node-appwrite'
import { FORMER_MEMBER, getRowOrNull, isAppwriteError } from './rows'
import type { Services } from './services'

/** A person past the point of no return (step 2). */
export type Deleting = Persons & { deletedAt: string }

/**
 * Step 4 (identity-and-invites.md#each-group-they-joined): every group where the person's member
 * row is `active` or `left`, one at a time, until the time budget is used up. Groups where they
 * never joined are left exactly as they are (D-016). True once every group is done, one they
 * joined meanwhile included.
 */
export async function leaveGroups(
  services: Services,
  userId: string,
  person: Deleting,
): Promise<boolean> {
  const members = await joinedRows(services.db, person.$id)
  let finished = true
  for (const member of members) {
    if (services.outOfTime()) return false
    if (!(await leaveGroup(services, userId, person, member))) finished = false
  }
  if (!finished) return false
  // Listed once more: a row that a join or a new group committed after the list above is left
  // for the next run, so steps 5–7 never start with a group still to do. Every listed row is
  // done, whatever happened to it since (an admin may rename a "Former member").
  const listed = new Set(members.map((member) => member.$id))
  return (await joinedRows(services.db, person.$id)).every((member) => listed.has(member.$id))
}

// Their `active` and `left` member rows (idx_person_status). Paged by $id: a purge deletes
// member rows.
function joinedRows(db: Db, personId: string): Promise<Members[]> {
  return allRows<Members>(db, TABLES.members, [
    Query.equal('personId', personId),
    Query.equal('status', ['active', 'left']),
  ])
}

// One group. False when it's left for the next run: it needs a purge, a statement in it is being
// finalized, or something changed it meanwhile. A rerun never decides again: the group's state
// says how it carries on, never the team as it is by then.
async function leaveGroup(
  services: Services,
  userId: string,
  person: Deleting,
  member: Members,
): Promise<boolean> {
  const { db, teams } = services
  try {
    const others = await othersInTeam(teams, member.groupId, userId)
    // The team is gone: a purge was started, and carries on. Purges are #50 PR-2.
    if (others === null) return false
    const group = await getRowOrNull<Groups>(db, TABLES.groups, member.groupId)
    if (!group) return false
    if (!(await isKept(db, person, member))) {
      // Nobody else is in the team, as in their personal group: it's purged (#50 PR-2), so
      // until then it waits, untouched.
      if (!others) return false
      await keep(services, person, member, group)
    }
    // Then, in this order, on every run once the keep is done (each is safe to repeat): their
    // schedules, the archive (ending a schedule in an archived group is refused), and leaving
    // the team last, so a crash before it leaves the group to be finished, never with its
    // schedules still running.
    if (!group.archivedAt) {
      if (!(await endSchedules(services, person.$id, group))) return false
      if (!(await hasJoinedAdmin(db, group.$id))) await archive(services, person.$id, group)
    }
    await removeFromTeam(teams, group.$id, userId)
    return true
  } catch (error) {
    if (error instanceof Raced || isAppwriteError(error, 409)) return false
    throw error
  }
}

// Whether the keep's transaction is done: the row shows its own write, and their own member.left
// is dated on or after deletedAt. A row they left on their own, before or after step 2, still
// has their name, so it gets the keep.
async function isKept(db: Db, person: Deleting, member: Members): Promise<boolean> {
  return (
    member.status === 'left' &&
    member.displayName === FORMER_MEMBER &&
    member.role === 'viewer' &&
    (await leftOnTheirOwn(db, member.groupId, person.$id, person.deletedAt))
  )
}

// The keep's transaction, with a fresh group `rev`: their member row becomes "Former member",
// `left` and `viewer`, with `leftOn` set as leaving sets it if it's empty, so `days` bills stop
// counting them; and a member.left by them that names no one, so the row counts as leaving on
// their own (permissions.md#leaving-a-group).
async function keep(
  { db, now }: Services,
  person: Deleting,
  member: Members,
  group: Groups,
): Promise<void> {
  const today = localToday(group.timezone, now)
  await withTransaction(db, async (tx) => {
    // Also checks the time zone `today` comes from.
    await guardGroup(tx, db, group)
    await tx.write({
      action: 'update',
      tableId: TABLES.members,
      rowId: member.$id,
      data: {
        displayName: FORMER_MEMBER,
        status: 'left',
        role: 'viewer',
        // Never before joinedOn.
        leftOn: member.leftOn ?? laterOf(today, member.joinedOn as LocalDate),
        rev: randomId(),
      },
    })
    // Stage, then check (conventions.md#functions): the stored row, not this transaction's
    // view. `leftOn` came from the dates read first, so they must still hold too.
    const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
    if (
      current?.personId !== person.$id ||
      current.status !== member.status ||
      current.joinedOn !== member.joinedOn ||
      current.leftOn !== member.leftOn
    ) {
      throw new Raced()
    }
    // data-model.md#activity: the app shows the subject's current name ("Former member").
    await tx.write({
      action: 'create',
      tableId: TABLES.activity,
      rowId: ID.unique(),
      data: {
        groupId: group.$id,
        actorPersonId: person.$id,
        action: 'member.left',
        subjectPersonId: person.$id,
        summary: 'left',
        at: now.toISOString(),
      },
      permissions: [Permission.read(Role.team(group.$id))],
    })
  })
}

// The schedules in the group that they created, or whose template names them, end on the
// earlier of their stored end and today, so no new occurrence names a deleted person. One that
// hasn't started and has nothing posted is deleted instead, as it would otherwise end before
// it starts. False when the time budget runs out first.
async function endSchedules(
  { db, now, outOfTime }: Services,
  personId: string,
  group: Groups,
): Promise<boolean> {
  const today = localToday(group.timezone, now)
  // idx_groupId
  const schedules = await allRows<Schedules>(db, TABLES.schedules, [
    Query.equal('groupId', group.$id),
  ])
  for (const schedule of schedules) {
    if (outOfTime()) return false
    if (schedule.createdBy !== personId && !namedIn(schedule).includes(personId)) continue
    const storedEnd = schedule.endsOn as LocalDate | null
    const generated = schedule.generatedThrough as LocalDate | null
    // Already ended by today, made up to its end and with nothing left for an end to delete:
    // nothing to do, so a rerun doesn't write it again. An end cut off before its deletes (a
    // crash, or `Raced`) runs again, as an archive would leave them for good.
    if (
      storedEnd &&
      compareDates(storedEnd, today) <= 0 &&
      generated &&
      compareDates(generated, storedEnd) >= 0 &&
      !(await hasOccurrence(db, schedule.$id, [
        Query.equal('status', ['scheduled', 'due']),
        Query.equal('overridden', false),
        Query.greaterThanEqual(
          'date',
          compareDates(storedEnd, today) < 0 ? today : addDays(today, 1),
        ),
      ]))
    ) {
      continue
    }
    if (
      compareDates(schedule.startsOn as LocalDate, today) > 0 &&
      !(await hasOccurrence(db, schedule.$id, [Query.equal('status', 'posted')]))
    ) {
      await deleteScheduleRows(db, group, schedule.$id, now)
      continue
    }
    const endsOn = storedEnd && compareDates(storedEnd, today) < 0 ? storedEnd : today
    await endScheduleOn(db, group, schedule, endsOn, now)
  }
  return true
}

// The persons a schedule's template names, read as the scheduler reads it (not re-validated, so
// a template an older schema allowed still counts). One that can't be read names nobody, so the
// schedule is still ended if they created it, and one bad row doesn't stop every run.
function namedIn(schedule: Schedules): string[] {
  try {
    return everyPersonId(JSON.parse(schedule.templateJson) as TransactionTemplate)
  } catch {
    console.error(`account: schedule ${schedule.$id} has a template that can't be read`)
    return []
  }
}

// Whether the group still has a joined admin. A kept group without one (an employer or pair
// group where they were the only one, or a house where nobody else could be one) is archived.
async function hasJoinedAdmin(db: Db, groupId: string): Promise<boolean> {
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('role', 'admin'),
      Query.equal('status', 'active'),
      Query.limit(1),
    ],
    total: false,
  })
  return rows.length > 0
}

// Archives the group, with a group.archived row by them, as an admin's archive writes, so the
// others see why. One archived meanwhile, with a statement being finalized, or with a timer
// someone else started still running (it couldn't be stopped once archived) throws `Raced`: the
// group is left for the next run, which finds it archived, or waits until the finalize ends or
// the timer stops. A finalize stuck for an hour is never waited for: see `isStuck`.
async function archive({ db, now }: Services, personId: string, group: Groups): Promise<void> {
  const finalizing = await finalizingStatement(db, group.$id)
  if (finalizing && isStuck(finalizing, now)) {
    console.error(`account: group ${group.$id} not archived: statement ${finalizing.$id} is stuck`)
    return
  }
  await withTransaction(db, async (tx) => {
    await tx.write({
      action: 'update',
      tableId: TABLES.groups,
      rowId: group.$id,
      // The statements cron selects groups by nextCloseAt, so an archived group leaves it.
      data: { archivedAt: now.toISOString(), nextCloseAt: null },
    })
    // Stage, then check: finalize step 1 stages the group row in the transaction that sets
    // `finalizing` (statements.md#2-finalize-post-statementsidfinalize).
    const current = await getRowOrNull<Groups>(db, TABLES.groups, group.$id)
    if (
      current?.archivedAt ||
      (await finalizingStatement(db, group.$id)) ||
      (await othersTimerRunning(db, group.$id, personId))
    ) {
      throw new Raced()
    }
    await tx.write({
      action: 'create',
      tableId: TABLES.activity,
      rowId: ID.unique(),
      data: {
        groupId: group.$id,
        actorPersonId: personId,
        action: 'group.archived',
        summary: 'Archived the group',
        at: now.toISOString(),
      },
      permissions: [Permission.read(Role.team(group.$id))],
    })
  })
}

/** A statement of the group that is `finalizing` (`idx_group_period`), or null. */
export async function finalizingStatement(db: Db, groupId: string): Promise<Statements | null> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', groupId), Query.equal('status', 'finalizing'), Query.limit(1)],
    total: false,
  })
  return rows[0] ?? null
}

// A finalize that hasn't written its statement for an hour has stopped (a crash), and only an
// admin can resume it. Step 1 refuses while they're the only joined admin of a group with a
// finalizing statement, so a stuck one here began after it, and nobody left can finish it. The
// group stays unarchived (archiving would refuse the resume for good), with its ID logged, and
// the deletion carries on: the statements cron starts nothing new for a group with a
// finalizing statement, so not archiving it costs nothing.
function isStuck(statement: Statements, now: Date): boolean {
  return now.getTime() - Date.parse(statement.$updatedAt) > STUCK_FINALIZE_MS
}

const STUCK_FINALIZE_MS = 60 * 60 * 1000

// Whether a timer that someone else started is running in the group (`idx_group_status_date`).
// A timer start guards the group row, so one that commits after this read fails the archive's
// commit, as in `groups POST /groups/{id}/archive`. Their own doesn't count: step 1 refused one,
// so it can only have started in the moment before step 2.
async function othersTimerRunning(db: Db, groupId: string, personId: string): Promise<boolean> {
  const { rows } = await db.listRows<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('status', 'running'),
      Query.notEqual('createdBy', personId),
      Query.limit(1),
    ],
    total: false,
  })
  return rows.length > 0
}
