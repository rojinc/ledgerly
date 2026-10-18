import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type { Db } from './client'
import { DATABASE_ID, type TableId } from './tables'

type RowData = Record<string, unknown>

/** One staged write. `permissions` replace the row's permissions. */
export type Write =
  | {
      action: 'create' | 'update' | 'upsert'
      tableId: TableId
      rowId: string
      data: RowData
      permissions?: string[]
    }
  | { action: 'delete'; tableId: TableId; rowId: string }

export type Tx = {
  /** Pass as `transactionId` to reads that should see this transaction's staged changes. */
  id: string
  write(...writes: Write[]): void
}

/**
 * Runs `work`, then stages everything it wrote in one `createOperations` call and commits.
 * If `work` or staging throws, the transaction is rolled back and the error rethrown. A
 * commit conflict (409: a row changed outside the transaction) is rethrown for the route to
 * retry. One transaction holds at most MAX_OPS_PER_DB_TRANSACTION writes (scaling.md).
 */
export async function withTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const { $id: transactionId } = await db.createTransaction()
  const writes: Write[] = []
  let result: T
  try {
    result = await work({ id: transactionId, write: (...more) => writes.push(...more) })
    if (writes.length > MAX_OPS_PER_DB_TRANSACTION) {
      throw new Error(
        `A transaction holds at most ${MAX_OPS_PER_DB_TRANSACTION} writes, got ${writes.length}`,
      )
    }
    if (writes.length > 0) {
      await db.createOperations({ transactionId, operations: writes.map(toOperation) })
    }
  } catch (error) {
    await rollback(db, transactionId)
    throw error
  }
  if (writes.length === 0) {
    await rollback(db, transactionId)
  } else {
    await db.updateTransaction({ transactionId, commit: true })
  }
  return result
}

/**
 * Commits `writes` in batches of MAX_OPS_PER_DB_TRANSACTION, one transaction each. Only for
 * bulk jobs (locking, merges) whose writes are idempotent: if a batch fails, the earlier ones
 * stay committed, and running the job again must finish the rest.
 */
export async function writeInBatches(db: Db, writes: Write[]): Promise<void> {
  for (let start = 0; start < writes.length; start += MAX_OPS_PER_DB_TRANSACTION) {
    const batch = writes.slice(start, start + MAX_OPS_PER_DB_TRANSACTION)
    await withTransaction(db, async (tx) => tx.write(...batch))
  }
}

async function rollback(db: Db, transactionId: string): Promise<void> {
  try {
    await db.updateTransaction({ transactionId, rollback: true })
  } catch {
    // Nothing more to do: a transaction that isn't committed expires with its staged writes
    // unapplied, and the caller needs the original error, not this one.
  }
}

function toOperation(write: Write): object {
  const target = { databaseId: DATABASE_ID, tableId: write.tableId, rowId: write.rowId }
  if (write.action === 'delete') return { action: 'delete', ...target }
  // createOperations has no permissions field, so they go into the row data as $permissions.
  const data =
    write.permissions === undefined
      ? write.data
      : { ...write.data, $permissions: write.permissions }
  return { action: write.action, ...target, data }
}
