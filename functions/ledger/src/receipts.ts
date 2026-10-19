import type { ReceiptFiles } from '@ledgerly/core/generated/rows'
import { clientFromRequest, type Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import type { Tx, Write } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { listAll, Raced, teamRead } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, type Models, Query, Storage } from 'node-appwrite'

// data-model.md#storage-buckets
export const RECEIPTS_BUCKET = 'receipts'

// permissions.md#storage: images and PDFs only.
const RECEIPT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]

/** What the check needs to know about a file. */
export type ReceiptFile = { mimeType: string; permissions: string[]; complete: boolean }

/** The parts of Appwrite Storage the ledger function uses. Tests pass a fake. */
export interface Files {
  /** The file in the receipts bucket, or undefined if the bucket has no file with this ID. */
  getFile(fileId: string): Promise<ReceiptFile | undefined>
  /** Replaces the file's permissions with exactly these, and returns the file as it is now. */
  updateFile(fileId: string, permissions: string[]): Promise<ReceiptFile | undefined>
}

/** Storage for this execution, with the per-execution API key. */
export function filesFromRequest(headers: Record<string, string>): Files {
  const storage = new Storage(clientFromRequest(headers))
  const bucketId = RECEIPTS_BUCKET
  return {
    getFile: (fileId) => missingIfNotFound(storage.getFile({ bucketId, fileId })),
    updateFile: (fileId, permissions) =>
      missingIfNotFound(storage.updateFile({ bucketId, fileId, permissions })),
  }
}

async function missingIfNotFound(request: Promise<Models.File>): Promise<ReceiptFile | undefined> {
  try {
    const file = await request
    return {
      mimeType: file.mimeType,
      permissions: file.$permissions,
      // An unfinished upload's remaining chunks could still change it.
      complete: file.chunksUploaded === file.chunksTotal,
    }
  } catch (error) {
    // A file in another bucket, such as `statements`, is missing from this one too.
    if (error instanceof AppwriteException && error.type === 'storage_file_not_found') {
      return undefined
    }
    throw error
  }
}

/**
 * Any Storage failure but a missing file. It isn't an AppwriteException, so ledgerRoute never
 * takes a Storage 409 for a database race: it answers INTERNAL.
 */
class StorageError extends Error {
  constructor(cause: unknown) {
    super('Storage failed')
    // createHandler logs the name of a 5xx's cause: Appwrite's code and type, never a message.
    this.name =
      cause instanceof AppwriteException
        ? `StorageError ${cause.code} ${cause.type}`
        : 'StorageError'
  }
}

async function storage<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    throw new StorageError(error)
  }
}

const usable = (file: ReceiptFile | undefined): file is ReceiptFile =>
  file?.complete === true && RECEIPT_TYPES.includes(file.mimeType)

/** A write's new receipt list for one transaction. */
export type ReceiptList = {
  groupId: string
  transactionId: string
  fileIds: readonly string[]
  /** The list on the stored row; empty for a new transaction. */
  stored?: readonly string[]
  now: Date
}

/**
 * permissions.md#storage: checks each file in `fileIds` that isn't in `stored` already, and
 * only once every one passes, limits each to the group's team. Then stages the `receiptFiles`
 * row of each file added or taken off (data-model.md#receiptfiles). Routes call it inside their
 * database transaction, just before their own writes, so the reset lands before the commit: a
 * stored ID never points at a file its uploader can still change or delete. A refused list
 * changes no file, and the error names its index only, never anything about the file.
 */
export async function attachReceipts(
  files: Files,
  db: Db,
  tx: Tx,
  { groupId, transactionId, fileIds, stored = [], now }: ReceiptList,
): Promise<void> {
  const added = fileIds
    .map((fileId, index) => ({ fileId, index }))
    .filter(({ fileId }) => !stored.includes(fileId))
  const removed = stored.filter((fileId) => !fileIds.includes(fileId))
  const changed = [...added.map(({ fileId }) => fileId), ...removed]
  if (changed.length === 0) return
  // Before the files, so a file the scheduler is deleting is refused before any file is reset
  // (scheduling.md#step-5-receipt-clean-up).
  const rows = await receiptRows(db, changed)
  const [team] = teamRead(groupId) as [string]
  const found = await Promise.all(added.map(({ fileId }) => storage(() => files.getFile(fileId))))
  refuse(
    added.filter(
      ({ fileId }, at) =>
        rows.get(fileId)?.deletingAt ||
        !(usable(found[at]) && found[at].permissions.includes(team)),
    ),
  )
  const reset = await Promise.all(
    added.map(({ fileId }) => storage(() => files.updateFile(fileId, [team]))),
  )
  // Until its reset, an uploader who kept `delete` could swap the file for another under the
  // same ID. Nobody but the server can change it now, so this second look is the one that counts.
  refuse(added.filter((_, at) => !usable(reset[at])))
  const writes = changed.map((fileId) =>
    rowWrite(rows.get(fileId), fileId, {
      transactionId,
      listed: fileIds.includes(fileId),
      now,
    }),
  )
  try {
    await tx.write(...writes)
  } catch (error) {
    // Appwrite refuses to stage an update of a row deleted meanwhile: run the route again.
    if (error instanceof AppwriteException && error.code === 404) throw new Raced()
    throw error
  }
  // Staged first, then checked, as committed: through the transaction this would read back our
  // own staged values. A row that changed before the staging shows here, and one that changes
  // after it fails the commit (ledger.md#concurrency).
  const current = await receiptRows(db, changed)
  if (changed.some((fileId) => !sameRow(rows.get(fileId), current.get(fileId)))) throw new Raced()
}

async function receiptRows(db: Db, fileIds: string[]): Promise<Map<string, ReceiptFiles>> {
  const rows = await listAll<ReceiptFiles>(db, TABLES.receiptFiles, [Query.equal('$id', fileIds)])
  return new Map(rows.map((row) => [row.$id, row]))
}

/** The file's row once this transaction lists it (`listed`) or no longer does. */
function rowWrite(
  row: ReceiptFiles | undefined,
  fileId: string,
  change: { transactionId: string; listed: boolean; now: Date },
): Write {
  const others = (row?.transactionIds ?? []).filter((id) => id !== change.transactionId)
  const transactionIds = change.listed ? [...others, change.transactionId] : others
  const data = {
    transactionIds: transactionIds.length > 0 ? transactionIds : null,
    detachedAt: transactionIds.length > 0 ? null : change.now.toISOString(),
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

// One answer for every failure, so the reply never shows whether a file ID exists.
function refuse(bad: readonly { index: number }[]): void {
  if (bad.length === 0) return
  throw new AppError(
    'VALIDATION_FAILED',
    'Some receipts can’t be attached.',
    bad.map(({ index }) => ({
      code: 'custom',
      path: ['receiptFileIds', index],
      message: 'This file can’t be attached to this transaction.',
    })),
  )
}

/** The `receiptFileIds` column: no receipts is stored as null, as on rows from before #43. */
export function receiptsColumn(fileIds: readonly string[]): string[] | null {
  return fileIds.length > 0 ? [...fileIds] : null
}

export function sameReceipts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((fileId, index) => fileId === b[index])
}
