import type { ReceiptFiles } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException, Query, type Storage } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanUpReceipts, receiptsBucket } from '../src/steps/receipts'
import { type Fakes, fakes, NOW } from './harness'

// Step 5 (scheduling.md#step-5-receipt-clean-up).

afterEach(() => vi.restoreAllMocks())

const MINUTE = 60_000
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE).toISOString()
const hours = (count: number) => count * 60

const row = (fileId: string, extra: Partial<ReceiptFiles> = {}) => ({
  $id: fileId,
  transactionIds: null,
  detachedAt: null,
  deletingAt: null,
  ...extra,
})

const receiptFiles = (services: Fakes) =>
  Object.fromEntries(
    (services.db.rows('receiptFiles') as unknown as ReceiptFiles[]).map((stored) => [
      stored.$id,
      {
        transactionIds: stored.transactionIds,
        detachedAt: stored.detachedAt,
        deletingAt: stored.deletingAt,
      },
    ]),
  )

/** Commits `data` to the receiptFiles row at once, as the ledger would. */
async function ledgerWrites(
  services: Fakes,
  action: 'create' | 'update',
  rowId: string,
  data: object,
) {
  const { db } = services
  const tx = await db.createTransaction()
  await db.createOperations({
    transactionId: tx.$id,
    operations: [{ action, databaseId: 'main', tableId: 'receiptFiles', rowId, data }],
  })
  await db.updateTransaction({ transactionId: tx.$id, commit: true })
}

/** Deletes the row at once, as another run of the step would. */
async function deleteNow(services: Fakes, rowId: string) {
  const { db } = services
  const tx = await db.createTransaction()
  await db.createOperations({
    transactionId: tx.$id,
    operations: [{ action: 'delete', databaseId: 'main', tableId: 'receiptFiles', rowId }],
  })
  await db.updateTransaction({ transactionId: tx.$id, commit: true })
}

const writesReceiptRows = (params: { operations?: object[] }) =>
  (params.operations ?? []).some(
    (operation) => 'tableId' in operation && operation.tableId === 'receiptFiles',
  )

/** Runs `meanwhile` once, just before the step stages its first receiptFiles write. */
function beforeStaging(services: Fakes, meanwhile: () => Promise<unknown>) {
  const { db } = services
  const stage = db.createOperations.bind(db)
  let done = false
  vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    if (!done && writesReceiptRows(params)) {
      done = true
      await meanwhile()
    }
    return stage(params)
  })
}

/** Runs `meanwhile` once, just before the step commits its first receiptFiles write. */
function beforeCommit(services: Fakes, meanwhile: () => Promise<unknown>) {
  const { db } = services
  const stage = db.createOperations.bind(db)
  const update = db.updateTransaction.bind(db)
  const withRows = new Set<string>()
  let done = false
  vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    if (writesReceiptRows(params)) withRows.add(params.transactionId)
    return stage(params)
  })
  vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit && !done && withRows.has(params.transactionId)) {
      done = true
      await meanwhile()
    }
    return update(params)
  })
}

// The row the ledger makes when it first attaches a file.
const ATTACHED = { transactionIds: ['t1'], detachedAt: null, deletingAt: null }

// Step 5 runs only once the backfill has made its checkpoint (data-model.md#checkpoints).
const checkpointAt = (through: string) => ({ $id: 'receipt-clean-up', through })
const step5 = (seed: Parameters<typeof fakes>[0] = {}, through = ago(hours(72))) =>
  fakes({ checkpoints: [checkpointAt(through)], ...seed })
const through = (services: Fakes) =>
  (services.db.rows('checkpoints')[0] as { through?: string } | undefined)?.through
const justBefore = (time: string) => new Date(Date.parse(time) - 1).toISOString()

describe('step 5: before the backfill', () => {
  it('does nothing until the backfill has made its checkpoint', async () => {
    const services = fakes({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    services.files.upload('r1', ago(hours(200)))
    const listFiles = vi.spyOn(services.files, 'listFiles')
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(listFiles).not.toHaveBeenCalled()
    expect(services.files.stored.size).toBe(2)
    expect(receiptFiles(services).r1?.deletingAt).toBeNull()
  })

  it('does nothing when the checkpoint can’t be read', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    services.files.upload('r1', ago(hours(200)))
    vi.spyOn(services.db, 'getRow').mockRejectedValueOnce(
      new AppwriteException('Server error', 500, 'general_unknown'),
    )
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(services.files.stored.size).toBe(2)
  })
})

describe('step 5: never-attached files', () => {
  it('deletes an upload with no row once it is 24 hours old, and keeps its row as a marker', async () => {
    const services = step5()
    services.files.upload('young', ago(hours(24) - 1))
    services.files.upload('due', ago(hours(24)))
    services.files.upload('old', ago(hours(72)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect([...services.files.stored.keys()]).toEqual(['young', 'old'])
    expect(receiptFiles(services)).toEqual({
      due: { transactionIds: null, detachedAt: ago(hours(24)), deletingAt: NOW.toISOString() },
    })
    expect(services.db.rows('receiptFiles')[0]?.$permissions).toEqual([])
    // Done up to 24 hours ago, so the next run starts there.
    expect(through(services)).toBe(ago(hours(24)))
    expect(services.db.rows('checkpoints')[0]?.$permissions).toEqual([])
  })

  it('leaves an attached file alone', async () => {
    const services = step5({ receiptFiles: [row('f1', { transactionIds: ['t1'] })] })
    services.files.upload('f1', ago(hours(30)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
  })

  it('keeps a file the ledger attaches before the step stages its row', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(30)))
    beforeStaging(services, () => ledgerWrites(services, 'create', 'f1', ATTACHED))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
    expect(receiptFiles(services).f1).toMatchObject({ transactionIds: ['t1'], deletingAt: null })
    // The next run looks at it again, and finds its row.
    expect(through(services)).toBe(justBefore(ago(hours(30))))
  })

  it('keeps a file the ledger attaches after the step staged its row', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(30)))
    beforeCommit(services, () => ledgerWrites(services, 'create', 'f1', ATTACHED))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
  })

  it('finds an upload of any age after the checkpoint, after a long outage', async () => {
    const services = step5({}, ago(hours(200)))
    services.files.upload('f1', ago(hours(150)))
    services.files.upload('before', ago(hours(200)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect([...services.files.stored.keys()]).toEqual(['before'])
  })

  it('takes uploads oldest first, so later ones can’t hold an earlier one back', async () => {
    const services = step5()
    // Uploads with IDs that sort first, made after the one that matters.
    for (let index = 0; index < 150; index++) {
      services.files.upload(`a${String(index).padStart(3, '0')}`, ago(hours(25)))
    }
    services.files.upload('zTarget', ago(hours(30)))
    services.outOfTime = () => !services.files.stored.has('zTarget')
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(services.files.stored.has('zTarget')).toBe(false)
    // The next run starts just before the first upload this one didn't reach.
    expect(through(services)).toBe(justBefore(ago(hours(25))))
  })

  it('keeps the checkpoint before a file it couldn’t make a row for, and tries it again', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(40)))
    services.files.upload('f2', ago(hours(30)))
    const stage = services.db.createOperations.bind(services.db)
    let stagings = 0
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      // The first is f1's row.
      if (++stagings === 1) throw new AppwriteException('Server error', 500, 'general_unknown')
      return stage(params)
    })
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 1 })
    expect(through(services)).toBe(justBefore(ago(hours(40))))
    vi.restoreAllMocks()
    // Pass 2 meets f2's row too, its file already gone.
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 1, failed: 0 })
    expect(services.files.stored.size).toBe(0)
    expect(through(services)).toBe(ago(hours(24)))
  })

  it('never uses a file it deleted as the cursor', async () => {
    const services = step5({ receiptFiles: [row('a150', { transactionIds: ['t1'] })] })
    // The whole first page goes, so the next page starts again from the top of the window.
    for (let index = 0; index < 100; index++) {
      services.files.upload(`f${String(index).padStart(3, '0')}`, ago(hours(30)))
    }
    services.files.upload('a150', ago(hours(30)))
    services.files.upload('g200', ago(hours(30)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 101, skipped: 0, failed: 0 })
    expect([...services.files.stored.keys()]).toEqual(['a150'])
  })

  it('ends the pass when a query fails, and goes on to the taken-off files', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('r1', ago(hours(200)))
    vi.spyOn(services.files, 'listFiles').mockRejectedValueOnce(new Error('cursor gone'))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 1 })
    // It reached nothing, so the checkpoint stays.
    expect(through(services)).toBe(ago(hours(72)))
  })

  it('keeps the checkpoint before the oldest file it left, whatever left it', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(40)))
    services.files.upload('f2', ago(hours(35)))
    services.files.upload('f3', ago(hours(30)))
    const stage = services.db.createOperations.bind(services.db)
    let stagings = 0
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      // f1's row can't be made; f2's can.
      if (++stagings === 1) throw new AppwriteException('Server error', 500, 'general_unknown')
      return stage(params)
    })
    // Time is up before f3.
    services.outOfTime = () => !services.files.stored.has('f2')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 1 })
    expect(through(services)).toBe(justBefore(ago(hours(40))))
  })

  it('keeps the checkpoint at the last file it saw when a later query fails', async () => {
    const services = step5()
    for (let index = 0; index < 100; index++) {
      services.files.upload(`a${String(index).padStart(3, '0')}`, ago(hours(30) - index))
    }
    services.files.upload('later', ago(hours(25)))
    const listFiles = services.files.listFiles.bind(services.files)
    vi.spyOn(services.files, 'listFiles')
      .mockImplementationOnce(listFiles)
      .mockRejectedValueOnce(new Error('cursor gone'))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 100, skipped: 0, failed: 1 })
    expect(through(services)).toBe(justBefore(ago(hours(30) - 99)))
  })

  it('goes through every page of the window', async () => {
    const services = step5({
      // Attached files fill whole pages around the ones to delete.
      receiptFiles: Array.from({ length: 150 }, (_, index) =>
        row(`a${String(index).padStart(3, '0')}`, { transactionIds: ['t1'] }),
      ),
    })
    for (let index = 0; index < 150; index++) {
      services.files.upload(`a${String(index).padStart(3, '0')}`, ago(hours(30)))
    }
    services.files.upload('z1', ago(hours(30)))
    const listFiles = vi.spyOn(services.files, 'listFiles')
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(services.files.stored.has('z1')).toBe(false)
    // A short page is the last.
    expect(listFiles).toHaveBeenCalledTimes(2)
  })
})

describe('step 5: files taken off every transaction', () => {
  it('deletes a file 24 hours after it was taken off, and keeps its row for now', async () => {
    const services = step5({
      receiptFiles: [
        row('young', { detachedAt: ago(hours(24) - 1) }),
        row('due', { detachedAt: ago(hours(24)) }),
      ],
    })
    // Uploaded long ago, so only the rows can find them.
    services.files.upload('young', ago(hours(200)))
    services.files.upload('due', ago(hours(200)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect([...services.files.stored.keys()]).toEqual(['young'])
    expect(receiptFiles(services)).toEqual({
      young: { transactionIds: null, detachedAt: ago(hours(24) - 1), deletingAt: null },
      due: { transactionIds: null, detachedAt: ago(hours(24)), deletingAt: NOW.toISOString() },
    })
  })

  it('keeps a file that another transaction still lists', async () => {
    const services = step5({ receiptFiles: [row('f1', { transactionIds: ['t2'] })] })
    services.files.upload('f1', ago(hours(200)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
  })

  it('keeps a file attached again before the step stages', async () => {
    const services = step5({ receiptFiles: [row('f1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(200)))
    beforeStaging(services, () =>
      ledgerWrites(services, 'update', 'f1', { transactionIds: ['t1'], detachedAt: null }),
    )
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
    expect(receiptFiles(services).f1).toEqual({
      transactionIds: ['t1'],
      detachedAt: null,
      deletingAt: null,
    })
  })

  it('keeps a file attached again after the step staged', async () => {
    const services = step5({ receiptFiles: [row('f1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(200)))
    beforeCommit(services, () =>
      ledgerWrites(services, 'update', 'f1', { transactionIds: ['t1'], detachedAt: null }),
    )
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
  })

  it('keeps a file taken off and put back within the 24 hours, which moved detachedAt', async () => {
    const services = step5({ receiptFiles: [row('f1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(200)))
    beforeStaging(services, () => ledgerWrites(services, 'update', 'f1', { detachedAt: ago(10) }))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
  })
})

describe('step 5: paging the taken-off rows', () => {
  it('goes through every page', async () => {
    const fileIds = Array.from({ length: 150 }, (_, index) => `r${String(index).padStart(3, '0')}`)
    const services = step5({
      receiptFiles: fileIds.map((fileId) => row(fileId, { detachedAt: ago(hours(30)) })),
    })
    for (const fileId of fileIds) services.files.upload(fileId, ago(hours(200)))
    const listRows = vi.spyOn(services.db, 'listRows')
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 150, skipped: 0, failed: 0 })
    // A short page is the last.
    const pages = listRows.mock.calls.filter(([params]) =>
      params.queries?.some((query) => query.includes('detachedAt')),
    )
    expect(pages).toHaveLength(2)
  })
})

describe('step 5: rows already being deleted', () => {
  it('finishes a run that stopped after its commit', async () => {
    const services = step5({
      receiptFiles: [row('f1', { detachedAt: ago(hours(30)), deletingAt: ago(10) })],
    })
    services.files.upload('f1', ago(hours(200)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(false)
    // Less than an hour old: an attach in flight must still find it.
    expect(receiptFiles(services).f1).toMatchObject({ deletingAt: ago(10) })
  })

  it('deletes the file before the row, so the row still refuses an attach meanwhile', async () => {
    const services = step5({
      receiptFiles: [row('f1', { detachedAt: ago(hours(30)), deletingAt: ago(hours(2)) })],
    })
    services.files.upload('f1', ago(hours(25)))
    const deleteFile = services.files.deleteFile.bind(services.files)
    const rowsAtDelete: string[][] = []
    vi.spyOn(services.files, 'deleteFile').mockImplementation(async (fileId) => {
      rowsAtDelete.push(Object.keys(receiptFiles(services)))
      return deleteFile(fileId)
    })
    await cleanUpReceipts(services)
    expect(rowsAtDelete).toEqual([['f1']])
    expect(receiptFiles(services)).toEqual({})
  })

  it('reads Appwrite’s datetimes, which end in +00:00', async () => {
    const appwrite = (minutes: number) => ago(minutes).replace('Z', '+00:00')
    const services = step5({
      receiptFiles: [
        row('recent', { detachedAt: appwrite(hours(30)), deletingAt: appwrite(30) }),
        row('done', { detachedAt: appwrite(hours(30)), deletingAt: appwrite(90) }),
      ],
    })
    await cleanUpReceipts(services)
    expect(Object.keys(receiptFiles(services))).toEqual(['recent'])
  })

  it('deletes the row once its file has been gone an hour', async () => {
    const services = step5({
      receiptFiles: [
        row('recent', { detachedAt: ago(hours(30)), deletingAt: ago(59) }),
        row('done', { detachedAt: ago(hours(30)), deletingAt: ago(60) }),
      ],
    })
    // Both files are gone already.
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 2, failed: 0 })
    expect(Object.keys(receiptFiles(services))).toEqual(['recent'])
  })

  it('deletes a new upload under the ID of a file being deleted', async () => {
    const services = step5({
      receiptFiles: [row('f1', { detachedAt: ago(hours(30)), deletingAt: ago(hours(2)) })],
    })
    services.files.upload('f1', ago(hours(25)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(false)
    expect(receiptFiles(services)).toEqual({})
  })

  it('skips a row another run deleted between the listing and the mark', async () => {
    const services = step5({ receiptFiles: [row('f1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(200)))
    beforeStaging(services, () => deleteNow(services, 'f1'))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
  })

  it('takes a row another run deleted meanwhile as done', async () => {
    const services = step5({
      receiptFiles: [row('f1', { detachedAt: ago(hours(30)), deletingAt: ago(hours(2)) })],
    })
    beforeCommit(services, () => deleteNow(services, 'f1'))
    // Its file was already gone.
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
  })

  it('never deletes a file its row lists a transaction for, and logs the row', async () => {
    // A bug in some writer would leave a row like this.
    const services = step5({
      receiptFiles: [
        row('f1', { transactionIds: ['t1'], detachedAt: ago(hours(30)), deletingAt: ago(10) }),
      ],
    })
    services.files.upload('f1', ago(hours(200)))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 1, failed: 0 })
    expect(services.files.stored.has('f1')).toBe(true)
    expect(receiptFiles(services).f1).toMatchObject({ transactionIds: ['t1'] })
    // IDs only.
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { fn: 'unknown', event: 'receipt_row_listed', rowId: 'f1' },
    ])
  })
})

describe('step 5: limits and failures', () => {
  const serverError = () => new AppwriteException('Server error', 500, 'general_unknown')

  it('counts a claim that fails with any other 404 as failed, and keeps the checkpoint before it', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(30)))
    // The claim's commit: its transaction expired, say.
    vi.spyOn(services.db, 'updateTransaction').mockRejectedValueOnce(
      new AppwriteException('Transaction not found', 404, 'transaction_not_found'),
    )
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 1 })
    expect(services.files.stored.has('f1')).toBe(true)
    expect(through(services)).toBe(justBefore(ago(hours(30))))
  })

  it('leaves a checkpoint deleted during the run deleted, which stops step 5', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(30)))
    const deleteFile = services.files.deleteFile.bind(services.files)
    vi.spyOn(services.files, 'deleteFile').mockImplementation(async (fileId) => {
      // The lead stops step 5 before undoing the ledger's row writes.
      await withTransaction(services.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'checkpoints', rowId: 'receipt-clean-up' }),
      )
      return deleteFile(fileId)
    })
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(services.db.rows('checkpoints')).toEqual([])
    services.files.upload('f2', ago(hours(30)))
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(services.files.stored.has('f2')).toBe(true)
  })

  it('ends pass 1 when reading a page’s rows fails, and goes on to pass 2', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    services.files.upload('r1', ago(hours(200)))
    vi.spyOn(services.db, 'listRows').mockRejectedValueOnce(serverError())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 1 })
    expect(services.files.stored.has('f1')).toBe(true)
    expect(through(services)).toBe(ago(hours(72)))
  })

  it('counts a failed checkpoint write, which stays where it was', async () => {
    const services = step5()
    services.files.upload('f1', ago(hours(30)))
    const stage = services.db.createOperations.bind(services.db)
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      const checkpoint = (params.operations ?? []).some(
        (operation) => 'tableId' in operation && operation.tableId === 'checkpoints',
      )
      if (checkpoint) throw serverError()
      return stage(params)
    })
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 1 })
    expect(through(services)).toBe(ago(hours(72)))
  })

  it('ends pass 2 when a query fails, and says it is behind', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('r1', ago(hours(200)))
    // Pass 1 has no uploads, so this is pass 2's first page.
    vi.spyOn(services.db, 'listRows').mockRejectedValueOnce(serverError())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 1 })
    expect(services.files.stored.has('r1')).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it('queries nothing when the run is already out of time', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    services.outOfTime = () => true
    const listFiles = vi.spyOn(services.files, 'listFiles')
    const listRows = vi.spyOn(services.db, 'listRows')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(listFiles).not.toHaveBeenCalled()
    expect(listRows).not.toHaveBeenCalled()
    expect(through(services)).toBe(ago(hours(72)))
  })

  it('has no count limit', async () => {
    const services = step5()
    for (let index = 0; index < 250; index++) {
      services.files.upload(`f${String(index).padStart(3, '0')}`, ago(hours(30)))
    }
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 250, skipped: 0, failed: 0 })
  })

  it('gives pass 1 at most 2 minutes and the step 4, then says it is behind', async () => {
    const services = step5({
      receiptFiles: ['r1', 'r2', 'r3'].map((fileId) => row(fileId, { detachedAt: ago(hours(30)) })),
    })
    for (const [index, fileId] of ['f1', 'f2', 'f3'].entries()) {
      services.files.upload(fileId, ago(hours(30) - index))
    }
    for (const fileId of ['r1', 'r2', 'r3']) services.files.upload(fileId, ago(hours(200)))
    // Each delete takes a minute.
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const deleteFile = services.files.deleteFile.bind(services.files)
    vi.spyOn(services.files, 'deleteFile').mockImplementation(async (fileId) => {
      clock += MINUTE
      return deleteFile(fileId)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 4, skipped: 0, failed: 0 })
    expect([...services.files.stored.keys()].sort()).toEqual(['f3', 'r3'])
    expect(through(services)).toBe(justBefore(ago(hours(30) - 2)))
    // Counts only.
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        fn: 'unknown',
        event: 'receipt_cleanup_behind',
        counts: { deleted: 4, skipped: 0, failed: 0 },
      },
    ])
  })

  it('stops when the run’s time is up', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    services.files.upload('f2', ago(hours(30)))
    services.files.upload('r1', ago(hours(200)))
    services.outOfTime = () => !services.files.stored.has('f1')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(services.files.stored.has('f2')).toBe(true)
    expect(services.files.stored.has('r1')).toBe(true)
  })

  it('counts a Storage failure, even a 409, and carries on', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    services.files.upload('r1', ago(hours(200)))
    const deleteFile = services.files.deleteFile.bind(services.files)
    vi.spyOn(services.files, 'deleteFile').mockImplementation(async (fileId) => {
      if (fileId === 'f1') throw new AppwriteException('Conflict', 409, 'storage_conflict')
      return deleteFile(fileId)
    })
    expect(await cleanUpReceipts(services)).toEqual({ deleted: 1, skipped: 0, failed: 1 })
    // Its row stays, so pass 2 tries again on a later run.
    expect(receiptFiles(services).f1).toMatchObject({ deletingAt: NOW.toISOString() })
  })

  it('logs nothing when it gets through everything', async () => {
    const services = step5({ receiptFiles: [row('r1', { detachedAt: ago(hours(30)) })] })
    services.files.upload('f1', ago(hours(30)))
    const logs = ['log', 'info', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation(() => {}),
    )
    await cleanUpReceipts(services)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})

describe('receiptsBucket', () => {
  const storage = (overrides: Partial<Record<'listFiles' | 'deleteFile', unknown>>) =>
    ({
      listFiles: vi.fn(async () => ({ total: 0, files: [] })),
      deleteFile: vi.fn(async () => ({})),
      ...overrides,
    }) as unknown as Storage & {
      listFiles: ReturnType<typeof vi.fn>
      deleteFile: ReturnType<typeof vi.fn>
    }

  it('lists a page of the window oldest first, after the cursor file', async () => {
    const stub = storage({
      listFiles: vi.fn(async () => ({
        total: 0,
        files: [{ $id: 'f2', $createdAt: ago(hours(30)), name: 'Sam’s receipt.jpg' }],
      })),
    })
    const from = ago(hours(72))
    const to = ago(hours(24))
    expect(await receiptsBucket(stub).listFiles({ from, to, after: 'f1' })).toEqual([
      { $id: 'f2', $createdAt: ago(hours(30)) },
    ])
    expect(stub.listFiles).toHaveBeenCalledWith({
      bucketId: 'receipts',
      queries: [
        Query.greaterThan('$createdAt', from),
        Query.lessThanEqual('$createdAt', to),
        Query.orderAsc('$createdAt'),
        Query.orderAsc('$id'),
        Query.limit(100),
        Query.cursorAfter('f1'),
      ],
      total: false,
    })
    await receiptsBucket(stub).listFiles({ from, to })
    expect(stub.listFiles.mock.calls[1]?.[0].queries).not.toContain(Query.cursorAfter('f1'))
  })

  it('deletes a file, and tells a missing one apart from any other failure', async () => {
    const gone = new AppwriteException('Not found', 404, 'storage_file_not_found')
    const noBucket = new AppwriteException('Not found', 404, 'storage_bucket_not_found')
    const stub = storage({
      deleteFile: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(gone)
        .mockRejectedValueOnce(noBucket),
    })
    const bucket = receiptsBucket(stub)
    expect(await bucket.deleteFile('f1')).toBe(true)
    expect(stub.deleteFile).toHaveBeenCalledWith({ bucketId: 'receipts', fileId: 'f1' })
    expect(await bucket.deleteFile('f2')).toBe(false)
    await expect(bucket.deleteFile('f3')).rejects.toBe(noBucket)
  })
})
