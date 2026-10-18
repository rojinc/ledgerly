import type { Members } from '@ledgerly/core/generated/rows'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { ID, Permission, Role } from 'node-appwrite'
import { getRowOrNull, isAppwriteError, tryAgain } from './rows'
import type { Services } from './services'

/**
 * identity-and-invites.md#joining-a-group: joins the person's `placeholder` member row, in an
 * order a retry can always finish. True if this call joined it; false if the row is gone or
 * no longer pending (another claim running at the same time joined it).
 */
export async function joinGroup(
  { db, teams, now }: Services,
  userId: string,
  personId: string,
  member: Members,
): Promise<boolean> {
  // Step 1: the team first ("already a member" counts as done), so a retry finds it done.
  await addToTeam(teams, member.groupId, userId)
  try {
    // Step 2: the status and one member.joined row, together.
    await withTransaction(db, async (tx) => {
      await tx.write(statusWrite(member))
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
          summary: `${current.displayName} joined`,
          at: now.toISOString(),
        },
        permissions: [Permission.read(Role.team(current.groupId))],
      })
    })
    return true
  } catch (error) {
    const current = await getRowOrNull<Members>(db, TABLES.members, member.$id)
    // Still pending: a commit conflict means another change to the row won; claim again.
    if (isPendingFor(current, personId)) throw isAppwriteError(error, 409) ? tryAgain() : error
    // An admin removed the row meanwhile: take back the team membership from step 1, so a
    // removed person keeps no access.
    if (!current) await removeFromTeam(teams, member.groupId, userId)
    return false
  }
}

function isPendingFor(row: Members | null, personId: string): row is Members {
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
