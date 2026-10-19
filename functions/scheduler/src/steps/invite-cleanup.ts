import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type { Invites } from '@ledgerly/core/generated/rows'
import { pages } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { writeInBatches } from '@ledgerly/server/appwrite/transaction'
import { logProblem } from '@ledgerly/server/http/log'
import { AppwriteException, Query } from 'node-appwrite'
import type { Services } from '../services'

export type InviteCounts = { deleted: number; skipped: number; failed: number }

// An invite's row is kept this long after it was accepted or expired: its link is dead by then,
// and no rate limit looks back that far (identity-and-invites.md#invites).
const KEPT_FOR_MS = 30 * 24 * 60 * 60 * 1000
// The step's own share of the run, so step 6 gets the rest.
const STEP_BUDGET_MS = 60_000

/**
 * Step 5b (scheduling.md#step-5b-invite-clean-up): deletes invites rows accepted 30 days ago or
 * more, then never-accepted ones that expired that long ago. Nothing else changes such a row,
 * so there's no guard. A batch that a purge or an account deletion beat (409) is skipped, and
 * the next run deletes the rest of it. Any other failure ends the step, with one error line.
 */
export async function cleanUpInvites(services: Services): Promise<InviteCounts> {
  const counts: InviteCounts = { deleted: 0, skipped: 0, failed: 0 }
  const stopAt = performance.now() + STEP_BUDGET_MS
  const step = {
    db: services.db,
    outOfTime: () => services.outOfTime() || performance.now() >= stopAt,
  }
  const cutoff = new Date(services.now.getTime() - KEPT_FOR_MS).toISOString()
  try {
    for (const queries of [
      // idx_acceptedAt
      [Query.lessThanEqual('acceptedAt', cutoff)],
      // idx_expiresAt. isNull keeps these apart from the first; accept refuses from expiresAt on,
      // so no row falls between the two.
      [Query.isNull('acceptedAt'), Query.lessThanEqual('expiresAt', cutoff)],
    ]) {
      let batch: string[] = []
      for await (const { $id } of pages<Invites>(step, TABLES.invites, queries)) {
        batch.push($id)
        if (batch.length === MAX_OPS_PER_DB_TRANSACTION) {
          await deleteBatch(services, batch, counts)
          batch = []
        }
      }
      await deleteBatch(services, batch, counts)
    }
  } catch (error) {
    logProblem('invite_cleanup_failed', { count: counts.failed, error })
  }
  return counts
}

async function deleteBatch(services: Services, rowIds: string[], counts: InviteCounts) {
  try {
    await writeInBatches(
      services.db,
      rowIds.map((rowId) => ({ action: 'delete', tableId: TABLES.invites, rowId })),
    )
    counts.deleted += rowIds.length
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      counts.skipped += rowIds.length
      return
    }
    counts.failed += rowIds.length
    throw error
  }
}
