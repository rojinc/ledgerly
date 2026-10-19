import type { Members } from '@ledgerly/core/generated/rows'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { AppwriteException, ID, Permission, Role } from 'node-appwrite'
import { getRowOrNull, guardPerson, isAppwriteError, tryAgain } from './rows'
import type { Services } from './services'

/**
 * identity-and-invites.md#joining-a-group: joins the person's `placeholder` member row, in an
 * order a retry can always finish. True if this call joined it; false if the row is gone or
 * no longer pending (another claim running at the same time joined it), or if the group's team
 * is gone: an account deletion is purging the group, its rows last (#322). Throws `deleted()`
 * once the person's account is being deleted, as their lookup would have.
 */
export async function joinGroup(
  { db, teams, now }: Services,
  userId: string,
  personId: string,
  member: Members,
  deleted: () => AppError,
): Promise<boolean> {
  // Step 1: the team first ("already a member" counts as done), so a retry finds it done.
  if (!(await joinTeam(teams, member.groupId, userId))) return false
  try {
    // Step 2: the status and one member.joined row, together.
    await withTransaction(db, async (tx) => {
      await tx.write(statusWrite(member))
      // A deletion that passed step 2 since the person was looked up.
      await guardPerson(tx, db, personId, deleted)
      // Stage, then check (transaction.ts): from here on, any change to the row fails the
      // commit. Read the stored row, not this transaction's view, which has the new status.
      const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
      if (!isPendingFor(current, personId)) throw new Error('The member row is no longer pending')
      // `leftOn` changed after the row was listed.
      if (statusOf(current) !== statusOf(member)) await tx.write(statusWrite(current))
      await tx.write({
        action: 'create',
        tableId: TABLES.activity,
        rowId: ID.unique(),
        data: {
          groupId: current.groupId,
          actorPersonId: personId,
          action: 'member.joined',
          // No name (data-model.md#activity): the app shows theirs from subjectPersonId.
          subjectPersonId: current.personId,
          summary: 'joined',
          at: now.toISOString(),
        },
        permissions: [Permission.read(Role.team(current.groupId))],
      })
    })
  } catch (error) {
    const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
    if (isPendingFor(current, personId)) {
      // Still pending (a commit conflict, or any other failure): take back step 1, so no one
      // keeps team access without having joined, even if they never retry.
      await removeFromTeam(teams, member.groupId, userId)
      throw isAppwriteError(error, 409) ? tryAgain() : error
    }
    // The row is gone (an admin removed it) or now belongs to another person (a merge): take
    // back the team membership from step 1, so no one keeps access without a member row. A
    // row now `active` or `left` for this person was joined by a claim running at the same
    // time, so the membership stays.
    if (current?.personId !== personId) await removeFromTeam(teams, member.groupId, userId)
    // `deleted()`: refused, even if a claim running at the same time joined the row first.
    if (error instanceof AppError) throw error
    return false
  }
  // A parallel join that failed while the row was still pending may have taken back the
  // membership from step 1 just before this commit; the row is joined now, so add it again.
  return joinTeam(teams, member.groupId, userId)
}

/** Adds the user to the group's team; false if the team is gone (a purge is deleting it). */
async function joinTeam(teams: Services['teams'], groupId: string, userId: string) {
  try {
    await addToTeam(teams, groupId, userId)
    return true
  } catch (error) {
    if (error instanceof AppwriteException && error.type === 'team_not_found') return false
    throw error
  }
}

// Narrows to a placeholder row only, so a row that fails the check can still be another row.
function isPendingFor(
  row: Members | null,
  personId: string,
): row is Members & { status: 'placeholder' } {
  return row !== null && row.personId === personId && row.status === 'placeholder'
}

// `left` if they moved out before joining, so a former housemate can still see and settle up.
function statusOf(member: Members): 'active' | 'left' {
  return member.leftOn ? 'left' : 'active'
}

function statusWrite(member: Members): Write {
  return {
    action: 'update',
    tableId: TABLES.members,
    rowId: member.$id,
    data: { status: statusOf(member) },
  }
}
