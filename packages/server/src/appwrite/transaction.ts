import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type { Db } from './client'
import { DATABASE_ID, type TableId } from './tables'

type RowData = Record<string, unknown>

/** One write. `permissions` replace the row's permissions; leave them out to keep them. */
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
  /** Pass as `transactionId` to reads to see this transaction's staged writes merged in. */
  id: string
  /**
   * Stages the writes now, in one request. If any of these rows changes outside the
   * transaction after this, the commit fails with 409. Await it before reading those rows.
   * `withTransaction` also waits for every staging before it commits, and if one failed it
   * rolls back and throws that error, even if the route caught it.
   */
  write(...writes: Write[]): Promise<void>
}

/**
 * Runs `work` in a TablesDB transaction and commits what it staged. If `work` throws, the
 * transaction is rolled back and the error rethrown. A commit conflict (409) is rethrown for
 * the route to retry. One transaction holds at most MAX_OPS_PER_DB_TRANSACTION writes
 * (scaling.md).
 *
 * To guard a row, for example never to change a locked transaction (I-7): stage the write to
 * it first, then read it with `transactionId: tx.id` and check it. Appwrite only detects
 * changes made after a row was staged, so check after staging, never before.
 */
export async function withTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const { $id: transactionId } = await db.createTransaction()
  let requested = 0
  let staged = 0
  // Every staging call, settled, so nothing commits while one is still in flight, even one
  // the route forgot to await. Each resolves to its error, or undefined.
  const stagings: Array<Promise<{ error: unknown } | undefined>> = []
  const stage = async (writes: Write[]) => {
    requested += writes.length
    if (requested > MAX_OPS_PER_DB_TRANSACTION) {
      throw new Error(
        `A transaction holds at most ${MAX_OPS_PER_DB_TRANSACTION} writes, got ${requested}`,
      )
    }
    await db.createOperations({ transactionId, operations: writes.map(toOperation) })
    staged += writes.length
  }
  const tx: Tx = {
    id: transactionId,
    write(...writes) {
      const staging = stage(writes)
      stagings.push(
        staging.then(
          () => undefined,
          (error: unknown) => ({ error }),
        ),
      )
      return staging
    },
  }
  let result: T
  try {
    result = await work(tx)
    const failed = (await Promise.all(stagings)).find((outcome) => outcome !== undefined)
    if (failed) throw failed.error
  } catch (error) {
    await Promise.all(stagings)
    await rollback(db, transactionId)
    throw error
  }
  if (staged === 0) {
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
    await withTransaction(db, (tx) => tx.write(...batch))
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
  // System fields such as $createdAt are Appwrite's alone; claim relies on it (D-016).
  const systemKey = Object.keys(write.data).find((key) => key.startsWith('$'))
  if (systemKey) {
    throw new Error(`Row data may not set ${systemKey}; pass permissions as \`permissions\``)
  }
  // createOperations has no permissions field, so they go into the row data as $permissions.
  const data =
    write.permissions === undefined
      ? write.data
      : { ...write.data, $permissions: write.permissions }
  return { action: write.action, ...target, data }
}
