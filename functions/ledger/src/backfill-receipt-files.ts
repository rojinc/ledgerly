import type { ReceiptFiles, Transactions } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException, Query } from 'node-appwrite'

export type BackfillCounts = { updated: number; unchanged: number; deleting: number }

const PAGE = 100
// Times a file's row is read and written again after another write changed it meanwhile.
const TRIES = 3

/**
 * data-model.md#receiptfiles: adds every transaction that lists a file to the file's row, for
 * files attached before the ledger kept these rows. Run by scripts/backfill-receipt-files.mjs,
 * once in each environment before scheduler step 5 ships there. Safe to run again, and while the
 * ledger runs: a row that changes meanwhile is read again. A file taken off a transaction during
 * the run can stay listed, which only keeps it. `deleting` counts rows step 5 had already marked:
 * they're left alone, and none should exist before step 5 ships.
 */
export async function backfillReceiptFiles(db: Db): Promise<BackfillCounts> {
  const listed = new Map<string, Set<string>>()
  for (let after: string | undefined; ; ) {
    const { rows } = await db.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      queries: [
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
  const counts: BackfillCounts = { updated: 0, unchanged: 0, deleting: 0 }
  for (const [fileId, ids] of listed) counts[await addListing(db, fileId, [...ids])] += 1
  return counts
}

async function addListing(
  db: Db,
  fileId: string,
  transactionIds: string[],
): Promise<keyof BackfillCounts> {
  for (let tries = 1; ; tries++) {
    const row = await rowOf(db, fileId)
    if (row?.deletingAt) return 'deleting'
    const stored = row?.transactionIds ?? []
    const missing = transactionIds.filter((id) => !stored.includes(id))
    if (row && missing.length === 0 && row.detachedAt === null) return 'unchanged'
    const data = { transactionIds: [...stored, ...missing], detachedAt: null }
    try {
      await withTransaction(db, async (tx) => {
        const target = { tableId: TABLES.receiptFiles, rowId: fileId }
        await tx.write(
          row
            ? { action: 'update', ...target, data }
            : // Server only (permissions.md).
              { action: 'create', ...target, data: { ...data, deletingAt: null }, permissions: [] },
        )
        // Staged first, then checked as committed (ledger.md#concurrency).
        if (columns(await rowOf(db, fileId)) !== columns(row)) throw new Changed()
      })
      return 'updated'
    } catch (error) {
      const raced =
        error instanceof Changed ||
        (error instanceof AppwriteException && (error.code === 409 || error.code === 404))
      if (!raced || tries === TRIES) throw error
    }
  }
}

async function rowOf(db: Db, fileId: string): Promise<ReceiptFiles | undefined> {
  try {
    return await db.getRow<ReceiptFiles>({
      databaseId: DATABASE_ID,
      tableId: TABLES.receiptFiles,
      rowId: fileId,
    })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}

const columns = (row: ReceiptFiles | undefined) =>
  row && JSON.stringify([row.transactionIds ?? [], row.detachedAt, row.deletingAt])

class Changed extends Error {
  override name = 'Changed'
}
