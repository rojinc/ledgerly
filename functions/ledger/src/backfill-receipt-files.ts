import type { Transactions } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import { receiptRows, writeReceiptRows } from '@ledgerly/server/ledger/receipt-files'
import { listAll, Raced } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'

type BackfillCounts = {
  updated: number
  unchanged: number
  deleting: number
  /** Files no transaction lists, given a row taken off now. */
  swept: number
}

/** The receipts bucket's file IDs, a page at a time by ID. The script passes Storage. */
export type ReceiptsListing = (after: string | undefined) => Promise<string[]>

const PAGE = 100
// data-model.md#checkpoints: scheduler step 5 waits for this row, then keeps it.
const CHECKPOINT = 'receipt-clean-up'
// Times a file's row is read and written again after another write changed it meanwhile.
const TRIES = 3

/**
 * data-model.md#receiptfiles, for files uploaded before the ledger kept these rows. Run by
 * scripts/backfill-receipt-files.mjs, once in each environment, after the ledger change is
 * deployed there and the old deployment's executions have finished:
 * - adds every transaction that lists a file to the file's row;
 * - gives every other file with no row a row taken off `now`, so step 5 deletes it a day later;
 * - last, makes the `checkpoints` row that lets step 5 start, `through` = `now`: every file
 *   created by then is in the bucket's listing.
 *
 * Safe to run again, and while the new ledger runs: a row or a transaction that changes meanwhile
 * is read again, so a transaction that drops a file during the run is never added. A row that keeps
 * changing makes it throw, with no checkpoint written. `deleting` counts rows step 5 had
 * already marked although a transaction lists the file: they're left alone, and the script
 * reports them.
 */
export async function backfillReceiptFiles(
  db: Db,
  files: ReceiptsListing,
  now: Date,
): Promise<BackfillCounts> {
  const listed = new Map<string, Set<string>>()
  for (let after: string | undefined; ; ) {
    const { rows } = await db.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      queries: [
        // Also matches [] (checked on ledgerly-dev): only files in a list count below.
        Query.isNotNull('receiptFileIds'),
        ...(after === undefined ? [] : [Query.greaterThan('$id', after)]),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
      ],
      total: false,
    })
    for (const row of rows) {
      for (const fileId of row.receiptFileIds ?? []) {
        const ids = listed.get(fileId) ?? new Set<string>()
        listed.set(fileId, ids.add(row.$id))
      }
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)?.$id
  }
  const counts: BackfillCounts = { updated: 0, unchanged: 0, deleting: 0, swept: 0 }
  for (const [fileId, ids] of listed) counts[await addListing(db, fileId, [...ids], now)] += 1
  for (let after: string | undefined; ; ) {
    const page = await files(after)
    for (const fileId of page) {
      // Every file still without a row, a listed one whose transactions all dropped it included.
      if (await sweep(db, fileId, now)) counts.swept += 1
    }
    if (page.length < PAGE) break
    after = page.at(-1)
  }
  await withTransaction(db, (tx) =>
    tx.write({
      action: 'upsert',
      tableId: TABLES.checkpoints,
      rowId: CHECKPOINT,
      data: { through: now.toISOString() },
      // Server only (permissions.md).
      permissions: [],
    }),
  )
  return counts
}

/** A row taken off `now` for a file with none, so step 5 deletes it. False if it has one. */
async function sweep(db: Db, fileId: string, now: Date): Promise<boolean> {
  if ((await receiptRows(db, [fileId])).has(fileId)) return false
  try {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'create',
        tableId: TABLES.receiptFiles,
        rowId: fileId,
        data: { transactionIds: null, detachedAt: now.toISOString(), deletingAt: null },
        permissions: [],
      }),
    )
    return true
  } catch (error) {
    // The ledger attached it meanwhile, and made the row.
    if (error instanceof AppwriteException && error.code === 409) return false
    throw error
  }
}

async function addListing(
  db: Db,
  fileId: string,
  transactionIds: string[],
  now: Date,
): Promise<keyof BackfillCounts> {
  for (let tries = 1; ; tries++) {
    const rows = await receiptRows(db, [fileId])
    const row = rows.get(fileId)
    // As committed now, not as the pass saw them: one may have dropped the file since, and the
    // code that took it off has written the row already.
    const listing = await stillListing(db, fileId, transactionIds)
    // Being deleted while a transaction lists it: left alone, and reported.
    if (row?.deletingAt) return listing.length > 0 ? 'deleting' : 'unchanged'
    const stored = row?.transactionIds ?? []
    const missing = listing.filter(({ $id }) => !stored.includes($id))
    if (missing.length === 0 && (listing.length === 0 || row?.detachedAt === null)) {
      return 'unchanged'
    }
    try {
      // Staged, then the row and the transactions read again as committed: never an upsert
      // (data-model.md#receiptfiles).
      await withTransaction(db, async (tx) => {
        // A guard on each added transaction's group: taking the file off one guards it too, so
        // that write fails one of the two commits even when it leaves the row as it was.
        const groupIds = new Set(missing.map(({ groupId }) => groupId))
        await tx.write(
          ...[...groupIds].map((groupId) => ({
            action: 'update' as const,
            tableId: TABLES.groups,
            rowId: groupId,
            data: { rev: randomId() },
          })),
        )
        const add = missing.map(({ $id }) => $id)
        await writeReceiptRows(db, tx, rows, [{ fileId, add }], now)
        const again = await stillListing(db, fileId, transactionIds)
        if (ids(again) !== ids(listing)) throw new Raced()
      })
      return 'updated'
    } catch (error) {
      const raced =
        error instanceof Raced ||
        // withTransaction reports a row gone as a 409 too.
        (error instanceof AppwriteException && error.code === 409)
      if (!raced || tries === TRIES) throw error
    }
  }
}

/** The ones of `transactionIds` that list the file now, in ID order. */
async function stillListing(
  db: Db,
  fileId: string,
  transactionIds: readonly string[],
): Promise<Transactions[]> {
  const rows: Transactions[] = []
  // Appwrite takes at most 100 values in one `equal`.
  for (let start = 0; start < transactionIds.length; start += PAGE) {
    const page = transactionIds.slice(start, start + PAGE)
    rows.push(...(await listAll<Transactions>(db, TABLES.transactions, [Query.equal('$id', page)])))
  }
  return rows
    .filter((row) => (row.receiptFileIds ?? []).includes(fileId))
    .sort((a, b) => (a.$id < b.$id ? -1 : 1))
}

const ids = (rows: readonly Transactions[]) => rows.map(({ $id }) => $id).join()
