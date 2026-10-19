import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { describe, expect, it } from 'vitest'
import { bundleBackfill } from '../../../scripts/backfill-bundle.mjs'

// scripts/backfill-receipt-files.mjs runs this bundle, not the source the other tests import,
// with the clients from the same bundle (#305 review).
describe('the backfill script’s bundle', () => {
  it('takes a 409 from its own node-appwrite as a conflict', async () => {
    const bundle = await bundleBackfill()
    const db = new FakeDb()
    const stage = db.createOperations.bind(db)
    db.createOperations = async (params) => {
      const rows = (params.operations ?? []).some(
        (operation) => 'tableId' in operation && operation.tableId === 'receiptFiles',
      )
      // The ledger made f1's row first: the error the script's TablesDB would throw.
      if (rows) throw new bundle.AppwriteException('Row exists', 409, 'row_already_exists')
      return stage(params)
    }
    const counts = await bundle.backfillReceiptFiles(
      db,
      async () => ['f1'],
      new Date('2026-10-19T06:00:00.000Z'),
    )
    expect(counts).toMatchObject({ swept: 0 })
    // It went on to write the checkpoint.
    expect(db.rows('checkpoints')).toHaveLength(1)
  }, 60_000)
})
