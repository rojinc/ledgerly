import type { Identities, Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { Query } from 'node-appwrite'
import { getRowOrNull, isAppwriteError } from './rows'

// identity-and-invites.md#merging-two-persons: placeholder P is merged into U in steps that are
// each safe to repeat. Logs hold IDs and counts only (security-and-privacy.md).

/** Writes per database transaction, guard writes included (step 3). */
export const MERGE_BATCH = 90

/** Thrown inside a transaction when P turned out not to be U's to merge. */
class NotOurs extends Error {}

/**
 * Step 1: marks P as merged into U. It stages `mergedInto`, then reads P's stored row, so of
 * two adoptions or merges at once only one wins. True when P is U's to merge: marked now, or
 * already by an earlier call that was cut off.
 */
export async function markMerged(db: Db, placeholderId: string, intoId: string): Promise<boolean> {
  const stored = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
  if (!stored || stored.userId || stored.deletedAt) return false
  if (stored.mergedInto) return stored.mergedInto === intoId
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.persons,
        rowId: placeholderId,
        data: { mergedInto: intoId },
      })
      // Stage, then check: read the stored row, not this transaction's view of it.
      const current = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
      if (!current || current.userId || current.mergedInto) throw new NotOurs()
    })
    return true
  } catch (error) {
    if (error instanceof NotOurs) return false
    // P changed after it was staged: whoever changed it decides.
    if (isAppwriteError(error, 409)) {
      const current = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
      return current?.mergedInto === intoId && !current.userId
    }
    throw error
  }
}

/**
 * Step 3, identities: repoints P's identities to U, a batch at a time (`idx_personId`). Each
 * batch is staged, then read again, so one that changed meanwhile (another merge, say) is never
 * overwritten: the batch runs again from a fresh list. Returns how many moved.
 */
export async function moveIdentities(db: Db, fromId: string, intoId: string): Promise<number> {
  let moved = 0
  for (;;) {
    const { rows } = await db.listRows<Identities>({
      databaseId: DATABASE_ID,
      tableId: TABLES.identities,
      queries: [Query.equal('personId', fromId), Query.limit(MERGE_BATCH)],
      total: false,
    })
    if (rows.length === 0) return moved
    const ids = rows.map((row) => row.$id)
    try {
      await withTransaction(db, async (tx) => {
        await tx.write(
          ...ids.map((rowId) => ({
            action: 'update' as const,
            tableId: TABLES.identities,
            rowId,
            data: { personId: intoId },
          })),
        )
        const { rows: current } = await db.listRows<Identities>({
          databaseId: DATABASE_ID,
          tableId: TABLES.identities,
          queries: [Query.equal('$id', ids), Query.limit(ids.length)],
          total: false,
        })
        if (current.length !== ids.length || current.some((row) => row.personId !== fromId)) {
          throw new Changed()
        }
      })
      moved += ids.length
    } catch (error) {
      // A row changed before or after it was staged: list again.
      if (!(error instanceof Changed || isAppwriteError(error, 409))) throw error
    }
  }
}

/** Thrown inside a batch when a row it staged had changed. */
class Changed extends Error {}
