import type { ReceiptFiles } from '@ledgerly/core/generated/rows'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { describe, expect, it, vi } from 'vitest'
import { backfillReceiptFiles } from '../src/backfill-receipt-files'

// data-model.md#receiptfiles: the one-off backfill for files attached before the ledger kept rows.

const tx = (id: string, receiptFileIds: string[] | null) => ({
  $id: id,
  groupId: 'house',
  receiptFileIds,
})
const row = (fileId: string, extra: Partial<ReceiptFiles> = {}) => ({
  $id: fileId,
  transactionIds: null,
  detachedAt: null,
  deletingAt: null,
  ...extra,
})

const NOW = new Date('2026-10-19T06:00:00.000Z')
const LATER = '2026-10-19T05:30:00.000Z'
const noFiles = async () => []

/** The bucket's file IDs, a page of 100 at a time by ID, as the script lists them. */
const bucket =
  (...fileIds: string[]) =>
  async (after: string | undefined) =>
    [...fileIds]
      .sort()
      .filter((fileId) => after === undefined || fileId > after)
      .slice(0, 100)

const receiptFiles = (db: FakeDb) =>
  Object.fromEntries(
    (db.rows('receiptFiles') as unknown as ReceiptFiles[]).map((stored) => [
      stored.$id,
      {
        transactionIds: stored.transactionIds,
        detachedAt: stored.detachedAt,
        deletingAt: stored.deletingAt,
      },
    ]),
  )

describe('backfillReceiptFiles', () => {
  it('gives every file no transaction lists, and with no row, a row taken off now', async () => {
    const db = new FakeDb({
      transactions: [tx('t1', ['listed'])],
      // Taken off after the ledger change: the ledger made its row.
      receiptFiles: [row('detached', { detachedAt: '2026-10-19T05:00:00.000Z' })],
    })
    const files = bucket('listed', 'detached', 'old-upload', 'removed-before')
    expect(await backfillReceiptFiles(db, files, NOW)).toEqual({
      updated: 1,
      unchanged: 0,
      deleting: 0,
      swept: 2,
    })
    expect(receiptFiles(db)).toEqual({
      listed: { transactionIds: ['t1'], detachedAt: null, deletingAt: null },
      detached: { transactionIds: null, detachedAt: '2026-10-19T05:00:00.000Z', deletingAt: null },
      'old-upload': { transactionIds: null, detachedAt: NOW.toISOString(), deletingAt: null },
      'removed-before': { transactionIds: null, detachedAt: NOW.toISOString(), deletingAt: null },
    })
    expect(await backfillReceiptFiles(db, files, NOW)).toMatchObject({ unchanged: 1, swept: 0 })
  })

  it('makes the checkpoint that lets step 5 start, last, from when it started', async () => {
    const db = new FakeDb({ transactions: [tx('t1', ['f1'])] })
    let checkpoints: unknown[] | undefined
    const files = async () => {
      // The bucket is read before the checkpoint is written.
      checkpoints ??= db.rows('checkpoints')
      return ['f2']
    }
    await backfillReceiptFiles(db, files, NOW)
    expect(checkpoints).toEqual([])
    expect(db.rows('checkpoints')).toEqual([
      expect.objectContaining({ $id: 'receipt-clean-up', through: NOW.toISOString() }),
    ])
    expect(db.rows('checkpoints')[0]?.$permissions).toEqual([])
    // Run again, it moves the checkpoint to the new start: its sweep covered the files before.
    const later = new Date('2026-10-20T06:00:00.000Z')
    await backfillReceiptFiles(db, files, later)
    expect(db.rows('checkpoints')[0]?.through).toBe(later.toISOString())
  })

  it('reads every page of the bucket', async () => {
    const db = new FakeDb()
    const fileIds = Array.from({ length: 250 }, (_, index) => `f${String(index).padStart(3, '0')}`)
    expect(await backfillReceiptFiles(db, bucket(...fileIds), NOW)).toMatchObject({ swept: 250 })
  })

  it('leaves a file the ledger attaches before the sweep commits', async () => {
    const db = new FakeDb()
    const update = db.updateTransaction.bind(db)
    let done = false
    vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && !done) {
        done = true
        const other = await db.createTransaction()
        await db.createOperations({
          transactionId: other.$id,
          operations: [
            {
              action: 'create',
              databaseId: 'main',
              tableId: 'receiptFiles',
              rowId: 'f1',
              data: { transactionIds: ['t1'], detachedAt: null, deletingAt: null },
            },
          ],
        })
        await update({ transactionId: other.$id, commit: true })
      }
      return update(params)
    })
    expect(await backfillReceiptFiles(db, bucket('f1'), NOW)).toMatchObject({ swept: 0 })
    expect(receiptFiles(db).f1?.transactionIds).toEqual(['t1'])
  })

  it('only ever creates a row in the sweep, so an attach just before its staging wins', async () => {
    const db = new FakeDb()
    const stage = db.createOperations.bind(db)
    let done = false
    vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
      if (!done) {
        done = true
        // The ledger attaches f1 after the sweep read no row for it.
        const other = await db.createTransaction()
        await stage({
          transactionId: other.$id,
          operations: [
            {
              action: 'create',
              databaseId: 'main',
              tableId: 'receiptFiles',
              rowId: 'f1',
              data: { transactionIds: ['t1'], detachedAt: null, deletingAt: null },
            },
          ],
        })
        await db.updateTransaction({ transactionId: other.$id, commit: true })
      }
      return stage(params)
    })
    expect(await backfillReceiptFiles(db, bucket('f1'), NOW)).toMatchObject({ swept: 0 })
    expect(receiptFiles(db).f1?.transactionIds).toEqual(['t1'])
  })

  it('throws, with no checkpoint, when a file’s row keeps changing', async () => {
    const db = new FakeDb({
      transactions: [tx('t1', ['f1'])],
      receiptFiles: [row('f1', { detachedAt: '2026-10-19T05:00:00.000Z' })],
    })
    const stage = db.createOperations.bind(db)
    let changes = 0
    vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
      const rows = (params.operations ?? []).some(
        (operation) => 'tableId' in operation && operation.tableId === 'receiptFiles',
      )
      if (rows) {
        // Someone changes the row before every staging.
        const other = await db.createTransaction()
        await stage({
          transactionId: other.$id,
          operations: [
            {
              action: 'update',
              databaseId: 'main',
              tableId: 'receiptFiles',
              rowId: 'f1',
              data: { detachedAt: `2026-10-19T05:0${++changes}:00.000Z` },
            },
          ],
        })
        await db.updateTransaction({ transactionId: other.$id, commit: true })
      }
      return stage(params)
    })
    await expect(backfillReceiptFiles(db, bucket('f1'), NOW)).rejects.toThrow()
    expect(changes).toBe(3)
    expect(db.rows('checkpoints')).toEqual([])
  })

  /** Commits `operations` at once, as the ledger would. */
  async function commitNow(db: FakeDb, ...operations: Record<string, unknown>[]) {
    const tx = await db.createTransaction()
    await db.createOperations({
      transactionId: tx.$id,
      operations: operations.map((operation) => ({ databaseId: 'main', ...operation })),
    })
    await db.updateTransaction({ transactionId: tx.$id, commit: true })
  }

  it('counts only files in a list, as isNotNull also matches []', async () => {
    const db = new FakeDb({ transactions: [tx('t1', [])] })
    expect(await backfillReceiptFiles(db, bucket('f1'), NOW)).toEqual({
      updated: 0,
      unchanged: 0,
      deleting: 0,
      swept: 1,
    })
  })

  it('never adds a transaction that dropped the file since the pass read it', async () => {
    const db = new FakeDb({ transactions: [tx('t1', ['f1'])] })
    const list = db.listRows.bind(db)
    let done = false
    vi.spyOn(db, 'listRows').mockImplementation(async (params) => {
      if (!done && params.tableId === 'receiptFiles') {
        done = true
        // The new ledger takes f1 off t1, and writes f1's row taken off.
        await commitNow(
          db,
          { action: 'update', tableId: 'transactions', rowId: 't1', data: { receiptFileIds: [] } },
          {
            action: 'create',
            tableId: 'receiptFiles',
            rowId: 'f1',
            data: { transactionIds: null, detachedAt: LATER, deletingAt: null },
          },
        )
      }
      return list(params)
    })
    expect(await backfillReceiptFiles(db, bucket('f1'), NOW)).toMatchObject({
      updated: 0,
      unchanged: 1,
    })
    // Still taken off, so step 5 deletes it.
    expect(receiptFiles(db).f1).toEqual({
      transactionIds: null,
      detachedAt: LATER,
      deletingAt: null,
    })
  })

  it('starts a file again when a transaction drops it after the staging', async () => {
    const db = new FakeDb({ transactions: [tx('t1', ['f1'])] })
    const stage = db.createOperations.bind(db)
    let done = false
    vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
      const result = await stage(params)
      const rows = (params.operations ?? []).some(
        (operation) => 'tableId' in operation && operation.tableId === 'receiptFiles',
      )
      if (!done && rows) {
        done = true
        // Only the transaction changes: the re-read of the row alone wouldn't see it.
        await commitNow(db, {
          action: 'update',
          tableId: 'transactions',
          rowId: 't1',
          data: { receiptFileIds: [] },
        })
      }
      return result
    })
    expect(await backfillReceiptFiles(db, bucket('f1'), NOW)).toMatchObject({
      updated: 0,
      unchanged: 1,
      swept: 1,
    })
    // No transaction lists it any more, so the sweep gives it a row taken off now.
    expect(receiptFiles(db).f1).toEqual({
      transactionIds: null,
      detachedAt: NOW.toISOString(),
      deletingAt: null,
    })
  })

  it('lists every transaction on each file, and changes nothing when run again', async () => {
    const db = new FakeDb({
      transactions: [tx('t1', ['f1', 'f2']), tx('t2', ['f1']), tx('t3', null)],
    })
    expect(await backfillReceiptFiles(db, noFiles, NOW)).toEqual({
      updated: 2,
      unchanged: 0,
      deleting: 0,
      swept: 0,
    })
    expect(receiptFiles(db)).toEqual({
      f1: { transactionIds: ['t1', 't2'], detachedAt: null, deletingAt: null },
      f2: { transactionIds: ['t1'], detachedAt: null, deletingAt: null },
    })
    expect(db.rows('receiptFiles').map((stored) => stored.$permissions)).toEqual([[], []])
    expect(await backfillReceiptFiles(db, noFiles, NOW)).toEqual({
      updated: 0,
      unchanged: 2,
      deleting: 0,
      swept: 0,
    })
  })

  it('adds to the rows the new ledger made, and undoes a detach it made without the others', async () => {
    const db = new FakeDb({
      // f1 was on t1 before the change, then attached to t2 after it; f2 was then taken off t3.
      transactions: [tx('t1', ['f1', 'f2']), tx('t2', ['f1']), tx('t3', null)],
      receiptFiles: [
        row('f1', { transactionIds: ['t2'] }),
        row('f2', { detachedAt: '2026-10-19T00:00:00.000Z' }),
      ],
    })
    expect(await backfillReceiptFiles(db, noFiles, NOW)).toEqual({
      updated: 2,
      unchanged: 0,
      deleting: 0,
      swept: 0,
    })
    expect(receiptFiles(db)).toEqual({
      f1: { transactionIds: ['t2', 't1'], detachedAt: null, deletingAt: null },
      f2: { transactionIds: ['t1'], detachedAt: null, deletingAt: null },
    })
  })

  it('leaves a row the scheduler is deleting alone, and counts it', async () => {
    const deleting = row('f1', {
      detachedAt: '2026-10-17T00:00:00.000Z',
      deletingAt: '2026-10-18T00:00:00.000Z',
    })
    const db = new FakeDb({ transactions: [tx('t1', ['f1'])], receiptFiles: [deleting] })
    expect(await backfillReceiptFiles(db, noFiles, NOW)).toEqual({
      updated: 0,
      unchanged: 0,
      deleting: 1,
      swept: 0,
    })
    expect(receiptFiles(db).f1).toMatchObject({ deletingAt: '2026-10-18T00:00:00.000Z' })
  })

  it('reads every page of transactions', async () => {
    const transactions = Array.from({ length: 250 }, (_, index) =>
      tx(`t${String(index).padStart(3, '0')}`, ['f1']),
    )
    const db = new FakeDb({ transactions })
    await backfillReceiptFiles(db, noFiles, NOW)
    expect(receiptFiles(db).f1?.transactionIds).toHaveLength(250)
  })

  it('reads a row again when the ledger changes it meanwhile', async () => {
    const db = new FakeDb({
      transactions: [tx('t1', ['f1'])],
      receiptFiles: [row('f1', { transactionIds: ['t1'], detachedAt: '2026-10-19T00:00:00.000Z' })],
    })
    const stage = db.createOperations.bind(db)
    let done = false
    vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
      if (!done) {
        done = true
        // The ledger attaches f1 to t2 just before the backfill stages.
        const other = await db.createTransaction()
        await stage({
          transactionId: other.$id,
          operations: [
            {
              action: 'update',
              databaseId: 'main',
              tableId: 'receiptFiles',
              rowId: 'f1',
              data: { transactionIds: ['t1', 't2'], detachedAt: null },
            },
          ],
        })
        await db.updateTransaction({ transactionId: other.$id, commit: true })
      }
      return stage(params)
    })
    expect(await backfillReceiptFiles(db, noFiles, NOW)).toEqual({
      updated: 0,
      unchanged: 1,
      deleting: 0,
      swept: 0,
    })
    expect(receiptFiles(db).f1?.transactionIds).toEqual(['t1', 't2'])
  })
})
