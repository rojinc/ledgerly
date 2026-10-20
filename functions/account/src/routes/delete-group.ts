import type { Groups } from '@ledgerly/core/generated/rows'
import {
  type DeleteGroupRefusal,
  type DeleteGroupResult,
  deleteGroupBodySchema,
} from '@ledgerly/core/schemas/identity'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { deleteTeam, othersInTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { parseBody } from '../parse-body'
import { purge } from '../purge'
import { getRowOrNull, isAppwriteError } from '../rows'
import type { Services } from '../services'
import { requireRecentSignIn } from './delete-account'

/** A group past the point of no return (step 2): `deletingBy` is written with `deletingAt`. */
export type DeletingGroup = Groups & { deletingAt: string; deletingBy: string }

/**
 * `account POST /groups/{id}/delete` (identity-and-invites.md#deleting-a-group). The refusals
 * change nothing. Step 2 sets `deletingAt`, the point of no return: a call once it's set skips
 * the session, password and group checks and carries on. Stops between a purge's batches once the
 * time budget is used up; `finished: false` leaves the rest to the hourly job.
 */
export async function deleteGroup(
  services: Services,
  userId: string,
  sessionId: string | null,
  groupId: string,
  body: unknown,
): Promise<DeleteGroupResult> {
  parseBody(deleteGroupBodySchema, body)
  // After the team is gone too: an admin's row is `active`, and only a `left` row needs the team.
  const { person, group } = await requireMember(services.db, services.teams, userId, groupId, {
    roles: ['admin'],
    allowArchived: true,
  })
  let deleting = group as DeletingGroup
  if (!group.deletingAt) {
    await requireRecentSignIn(services, userId, sessionId, 'delete this group')
    await refuseGroup(services, userId, group)
    deleting = await markDeleting(services, userId, group, person.$id)
  }
  return { finished: await finishDelete(services, deleting) }
}

// The group checks of step 1: never a personal group, only an archived one, and nobody else in
// its team, someone who moved out included. A team that's gone has nobody.
async function refuseGroup({ teams }: Services, userId: string, group: Groups): Promise<void> {
  if (group.type === 'personal') {
    throw new AppError('VALIDATION_FAILED', 'Your personal group can’t be deleted.')
  }
  if (!group.archivedAt) throw notArchived()
  if (await othersInTeam(teams, group.$id, userId)) throw shared()
}

function notArchived(): AppError {
  return new AppError('VALIDATION_FAILED', 'Archive the group first, then delete it.')
}

function shared(): AppError {
  const details: DeleteGroupRefusal = { reason: 'shared' }
  return new AppError(
    'VALIDATION_FAILED',
    'Someone else is still in this group, so it can’t be deleted.',
    details,
  )
}

// Step 2, the point of no return: `deletingAt` and `deletingBy`, with a fresh `rev` (a guard
// write, ledger.md#concurrency), so unarchive refuses the group from here. When another call's
// delete got there first, this one carries on with it.
async function markDeleting(
  { db, teams, now }: Services,
  userId: string,
  group: Groups,
  personId: string,
): Promise<DeletingGroup> {
  const deletingAt = now.toISOString()
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: group.$id,
        data: { deletingAt, deletingBy: personId, rev: randomId() },
      })
      // Stage, then check: the stored row, not this transaction's view.
      const stored = await getRowOrNull<Groups>(db, TABLES.groups, group.$id)
      if (stored?.deletingAt) throw new Raced()
      if (!stored?.archivedAt) throw notArchived()
      // And the team again: a join that added itself to it since step 1 read it is refused too,
      // rolling this back (AI E's S1 on #429).
      if (await othersInTeam(teams, group.$id, userId)) throw shared()
    })
    return { ...group, deletingAt, deletingBy: personId }
  } catch (error) {
    const stored = await getRowOrNull<Groups>(db, TABLES.groups, group.$id)
    if (stored?.deletingAt) return stored as DeletingGroup
    // Nothing changed, as for a refusal: an unarchive, say, got there first.
    if (error instanceof Raced || isAppwriteError(error, 409)) {
      throw new AppError('CONFLICT', 'Something else changed this at the same time. Try again.')
    }
    throw error
  }
}

/**
 * Steps 3 and 4, which the hourly job's group pass also runs: the team (one that's gone counts
 * as done), then the purge, ending with `deletingBy`'s member row. True once the group is gone.
 * A purge that loses a race with another purge of the group (the other's batch gave the group a
 * fresh `rev`, or deleted a row this one stages) isn't finished, and isn't an error: the next call
 * or run carries on (identity-and-invites.md#finishing-purges).
 */
export async function finishDelete(services: Services, group: DeletingGroup): Promise<boolean> {
  await deleteTeam(services.teams, group.$id)
  try {
    return await purge(services, group.$id, group.deletingBy)
  } catch (error) {
    if (error instanceof Raced || isAppwriteError(error, 409)) return false
    throw error
  }
}
