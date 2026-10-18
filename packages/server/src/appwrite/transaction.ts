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
   * Stages the writes in one request, after every earlier `write` call has staged, so writes
   * apply in call order. If any of these rows changes outside the transaction after this, the
   * commit fails with 409. Always await it (Biome's `noFloatingPromises` checks). As a safety
   * net, `withTransaction` waits for every staging before it commits, and if one failed it
   * rolls back and throws that error, even if the route caught it. Once `work` has resolved,
   * `write` stages nothing and throws.
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
  // Each staging starts once the one before has settled, so two writes to the same row apply
  // in call order even without await. `stagings` is the last of them, settled, so awaiting it
  // waits for them all; `failed` keeps the first error.
  let stagings: Promise<void> = Promise.resolve()
  let failed: { error: unknown } | undefined
  // Set once `work` has settled. A write after that stages nothing and throws, and one that
  // comes before the commit is sent (a floating promise in the route) rolls everything back.
  let ended = false
  let late: Error | undefined
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
      if (ended) {
        late ??= new Error('tx.write was called after the transaction ended; await every write')
        const refused = Promise.reject(late)
        // Handled here as well, so a write nobody awaits doesn't crash the process with an
        // unhandled rejection. A caller that awaits it still gets the error.
        refused.catch(() => {})
        return refused
      }
      // After a failed staging the transaction will roll back, so send nothing more.
      const staging = stagings.then(() => {
        if (failed) throw failed.error
        return stage(writes)
      })
      stagings = staging.then(
        () => undefined,
        (error: unknown) => {
          failed ??= { error }
        },
      )
      return staging
    },
  }
  let result: T
  try {
    result = await work(tx)
    ended = true
    await stagings
    if (failed) throw failed.error
    if (late) throw late
  } catch (error) {
    ended = true
    await stagings
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
