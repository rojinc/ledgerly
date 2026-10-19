import type {
  Items,
  Members,
  Persons,
  Schedules,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import { everyPersonId, type TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { addToTeam, isInTeam, removeFromTeam, type TeamsApi } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { type Models, Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getMemberOf,
  getRowOrNull,
  hasShares,
  invalid,
  joinedAdmins,
  keepAnotherAdmin,
  parseBody,
  tryAgain,
} from '../shared'

const HAS_SHARES = "Members with transactions can't be removed. Set leftOn instead."
const IS_NAMED =
  "This person is named in a transaction that isn't posted yet, or in a schedule. Set leftOn instead."
const NEEDS_ADMIN = 'The group needs at least one admin who has joined.'
const TWO_MEMBERS = 'Employer and pair groups always keep both members. Archive the group instead.'

/**
 * `groups DELETE /groups/{id}/members/{memberId}`: removes someone completely, only while they
 * have no shares in the group and aren't named in an unposted transaction or a schedule's
 * template (permissions.md#leaving-a-group), team membership first.
 */
export async function deleteMember(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  memberId: string,
  body: unknown,
): Promise<Record<string, never>> {
  parseBody(emptyBodySchema, body ?? {})
  const { person: caller, group } = await requireMember(db, teams, userId, groupId, {
    roles: ['admin'],
  })
  if (group.type === 'employer' || group.type === 'pair') throw invalid(TWO_MEMBERS)
  if (group.type === 'personal') throw invalid('A personal group always keeps its only member.')
  const member = await getMemberOf(db, groupId, memberId)
  // Checked early so a refusal leaves the team alone; checked again in the transaction.
  if (await hasShares(db, groupId, member.personId)) throw invalid(HAS_SHARES)
  if (await isNamed(db, groupId, member.personId)) throw invalid(IS_NAMED)
  const joinedAdmin = member.role === 'admin' && member.status === 'active'
  if (joinedAdmin && !(await joinedAdmins(db, groupId)).some((a) => a.$id !== member.$id)) {
    throw invalid(NEEDS_ADMIN)
  }
  // Fail closed: take away read access before the row goes. A placeholder is never in the team
  // (D-016), so Teams isn't touched for one, which also keeps whether it has an account hidden.
  // If the removal then fails, the member gets their access back.
  const removedUserId =
    member.status === 'placeholder' ? null : await leaveTeam(db, teams, groupId, member.personId)
  try {
    await conflictAsTryAgain(() =>
      withTransaction(db, async (tx) => {
        await tx.write({ action: 'delete', tableId: TABLES.members, rowId: memberId })
        // Stage, then check (conventions.md): from here on, any change to the row fails the
        // commit. Read the stored row, not this transaction's view, where it is gone.
        if (await hasShares(db, groupId, member.personId)) throw invalid(HAS_SHARES)
        if (await isNamed(db, groupId, member.personId)) throw invalid(IS_NAMED)
        // A placeholder who joined after the first read gets CONFLICT; the retry sees them
        // active and takes them out of the team.
        const current = await getRowOrNull<Members>(db, TABLES.members, memberId)
        if (current?.status !== member.status || current.role !== member.role) throw tryAgain()
        if (joinedAdmin) await keepAnotherAdmin(db, tx, groupId, memberId, NEEDS_ADMIN)
        await tx.write(
          activityWrite(
            groupId,
            caller.$id,
            'member.removed',
            `${member.displayName} was removed`,
            now,
          ),
        )
      }),
    )
  } catch (error) {
    if (removedUserId) await rejoinTeam(db, teams, groupId, member, removedUserId)
    throw error
  }
  return {}
}

/**
 * Whether the person is named, as the ledger names people (everyPersonId), in a transaction that
 * isn't posted yet (its stored input and its items' splits) or in a schedule's template. Posted
 * ones are covered by the shares check; void ones name no one any more. The creator of an expense
 * or bill schedule whose template names no payers counts too: they pay its occurrences (the trial
 * occurrence and auto-post, scheduling.md), so removing them would break the schedule for good.
 */
async function isNamed(db: Db, groupId: string, personId: string): Promise<boolean> {
  const names = (template: TransactionTemplate) => everyPersonId(template).includes(personId)
  const paysFor = (schedule: Schedules, template: TransactionTemplate) =>
    schedule.createdBy === personId &&
    (schedule.kind === 'expense' || schedule.kind === 'bill') &&
    template.payers === undefined
  const inSchedule = await anyPage<Schedules>(
    db,
    TABLES.schedules,
    [Query.equal('groupId', groupId)],
    (rows) =>
      rows.some((schedule) => {
        const template: TransactionTemplate = JSON.parse(schedule.templateJson)
        return names(template) || paysFor(schedule, template)
      }),
  )
  if (inSchedule) return true
  const unposted = [
    Query.equal('groupId', groupId),
    Query.equal('status', ['scheduled', 'running', 'due']),
  ]
  return anyPage<Transactions>(db, TABLES.transactions, unposted, async (rows) => {
    if (rows.some((transaction) => names(JSON.parse(transaction.inputJson)))) return true
    if (rows.length === 0) return false
    const ofThese = [
      Query.equal(
        'transactionId',
        rows.map((row) => row.$id),
      ),
    ]
    return anyPage<Items>(db, TABLES.items, ofThese, (items) =>
      items.some((item) => names({ split: JSON.parse(item.splitJson) })),
    )
  })
}

/** Reads the matching rows in pages of 100 (scaling.md); true as soon as `test` is true for one. */
async function anyPage<R extends Models.Row>(
  db: Db,
  tableId: TableId,
  queries: string[],
  test: (rows: R[]) => boolean | Promise<boolean>,
): Promise<boolean> {
  let cursor: string | undefined
  for (;;) {
    const { rows } = await db.listRows<R>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        ...queries,
        Query.orderAsc('$id'),
        Query.limit(100),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    })
    if (await test(rows)) return true
    if (rows.length < 100) return false
    cursor = rows[rows.length - 1]?.$id
  }
}

/** Takes the member's user out of the team; their user ID when they were in it, else null. */
async function leaveTeam(
  db: Db,
  teams: TeamsApi,
  groupId: string,
  personId: string,
): Promise<string | null> {
  const person = await getRowOrNull<Persons>(db, TABLES.persons, personId)
  if (!person?.userId) return null
  if (!(await isInTeam(teams, groupId, person.userId))) return null
  await removeFromTeam(teams, groupId, person.userId)
  return person.userId
}

/**
 * Best effort: gives back team access when the removal failed and the member row is still there,
 * unless the member left the group themselves meanwhile (`active` became `left`), which took
 * their access away for good.
 */
async function rejoinTeam(
  db: Db,
  teams: TeamsApi,
  groupId: string,
  member: Members,
  userId: string,
): Promise<void> {
  try {
    const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
    const leftMeanwhile = member.status === 'active' && current?.status === 'left'
    if (current && !leftMeanwhile) await addToTeam(teams, groupId, userId)
  } catch {
    // The caller's error matters more.
  }
}
