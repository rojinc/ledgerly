import {
  REAUTH_WINDOW_MINUTES,
  RECENT_PASSWORD_CHANGE_HOURS,
} from '@ledgerly/core/constants/limits'
import type {
  Groups,
  Identities,
  Invites,
  Members,
  Persons,
  Profiles,
  Transactions,
} from '@ledgerly/core/generated/rows'
import {
  type DeleteAccountRefusal,
  type DeleteAccountResult,
  deleteAccountBodySchema,
} from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction, writeInBatches } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { Query } from 'node-appwrite'
import { type Deleting, leaveGroups } from '../groups'
import { parseBody } from '../parse-body'
import { doneIfGone, FORMER_MEMBER, getRowOrNull, isAppwriteError, personsOfUser } from '../rows'
import type { Services, UsersApi } from '../services'

// The Appwrite label of a user whose account is being deleted; bootstrap refuses them.
const DELETED_LABEL = 'deleted'
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE

/**
 * `account POST /delete` (identity-and-invites.md#deleting-an-account-m4). The refusals change
 * nothing. After step 2, the point of no return, every step runs to the end and can be repeated:
 * a call once `deletedAt` is set skips the checks (apart from the body) and carries on. Stops
 * between steps and groups once the time budget is used up; `finished: false` leaves the rest to
 * the hourly job. Purging a group nobody else is in comes with #50 PR-2, so until then such a
 * group (every personal group) waits untouched, and so do steps 5–7.
 */
export async function deleteAccount(
  services: Services,
  userId: string,
  sessionId: string | null,
  body: unknown,
): Promise<DeleteAccountResult> {
  parseBody(deleteAccountBodySchema, body)
  const persons = await personsOfUser(services.db, userId)
  // The one being deleted, if a bootstrap that raced step 2 made another (step 7).
  const person = persons.find((row) => row.deletedAt) ?? persons[0]
  if (!person) throw new AppError('NOT_FOUND', 'Set up your account first.')
  if (!person.deletedAt) await refuse(services, userId, sessionId, person.$id)
  const deleting = person.deletedAt ? (person as Deleting) : await markDeleted(services, person)
  return { deletedAt: deleting.deletedAt, finished: await finish(services, userId, deleting) }
}

// Step 1, in order; each refusal changes nothing.
async function refuse(
  { db, users, now }: Services,
  userId: string,
  sessionId: string | null,
  personId: string,
): Promise<void> {
  // A stolen session that's been open a while can't delete the account. Fails closed: no
  // session ID, a session Appwrite doesn't return, or a date that doesn't parse.
  const session = sessionId
    ? (await users.listSessions({ userId })).sessions.find((found) => found.$id === sessionId)
    : undefined
  const age = session ? now.getTime() - Date.parse(session.$createdAt) : Number.NaN
  if (!(age <= REAUTH_WINDOW_MINUTES * MS_PER_MINUTE)) {
    throw forbidden('Sign in again to delete your account.', { reason: 'reauth' })
  }
  // Nor can one that set a first password, then signed in again. Never set: no date.
  const user = await users.get({ userId })
  if (
    now.getTime() - Date.parse(user.passwordUpdate) <
    RECENT_PASSWORD_CHANGE_HOURS * MS_PER_HOUR
  ) {
    throw forbidden('Your password changed in the last day. Try again later.', {
      reason: 'recent_password_change',
    })
  }
  if (await hasRunningTimer(db, personId)) {
    throw new AppError('CONFLICT', 'A timer is running. Stop or void it first.')
  }
  const groupIds = await housesToHandOver(db, personId)
  if (groupIds.length > 0) {
    const details: DeleteAccountRefusal = { groupIds }
    throw new AppError('VALIDATION_FAILED', 'Make someone else an admin first.', details)
  }
}

function forbidden(message: string, details: DeleteAccountRefusal): AppError {
  return new AppError('FORBIDDEN', message, details)
}

// A timer running in a group that isn't archived (`idx_status_date`: few rows are ever running).
// One left in an archived group can't be stopped, and doesn't count.
async function hasRunningTimer(db: Db, personId: string): Promise<boolean> {
  const running = await allRows<Transactions>(db, TABLES.transactions, [
    Query.equal('status', 'running'),
    Query.equal('createdBy', personId),
  ])
  for (const row of running) {
    const group = await getRowOrNull<Groups>(db, TABLES.groups, row.groupId)
    if (group && !group.archivedAt) return true
  }
  return false
}

// Houses that aren't archived where they're the only joined admin and another member is
// `active`, who could be made admin: the rule leaving uses (permissions.md#leaving-a-group).
async function housesToHandOver(db: Db, personId: string): Promise<string[]> {
  // idx_person_status
  const adminRows = (
    await allRows<Members>(db, TABLES.members, [
      Query.equal('personId', personId),
      Query.equal('status', 'active'),
    ])
  ).filter((member) => member.role === 'admin')
  const groupIds: string[] = []
  for (const { groupId } of adminRows) {
    const group = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
    if (group?.type !== 'house' || group.archivedAt) continue
    // idx_groupId
    const others = (
      await allRows<Members>(db, TABLES.members, [Query.equal('groupId', groupId)])
    ).filter((member) => member.personId !== personId && member.status === 'active')
    if (others.length > 0 && !others.some((member) => member.role === 'admin')) {
      groupIds.push(groupId)
    }
  }
  return groupIds
}

// Step 2, the point of no return: `deletedAt` and "Former member", with a fresh `rev` (a guard
// write, ledger.md#concurrency). A deletion that got there first keeps its `deletedAt`.
async function markDeleted({ db, now }: Services, person: Persons): Promise<Deleting> {
  const deletedAt = now.toISOString()
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: person.$id,
        data: { deletedAt, displayName: FORMER_MEMBER, rev: randomId() },
      })
      // Stage, then check: the stored row, not this transaction's view.
      const stored = await getRowOrNull<Persons>(db, TABLES.persons, person.$id)
      if (stored?.deletedAt || stored?.userId !== person.userId) throw new Raced()
    })
    return { ...person, deletedAt, displayName: FORMER_MEMBER }
  } catch (error) {
    const stored = await getRowOrNull<Persons>(db, TABLES.persons, person.$id)
    if (stored?.deletedAt && stored.userId === person.userId) return stored as Deleting
    // Nothing changed, as for a refusal: an invite's guard write, say, got there first.
    if (error instanceof Raced || isAppwriteError(error, 409)) {
      throw new AppError('CONFLICT', 'Something else changed this at the same time. Try again.')
    }
    throw error
  }
}

// Steps 3–7. True once the account is gone.
async function finish(services: Services, userId: string, person: Deleting): Promise<boolean> {
  const { db, users, outOfTime } = services
  await lockOut(users, userId)
  if (!(await leaveGroups(services, userId, person))) return false
  if (outOfTime()) return false
  await deleteOwnRows(db, userId, person.$id)
  if (outOfTime()) return false
  // Step 6 comes before step 7: Appwrite user IDs are chosen at sign-up, so someone who signs up
  // with this one later must not find a person to bootstrap into.
  await withTransaction(db, (tx) =>
    tx.write({
      action: 'update',
      tableId: TABLES.persons,
      rowId: person.$id,
      data: { userId: null },
      permissions: [],
    }),
  )
  if (outOfTime()) return false
  // Step 7 looks again just before: a bootstrap that committed after step 2 made a person of its
  // own, which is purged (#50 PR-2) before the user goes, so no person is left naming the ID.
  if ((await personsOfUser(db, userId)).some((other) => !other.deletedAt)) return false
  await doneIfGone(() => users.delete({ userId }))
  return true
}

// Step 3: labelled `deleted`, blocked and signed out everywhere, so an old JWT fails
// `account.get()`. A user who is already gone is done.
async function lockOut(users: UsersApi, userId: string): Promise<void> {
  await doneIfGone(async () => {
    const user = await users.get({ userId })
    if (!user.labels.includes(DELETED_LABEL)) {
      await users.updateLabels({ userId, labels: [...user.labels, DELETED_LABEL] })
    }
    if (user.status) await users.updateStatus({ userId, status: false })
    await users.deleteSessions({ userId })
  })
}

// Step 5, once every group is done: their identities, the invites they sent and their profile
// (business details included).
async function deleteOwnRows(db: Db, userId: string, personId: string): Promise<void> {
  // idx_personId, idx_invitedBy_sentAt
  const identities = await allRows<Identities>(db, TABLES.identities, [
    Query.equal('personId', personId),
  ])
  const invites = await allRows<Invites>(db, TABLES.invites, [Query.equal('invitedBy', personId)])
  const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
  await writeInBatches(db, [
    ...identities.map((row) => ({
      action: 'delete' as const,
      tableId: TABLES.identities,
      rowId: row.$id,
    })),
    ...invites.map((row) => ({
      action: 'delete' as const,
      tableId: TABLES.invites,
      rowId: row.$id,
    })),
    ...(profile ? [{ action: 'delete' as const, tableId: TABLES.profiles, rowId: userId }] : []),
  ])
}
