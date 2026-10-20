import type { Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { pages } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import {
  findPerson,
  isLonePlaceholder,
  isPlaceholder,
} from '@ledgerly/server/identity/resolve-person'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'

type BackfillCounts = { marked: number; unchanged: number }

// Times a person is read and written again after another write changed it meanwhile.
const TRIES = 3

/**
 * data-model.md#persons, for placeholders that removals left with no member row before
 * `orphanedAt` existed: each gets `orphanedAt` = `now`, so step 5c clears it 30 days later. Run
 * by scripts/backfill-orphaned-at.mjs, once in each environment, after the change is deployed
 * there and the old deployment's executions have finished.
 *
 * Safe while the new code runs: the person is decided on its stored row, written with a fresh
 * `rev`, then decided again as committed, so an add, a claim, a merge or a removal that commits
 * meanwhile fails one of the two commits, and the person is decided again. One with an
 * `orphanedAt` keeps it, so a removal's newer mark stands. A person that keeps changing makes it
 * throw. Run again, it marks again only the placeholders step 5c has cleared since, which then
 * have nothing left to clear.
 */
export async function backfillOrphanedAt(db: Db, now: Date): Promise<BackfillCounts> {
  const counts: BackfillCounts = { marked: 0, unchanged: 0 }
  // Placeholders have no userId; isPlaceholder() rules out merged and deleted ones.
  for await (const person of pages<Persons>({ db, outOfTime: () => false }, TABLES.persons, [
    Query.isNull('userId'),
  ])) {
    if (person.orphanedAt || !isPlaceholder(person)) continue
    counts[await mark(db, person.$id, now)] += 1
  }
  return counts
}

async function mark(db: Db, personId: string, now: Date): Promise<keyof BackfillCounts> {
  for (let tries = 1; ; tries++) {
    if (!(await unmarked(db, personId))) return 'unchanged'
    try {
      await withTransaction(db, async (tx) => {
        await tx.write({
          action: 'update',
          tableId: TABLES.persons,
          rowId: personId,
          data: { orphanedAt: now.toISOString(), rev: randomId() },
        })
        if (!(await unmarked(db, personId))) throw new Raced()
      })
      return 'marked'
    } catch (error) {
      const raced =
        error instanceof Raced ||
        // withTransaction reports a row gone as a 409 too.
        (error instanceof AppwriteException && error.code === 409)
      if (!raced || tries === TRIES) throw error
    }
  }
}

/** Whether the stored person has no `orphanedAt` and is a placeholder no member row names. */
async function unmarked(db: Db, personId: string): Promise<boolean> {
  const person = await findPerson(db, personId)
  return !person?.orphanedAt && (await isLonePlaceholder(db, personId))
}
