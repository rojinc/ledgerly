import type { ReceiptFiles } from '@ledgerly/core/generated/rows'
import { Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { TABLES } from '../appwrite/tables'
import type { Tx, Write } from '../appwrite/transaction'
import { listAll, Raced } from './transactions'

/** One file in a write: the transactions that list it from now on, and the ones that stop. */
export type ReceiptChange = {
  fileId: string
  add?: readonly string[]
  remove?: readonly string[]
}

/** The `receiptFiles` rows of these files, by file ID (data-model.md#receiptfiles). */
export async function receiptRows(
  db: Db,
  fileIds: readonly string[],
): Promise<Map<string, ReceiptFiles>> {
  if (fileIds.length === 0) return new Map()
  const rows = await listAll<ReceiptFiles>(db, TABLES.receiptFiles, [
    Query.equal('$id', [...fileIds]),
  ])
  return new Map(rows.map((row) => [row.$id, row]))
}

/**
 * Stages one write per file from `rows` as the caller read them, however many of `changes`
 * name it, then reads the rows again as committed: through the transaction this would read
 * back the staged values. Any row that changed meanwhile throws `Raced`, and a change after the
 * staging, or a row deleted before it, fails the commit or the staging with 409
 * (data-model.md#receiptfiles, every writer).
 */
export async function writeReceiptRows(
  db: Db,
  tx: Tx,
  rows: ReadonlyMap<string, ReceiptFiles>,
  changes: readonly ReceiptChange[],
  now: Date,
): Promise<void> {
  const byFile = new Map<string, { add: Set<string>; remove: Set<string> }>()
  for (const { fileId, add = [], remove = [] } of changes) {
    const change = byFile.get(fileId) ?? { add: new Set(), remove: new Set() }
    for (const id of add) change.add.add(id)
    for (const id of remove) change.remove.add(id)
    byFile.set(fileId, change)
  }
  if (byFile.size === 0) return
  const writes = [...byFile].map(([fileId, change]) =>
    rowWrite(rows.get(fileId), fileId, change, now),
  )
  await tx.write(...writes)
  const fileIds = [...byFile.keys()]
  const current = await receiptRows(db, fileIds)
  if (fileIds.some((fileId) => !sameRow(rows.get(fileId), current.get(fileId)))) {
    throw new Raced()
  }
}

/** The file's row with `add` listing it and `remove` no longer listing it. */
function rowWrite(
  row: ReceiptFiles | undefined,
  fileId: string,
  { add, remove }: { add: ReadonlySet<string>; remove: ReadonlySet<string> },
  now: Date,
): Write {
  const kept = (row?.transactionIds ?? []).filter((id) => !add.has(id) && !remove.has(id))
  const transactionIds = [...kept, ...add]
  const data = {
    transactionIds: transactionIds.length > 0 ? transactionIds : null,
    detachedAt: transactionIds.length > 0 ? null : now.toISOString(),
  }
  const target = { tableId: TABLES.receiptFiles, rowId: fileId }
  return row
    ? { action: 'update', ...target, data }
    : // Server only: no permissions (permissions.md).
      { action: 'create', ...target, data: { ...data, deletingAt: null }, permissions: [] }
}

function sameRow(a: ReceiptFiles | undefined, b: ReceiptFiles | undefined): boolean {
  const columns = (row: ReceiptFiles | undefined) =>
    row && JSON.stringify([row.transactionIds ?? [], row.detachedAt, row.deletingAt])
  return columns(a) === columns(b)
}
