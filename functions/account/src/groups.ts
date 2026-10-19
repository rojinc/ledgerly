import { compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Persons, Schedules, Statements } from '@ledgerly/core/generated/rows'
import { everyPersonId, type TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { isInTeam, othersInTeam, removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { leftOnTheirOwn } from '@ledgerly/server/auth/left-on-their-own'
import { randomId } from '@ledgerly/server/identity/random-id'
import { guardGroup, Raced } from '@ledgerly/server/ledger/transactions'
import { endScheduleOn, laterOf } from '@ledgerly/server/scheduler/end-schedule'
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
    // Their own member.left since deletedAt: the keep's transaction is done.
    if (
      member.status === 'left' &&
      (await leftOnTheirOwn(db, group.$id, person.$id, person.deletedAt))
    ) {
      if (!(await isInTeam(teams, group.$id, userId))) return true
    } else {
      // Nobody else is in the team, as in their personal group: it's purged (#50 PR-2), so
      // until then it waits, untouched.
      if (!others) return false
      await keep(services, person, member, group)
    }
    // Then, in this order: their schedules, the archive (ending a schedule in an archived group
    // is refused), and leaving the team last, so a crash before it leaves the group to be
    // finished, never with its schedules still running.
    if (!group.archivedAt) {
      await endSchedules(services, person.$id, group)
      if (!(await hasJoinedAdmin(db, group.$id))) await archive(services, person.$id, group)
    }
    await removeFromTeam(teams, group.$id, userId)
    return true
  } catch (error) {
    if (error instanceof Raced || isAppwriteError(error, 409)) return false
    throw error
  }
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
// earlier of their stored end and today, so no new occurrence names a deleted person.
async function endSchedules({ db, now }: Services, personId: string, group: Groups): Promise<void> {
  const today = localToday(group.timezone, now)
  // idx_groupId
  const schedules = await allRows<Schedules>(db, TABLES.schedules, [
    Query.equal('groupId', group.$id),
  ])
  for (const schedule of schedules) {
    const template = JSON.parse(schedule.templateJson) as TransactionTemplate
    if (schedule.createdBy !== personId && !everyPersonId(template).includes(personId)) continue
    const storedEnd = schedule.endsOn as LocalDate | null
    const endsOn = storedEnd && compareDates(storedEnd, today) < 0 ? storedEnd : today
    await endScheduleOn(db, group, schedule, endsOn, now)
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
// others see why. One archived meanwhile, or with a statement being finalized, throws `Raced`:
// the group is left for the next run, which finds it archived, or waits until the finalize ends.
async function archive({ db, now }: Services, personId: string, group: Groups): Promise<void> {
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
    if (current?.archivedAt || (await isFinalizing(db, group.$id))) throw new Raced()
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

// Whether any statement of the group is `finalizing` (`idx_group_period`).
async function isFinalizing(db: Db, groupId: string): Promise<boolean> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', groupId), Query.equal('status', 'finalizing'), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}
