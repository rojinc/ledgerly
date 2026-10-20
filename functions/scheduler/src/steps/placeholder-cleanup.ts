import type { Identities, Invites, Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows, pages } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { logProblem } from '@ledgerly/server/http/log'
import { randomId } from '@ledgerly/server/identity/random-id'
import {
  FORMER_MEMBER,
  findPerson,
  isLonePlaceholder,
} from '@ledgerly/server/identity/resolve-person'
import { Raced } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'
import type { Services } from '../services'

export type PlaceholderCounts = { cleared: number; kept: number; skipped: number; failed: number }

// A placeholder's details are kept this long after its last member row went: until then, adding
// the same address again finds the same person, so a removal can't test an address (#367).
const KEPT_FOR_MS = 30 * 24 * 60 * 60 * 1000
// The step's own share of the run, so step 6 gets the rest.
const STEP_BUDGET_MS = 60_000

/**
 * Step 5c (scheduling.md#step-5c-placeholder-clean-up): each person whose `orphanedAt` is 30 days
 * old or more, in one transaction, gets it cleared, and a placeholder no member row names also
 * has its identities and the invites to them deleted and its name replaced with "Former member";
 * its row stays. One re-added, claimed or merged since is kept as it is. A write to the person
 * meanwhile fails one of the two commits, and the person is skipped for the next run. Any other
 * failure ends the step, with one error line.
 */
export async function cleanUpPlaceholders(services: Services): Promise<PlaceholderCounts> {
  const counts: PlaceholderCounts = { cleared: 0, kept: 0, skipped: 0, failed: 0 }
  const stopAt = performance.now() + STEP_BUDGET_MS
  const step = {
    db: services.db,
    outOfTime: () => services.outOfTime() || performance.now() >= stopAt,
  }
  const cutoff = services.now.getTime() - KEPT_FOR_MS
  try {
    // idx_orphanedAt. A person handled stops matching, its orphanedAt cleared.
    for await (const { $id } of pages<Persons>(step, TABLES.persons, [
      Query.lessThanEqual('orphanedAt', new Date(cutoff).toISOString()),
    ])) {
      try {
        counts[await clear(services.db, $id, cutoff)] += 1
      } catch (error) {
        // A 404 at the commit, for a row gone, comes as a 409 (withTransaction).
        if (error instanceof Raced || (error instanceof AppwriteException && error.code === 409)) {
          counts.skipped += 1
          continue
        }
        counts.failed += 1
        throw error
      }
    }
  } catch (error) {
    logProblem('placeholder_cleanup_failed', { counts, error })
  }
  return counts
}

/**
 * One person (step 2): decide from the stored rows, stage, then read them again and roll back
 * (Raced) if the answer or `orphanedAt` changed. An add, a claim, a merge's step 1, an invite
 * and a removal each write the person row, so one that commits after the staging fails this
 * commit. A person whose `orphanedAt` a removal has set again since it was listed, or another run
 * has cleared, is skipped with nothing written: it isn't due.
 */
async function clear(
  db: Db,
  personId: string,
  cutoff: number,
): Promise<'cleared' | 'kept' | 'skipped'> {
  return withTransaction(db, async (tx) => {
    const before = await decide(db, personId)
    if (before.orphanedAt === null || Date.parse(before.orphanedAt) > cutoff) return 'skipped'
    await tx.write({
      action: 'update',
      tableId: TABLES.persons,
      rowId: personId,
      data: {
        orphanedAt: null,
        rev: randomId(),
        ...(before.lone ? { displayName: FORMER_MEMBER } : {}),
      },
    })
    if (before.lone) {
      // idx_personId
      const identities = await allRows<Identities>(db, TABLES.identities, [
        Query.equal('personId', personId),
      ])
      // idx_identity_sentAt. Each is 30 days old or more by now (a person with no member row
      // can't be invited), so deleting them changes no rate limit.
      const invites =
        identities.length > 0
          ? await allRows<Invites>(db, TABLES.invites, [
              Query.equal(
                'identityKey',
                identities.map(({ key }) => key),
              ),
            ])
          : []
      const deletes = [
        ...identities.map(({ $id }) => remove(TABLES.identities, $id)),
        ...invites.map(({ $id }) => remove(TABLES.invites, $id)),
      ]
      if (deletes.length > 0) await tx.write(...deletes)
    }
    // Stage, then check (ledger.md#concurrency): the stored rows, not this transaction's view.
    const after = await decide(db, personId)
    if (after.orphanedAt !== before.orphanedAt || after.lone !== before.lone) throw new Raced()
    return before.lone ? 'cleared' : 'kept'
  })
}

/** The person's stored `orphanedAt`, and whether it's a placeholder no member row names. */
async function decide(
  db: Db,
  personId: string,
): Promise<{ orphanedAt: string | null; lone: boolean }> {
  const orphanedAt = (await findPerson(db, personId))?.orphanedAt ?? null
  return { orphanedAt, lone: await isLonePlaceholder(db, personId) }
}

function remove(tableId: typeof TABLES.identities | typeof TABLES.invites, rowId: string): Write {
  return { action: 'delete', tableId, rowId }
}
