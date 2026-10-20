import type { Checkpoints, ReceiptFiles } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { logProblem } from '@ledgerly/server/http/log'
import { AppwriteException, Query, type Storage } from 'node-appwrite'
import type { Services } from '../services'

export type CleanUpCounts = { deleted: number; skipped: number; failed: number }

// data-model.md#storage-buckets
const RECEIPTS_BUCKET = 'receipts'
// data-model.md#checkpoints: made by scripts/backfill-receipt-files.mjs, then moved on by pass 1.
const CHECKPOINT = 'receipt-clean-up'

export const PAGE = 100
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
// Uploads older than this that no transaction lists are deleted.
const KEEP_HOURS = 24
// A row outlives its file by this much, far longer than any ledger request (15 s timeout), so an
// attach that read the rows before the row existed still finds it when it reads them again.
const ROW_HOURS = 1
// The step's share of the run, and pass 1's share of that, so steps 5b and 6 and pass 2 always
// get time.
const STEP_MINUTES = 4
const PASS_1_MINUTES = 2

/** A file in the receipts bucket, as step 5 sees it. */
export type BucketFile = { $id: string; $createdAt: string }

/** The parts of Appwrite Storage that step 5 uses on the receipts bucket. Tests pass a fake. */
export interface ReceiptsBucket {
  /**
   * A page of the files created after `from` and at or before `to`, oldest first (`$createdAt`,
   * then `$id`), after the file `after`, which must still exist.
   */
  listFiles(page: { from: string; to: string; after?: string }): Promise<BucketFile[]>
  /** Deletes the file. False if there was none. */
  deleteFile(fileId: string): Promise<boolean>
}

export function receiptsBucket(storage: Storage): ReceiptsBucket {
  return {
    async listFiles({ from, to, after }) {
      const { files } = await storage.listFiles({
        bucketId: RECEIPTS_BUCKET,
        queries: [
          Query.greaterThan('$createdAt', from),
          Query.lessThanEqual('$createdAt', to),
          Query.orderAsc('$createdAt'),
          Query.orderAsc('$id'),
          Query.limit(PAGE),
          // listFiles pages by cursor only, checked on ledgerly-dev (#163).
          ...(after === undefined ? [] : [Query.cursorAfter(after)]),
        ],
        total: false,
      })
      return files.map(({ $id, $createdAt }) => ({ $id, $createdAt }))
    },
    async deleteFile(fileId) {
      try {
        await storage.deleteFile({ bucketId: RECEIPTS_BUCKET, fileId })
        return true
      } catch (error) {
        if (error instanceof AppwriteException && error.type === 'storage_file_not_found') {
          return false
        }
        throw error
      }
    },
  }
}

/** One run of the step: what it has counted, and the files pass 1 has made rows for. */
type Run = {
  services: Services
  counts: CleanUpCounts
  /** Counts a failure, left for the next run. */
  fail: (error: unknown) => void
  claimed: Set<string>
  /** True once the pass is out of time. */
  done: () => boolean
}

/**
 * Step 5 (scheduling.md#step-5-receipt-clean-up): deletes the receipt files that no transaction
 * lists, using the receiptFiles rows. Never-attached uploads go first, oldest first from the
 * checkpoint, then the files taken off every transaction, each pass in its share of the time.
 */
export async function cleanUpReceipts(services: Services): Promise<CleanUpCounts> {
  const counts: CleanUpCounts = { deleted: 0, skipped: 0, failed: 0 }
  // Until the backfill has made it, a file attached before the ledger kept rows looks unattached.
  const through = await checkpoint(services.db)
  if (through === undefined) return counts
  const started = performance.now()
  const within = (minutes: number) => () =>
    services.outOfTime() || performance.now() - started >= minutes * MS_PER_MINUTE
  let firstError: unknown
  const fail = (error: unknown) => {
    counts.failed += 1
    if (counts.failed === 1) firstError = error
  }
  const claimed = new Set<string>()
  const finished = [
    await neverAttached({ services, counts, fail, claimed, done: within(PASS_1_MINUTES) }, through),
    await takenOff({ services, counts, fail, claimed, done: within(STEP_MINUTES) }),
  ]
  if (finished.includes(false)) {
    // The next run carries on.
    logProblem('receipt_cleanup_behind', { counts })
  }
  if (counts.failed > 0) {
    // Nobody sees a scheduled run's result, so this is how a step that fails every run (a revoked
    // scope, say) shows.
    logProblem('receipt_cleanup_failed', { counts, error: firstError })
  }
  return counts
}

/**
 * Pass 1: uploads with no row, created after the checkpoint (`from`) and `KEEP_HOURS` ago or
 * more. Then moves the checkpoint on, never past a file it didn't finish. True if it got to the
 * end.
 */
async function neverAttached(run: Run, from: number): Promise<boolean> {
  const { db, files, now } = run.services
  const to = now.getTime() - KEEP_HOURS * MS_PER_HOUR
  const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
  const gone = new Set<string>()
  // The oldest upload this run didn't finish: one it didn't reach, or made no row for.
  let open: number | undefined
  const leave = (file: BucketFile | undefined) => {
    open = Math.min(open ?? Number.POSITIVE_INFINITY, file ? Date.parse(file.$createdAt) : from)
  }
  let stopped = false
  let last: BucketFile | undefined
  for (let after: string | undefined; !stopped; ) {
    if (run.done()) {
      // The files after the last one it saw are no older than it.
      leave(last)
      stopped = true
      break
    }
    let page: BucketFile[]
    let rows: Set<string>
    try {
      page = await files.listFiles({ ...window, after })
      rows = await rowsOf(db, page)
    } catch (error) {
      // The cursor file was deleted meanwhile, say: the next run carries on.
      run.fail(error)
      leave(last)
      stopped = true
      break
    }
    for (const file of page) {
      if (run.done()) {
        leave(file)
        stopped = true
        break
      }
      last = file
      // A file with a row is attached, or pass 2's.
      if (rows.has(file.$id)) continue
      let made: boolean
      try {
        made = await claim(db, now, file)
      } catch (error) {
        run.fail(error)
        leave(file)
        continue
      }
      if (!made) {
        // The ledger attached it first, so it has a row now: the next run makes sure.
        run.counts.skipped += 1
        leave(file)
        continue
      }
      run.claimed.add(file.$id)
      if (await deleteUnlisted(run, { $id: file.$id, transactionIds: null })) gone.add(file.$id)
    }
    if (page.length < PAGE) break
    // A deleted file can't be a cursor. If this page is all gone, the same cursor finds the next.
    after = page.findLast((file) => !gone.has(file.$id))?.$id ?? after
  }
  const next = open === undefined ? to : open - 1
  if (next > from) {
    try {
      await moveCheckpoint(db, next)
    } catch (error) {
      // It stays where it was, so the next run looks at these files again.
      run.fail(error)
    }
  }
  return !stopped
}

/** Pass 2: rows taken off every transaction `KEEP_HOURS` ago or more. True if it got to the end. */
async function takenOff(run: Run): Promise<boolean> {
  const { db, now } = run.services
  const detachedBy = new Date(now.getTime() - KEEP_HOURS * MS_PER_HOUR).toISOString()
  const rowsBy = now.getTime() - ROW_HOURS * MS_PER_HOUR
  for (let after: string | undefined; ; ) {
    if (run.done()) return false
    let rows: ReceiptFiles[]
    try {
      ;({ rows } = await db.listRows<ReceiptFiles>({
        databaseId: DATABASE_ID,
        tableId: TABLES.receiptFiles,
        // idx_detachedAt. By ID, not a cursor: these rows get deleted.
        queries: [
          Query.lessThanEqual('detachedAt', detachedBy),
          ...(after === undefined ? [] : [Query.greaterThan('$id', after)]),
          Query.orderAsc('$id'),
          Query.limit(PAGE),
        ],
        total: false,
      }))
    } catch (error) {
      // The next run carries on.
      run.fail(error)
      return false
    }
    for (const row of rows) {
      if (run.done()) return false
      // Pass 1 made this row on this run and has dealt with its file; a later run retries it.
      if (run.claimed.has(row.$id)) continue
      if (!row.deletingAt) {
        let marked: boolean
        try {
          marked = await markDeleting(db, now, row)
        } catch (error) {
          run.fail(error)
          continue
        }
        if (!marked) {
          run.counts.skipped += 1
          continue
        }
      }
      // After the file: a row deleted first would let an attach pass with the file still there.
      if (!(await deleteUnlisted(run, row))) continue
      if (row.deletingAt && Date.parse(row.deletingAt) <= rowsBy) {
        try {
          await deleteRow(db, row.$id)
        } catch (error) {
          run.fail(error)
        }
      }
    }
    if (rows.length < PAGE) return true
    after = rows.at(-1)?.$id
  }
}

/** When the checkpoint says uploads are done up to, or undefined to wait (any failed read). */
async function checkpoint(db: Db): Promise<number | undefined> {
  try {
    const row = await db.getRow<Checkpoints>({
      databaseId: DATABASE_ID,
      tableId: TABLES.checkpoints,
      rowId: CHECKPOINT,
    })
    return Date.parse(row.through)
  } catch {
    return undefined
  }
}

/**
 * Moves the checkpoint on. Only this step and the backfill write it, and overlapping runs can
 * move it back, which only means looking at some files again. An update, never an upsert: a row
 * deleted meanwhile stops step 5 (data-model.md#receiptfiles, undoing), and stays deleted.
 */
async function moveCheckpoint(db: Db, through: number): Promise<void> {
  try {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'update',
        tableId: TABLES.checkpoints,
        rowId: CHECKPOINT,
        data: { through: new Date(through).toISOString() },
      }),
    )
  } catch (error) {
    // Gone: staging an update of a missing row is a 409 (withTransaction).
    if (error instanceof AppwriteException && error.code === 409) return
    throw error
  }
}

/**
 * Deletes the file, counted, unless its row as last read lists a transaction: that's a bug in a
 * writer, never a file to delete. True when the file is gone now, or was already.
 */
async function deleteUnlisted(
  { services, counts, fail }: Run,
  row: Pick<ReceiptFiles, '$id' | 'transactionIds'>,
): Promise<boolean> {
  if ((row.transactionIds ?? []).length > 0) {
    logProblem('receipt_row_listed', { rowId: row.$id })
    counts.skipped += 1
    return false
  }
  try {
    counts[(await services.files.deleteFile(row.$id)) ? 'deleted' : 'skipped'] += 1
    return true
  } catch (error) {
    fail(error)
    return false
  }
}

async function rowsOf(db: Db, files: readonly BucketFile[]): Promise<Set<string>> {
  if (files.length === 0) return new Set()
  const { rows } = await db.listRows<ReceiptFiles>({
    databaseId: DATABASE_ID,
    tableId: TABLES.receiptFiles,
    queries: [
      Query.equal(
        '$id',
        files.map(({ $id }) => $id),
      ),
      Query.limit(PAGE),
    ],
    total: false,
  })
  return new Set(rows.map(({ $id }) => $id))
}

/**
 * Makes the row of a never-attached file, already being deleted. False if the row exists by the
 * commit: the ledger attached the file first.
 */
async function claim(db: Db, now: Date, file: BucketFile): Promise<boolean> {
  return lostToTheLedger(() =>
    withTransaction(db, (tx) =>
      tx.write({
        action: 'create',
        tableId: TABLES.receiptFiles,
        rowId: file.$id,
        data: { transactionIds: null, detachedAt: file.$createdAt, deletingAt: now.toISOString() },
        // Server only (permissions.md).
        permissions: [],
      }),
    ),
  )
}

/**
 * Sets `deletingAt` on a detached row: staged first, then checked, so an attach that commits
 * first is seen here or fails this commit, and one after it is refused by the ledger. False if
 * the file was attached again, or the row is gone.
 */
async function markDeleting(db: Db, now: Date, row: ReceiptFiles): Promise<boolean> {
  return lostToTheLedger(() =>
    withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.receiptFiles,
        rowId: row.$id,
        data: { deletingAt: now.toISOString() },
      })
      const staged = await rowGoneIsAttached(() =>
        db.getRow<ReceiptFiles>({
          databaseId: DATABASE_ID,
          tableId: TABLES.receiptFiles,
          rowId: row.$id,
          transactionId: tx.id,
        }),
      )
      if ((staged.transactionIds ?? []).length > 0 || staged.detachedAt !== row.detachedAt) {
        throw new Attached()
      }
    }),
  )
}

async function deleteRow(db: Db, rowId: string): Promise<void> {
  // A row deleted meanwhile, by another run, counts as deleted.
  await lostToTheLedger(() =>
    withTransaction(db, (tx) =>
      tx.write({ action: 'delete', tableId: TABLES.receiptFiles, rowId }),
    ),
  )
}

class Attached extends Error {
  override name = 'Attached'
}

async function rowGoneIsAttached<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    // Staging an update of a missing row is already a 409, so this is a row deleted between the
    // staging and this read.
    if (error instanceof AppwriteException && error.type === 'row_not_found') throw new Attached()
    throw error
  }
}

/**
 * Only the database's conflict: withTransaction reports a row gone as a 409 too. Any other
 * error, a 404 such as an expired transaction or a Storage error included, is a failure.
 */
async function lostToTheLedger(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write()
    return true
  } catch (error) {
    if (error instanceof Attached) return false
    if (error instanceof AppwriteException && error.code === 409) return false
    throw error
  }
}
