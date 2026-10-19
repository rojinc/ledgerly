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
  it('lists every transaction on each file, and changes nothing when run again', async () => {
    const db = new FakeDb({
      transactions: [tx('t1', ['f1', 'f2']), tx('t2', ['f1']), tx('t3', null)],
    })
    expect(await backfillReceiptFiles(db)).toEqual({ updated: 2, unchanged: 0, deleting: 0 })
    expect(receiptFiles(db)).toEqual({
      f1: { transactionIds: ['t1', 't2'], detachedAt: null, deletingAt: null },
      f2: { transactionIds: ['t1'], detachedAt: null, deletingAt: null },
    })
    expect(db.rows('receiptFiles').map((stored) => stored.$permissions)).toEqual([[], []])
    expect(await backfillReceiptFiles(db)).toEqual({ updated: 0, unchanged: 2, deleting: 0 })
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
    expect(await backfillReceiptFiles(db)).toEqual({ updated: 2, unchanged: 0, deleting: 0 })
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
    expect(await backfillReceiptFiles(db)).toEqual({ updated: 0, unchanged: 0, deleting: 1 })
    expect(receiptFiles(db).f1).toMatchObject({ deletingAt: '2026-10-18T00:00:00.000Z' })
  })

  it('reads every page of transactions', async () => {
    const transactions = Array.from({ length: 250 }, (_, index) =>
      tx(`t${String(index).padStart(3, '0')}`, ['f1']),
    )
    const db = new FakeDb({ transactions })
    await backfillReceiptFiles(db)
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
    expect(await backfillReceiptFiles(db)).toEqual({ updated: 0, unchanged: 1, deleting: 0 })
    expect(receiptFiles(db).f1?.transactionIds).toEqual(['t1', 't2'])
  })
})
