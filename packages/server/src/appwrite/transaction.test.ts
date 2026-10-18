import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type { Transactions } from '@ledgerly/core/generated/rows'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../http/app-error'
import { FakeDb } from './fake'
import { DATABASE_ID } from './tables'
import { type Write, withTransaction, writeInBatches } from './transaction'

function seeded() {
  return new FakeDb({
    shares: [
      { $id: 's1', transactionId: 't1', givenCents: 100 },
      { $id: 's2', transactionId: 't1', givenCents: 0 },
    ],
    transactions: [{ $id: 't1', description: 'Rent', statementId: null }],
  })
}

const team = ['read("team:g1")']

describe('withTransaction', () => {
  it('stages each write call in one request as it happens, then commits them together', async () => {
    const db = seeded()
    const createOperations = vi.spyOn(db, 'createOperations')
    const result = await withTransaction(db, async (tx) => {
      await tx.write(
        { action: 'delete', tableId: 'shares', rowId: 's2' },
        { action: 'update', tableId: 'shares', rowId: 's1', data: { givenCents: 150 } },
      )
      expect(createOperations).toHaveBeenCalledTimes(1)
      await tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: 't2',
        data: { totalCents: 150 },
        permissions: team,
      })
      return 'done'
    })
    expect(result).toBe('done')
    expect(createOperations.mock.calls.map(([params]) => params.operations)).toEqual([
      [
        { action: 'delete', databaseId: 'main', tableId: 'shares', rowId: 's2' },
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'shares',
          rowId: 's1',
          data: { givenCents: 150 },
        },
      ],
      [
        {
          action: 'create',
          databaseId: 'main',
          tableId: 'transactions',
          rowId: 't2',
          data: { totalCents: 150, $permissions: team },
        },
      ],
    ])
    expect(db.rows('shares').map((row) => [row.$id, row.givenCents])).toEqual([['s1', 150]])
    expect(db.rows('transactions')).toContainEqual(
      expect.objectContaining({ $id: 't2', totalCents: 150, $permissions: team }),
    )
  })

  it('fails with 409 when a staged row changes before the commit, and applies nothing', async () => {
    const db = seeded()
    const edit = withTransaction(db, async (tx) => {
      await tx.write(
        {
          action: 'update',
          tableId: 'transactions',
          rowId: 't1',
          data: { description: 'Rent (Oct)' },
        },
        { action: 'delete', tableId: 'shares', rowId: 's2' },
      )
      // Meanwhile, a finalize locks t1 in its own transaction.
      await withTransaction(db, (finalize) =>
        finalize.write({
          action: 'update',
          tableId: 'transactions',
          rowId: 't1',
          data: { statementId: 'st1' },
        }),
      )
    })
    await expect(edit).rejects.toBeInstanceOf(AppwriteException)
    await expect(edit).rejects.toMatchObject({ code: 409, type: 'transaction_conflict' })
    expect(db.rows('transactions')[0]).toMatchObject({ description: 'Rent', statementId: 'st1' })
    expect(db.rows('shares')).toHaveLength(2)
  })

  it('does not see a change made before the write was staged, so checks come after staging', async () => {
    const db = seeded()
    await withTransaction(db, async (tx) => {
      // A check here would pass, then the finalize below locks t1 before the edit is staged.
      await withTransaction(db, (finalize) =>
        finalize.write({
          action: 'update',
          tableId: 'transactions',
          rowId: 't1',
          data: { statementId: 'st1' },
        }),
      )
      await tx.write({
        action: 'update',
        tableId: 'transactions',
        rowId: 't1',
        data: { description: 'Rent (Oct)' },
      })
    })
    // The commit succeeded and changed a locked row: only a check after staging prevents this.
    expect(db.rows('transactions')[0]).toMatchObject({
      description: 'Rent (Oct)',
      statementId: 'st1',
    })
  })

  it('lets a route guard a row: stage the write, then read it in the transaction and check', async () => {
    const db = seeded()
    const locked = new AppError('LOCKED', 'This transaction is on a final invoice.')
    await withTransaction(db, (finalize) =>
      finalize.write({
        action: 'update',
        tableId: 'transactions',
        rowId: 't1',
        data: { statementId: 'st1' },
      }),
    )
    const edit = withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: 'transactions',
        rowId: 't1',
        data: { description: 'Rent (Oct)' },
      })
      const row = await db.getRow<Transactions>({
        databaseId: DATABASE_ID,
        tableId: 'transactions',
        rowId: 't1',
        transactionId: tx.id,
      })
      expect(row).toMatchObject({ description: 'Rent (Oct)', statementId: 'st1' })
      if (row.statementId) throw locked
    })
    await expect(edit).rejects.toBe(locked)
    expect(db.rows('transactions')[0]).toMatchObject({ description: 'Rent' })
  })

  it('rolls back and rethrows when the work throws', async () => {
    const db = seeded()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    const forbidden = new AppError('FORBIDDEN', 'Admins only')
    await expect(
      withTransaction(db, async (tx) => {
        await tx.write({ action: 'delete', tableId: 'shares', rowId: 's1' })
        throw forbidden
      }),
    ).rejects.toBe(forbidden)
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
    expect(db.rows('shares')).toHaveLength(2)
  })

  it('rolls back when staging fails', async () => {
    const db = seeded()
    vi.spyOn(db, 'createOperations').mockRejectedValueOnce(new Error('network'))
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    await expect(
      withTransaction(db, (tx) => tx.write({ action: 'delete', tableId: 'shares', rowId: 's1' })),
    ).rejects.toThrow('network')
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
    expect(db.rows('shares')).toHaveLength(2)
  })

  it('keeps the original error when the rollback fails too', async () => {
    const db = seeded()
    vi.spyOn(db, 'updateTransaction').mockRejectedValueOnce(new Error('rollback failed'))
    await expect(
      withTransaction(db, async () => {
        throw new AppError('LOCKED', 'Locked')
      }),
    ).rejects.toMatchObject({ code: 'LOCKED' })
  })

  it('applies nothing when an operation fails at commit', async () => {
    const db = seeded()
    const commit = withTransaction(db, (tx) =>
      tx.write(
        { action: 'delete', tableId: 'shares', rowId: 's2' },
        { action: 'create', tableId: 'shares', rowId: 's1', data: {} },
      ),
    )
    await expect(commit).rejects.toMatchObject({ code: 409, type: 'row_already_exists' })
    expect(db.rows('shares').map((row) => row.$id)).toEqual(['s1', 's2'])
  })

  it('rolls back instead of committing when nothing was written', async () => {
    const db = seeded()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    expect(await withTransaction(db, async () => 42)).toBe(42)
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
  })

  it('refuses row data that sets a system field such as $createdAt', async () => {
    const db = seeded()
    await expect(
      withTransaction(db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'transactions',
          rowId: 't1',
          data: { $createdAt: '2000-01-01T00:00:00.000Z' },
        }),
      ),
    ).rejects.toThrow('Row data may not set $createdAt')
    expect(db.rows('transactions')[0]?.$createdAt).not.toBe('2000-01-01T00:00:00.000Z')
  })

  it(`refuses more than ${MAX_OPS_PER_DB_TRANSACTION} writes across calls`, async () => {
    const db = new FakeDb()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    const writes = creates(MAX_OPS_PER_DB_TRANSACTION + 1)
    await expect(
      withTransaction(db, async (tx) => {
        await tx.write(...writes.slice(0, MAX_OPS_PER_DB_TRANSACTION))
        await tx.write(...writes.slice(MAX_OPS_PER_DB_TRANSACTION))
      }),
    ).rejects.toThrow(`at most ${MAX_OPS_PER_DB_TRANSACTION} writes`)
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
    expect(db.rows('activity')).toEqual([])
  })
})

describe('writeInBatches', () => {
  it(`commits in transactions of at most ${MAX_OPS_PER_DB_TRANSACTION} writes`, async () => {
    const db = new FakeDb()
    const createOperations = vi.spyOn(db, 'createOperations')
    await writeInBatches(db, creates(2 * MAX_OPS_PER_DB_TRANSACTION + 5))
    expect(createOperations.mock.calls.map(([params]) => params.operations?.length)).toEqual([
      MAX_OPS_PER_DB_TRANSACTION,
      MAX_OPS_PER_DB_TRANSACTION,
      5,
    ])
    expect(db.rows('activity')).toHaveLength(2 * MAX_OPS_PER_DB_TRANSACTION + 5)
  })

  it('keeps earlier batches when a later one fails', async () => {
    const db = new FakeDb({ activity: [{ $id: `a${MAX_OPS_PER_DB_TRANSACTION + 1}` }] })
    await expect(writeInBatches(db, creates(MAX_OPS_PER_DB_TRANSACTION + 2))).rejects.toMatchObject(
      { code: 409 },
    )
    expect(db.rows('activity')).toHaveLength(MAX_OPS_PER_DB_TRANSACTION + 1)
  })

  it('does nothing for no writes', async () => {
    const db = new FakeDb()
    const createTransaction = vi.spyOn(db, 'createTransaction')
    await writeInBatches(db, [])
    expect(createTransaction).not.toHaveBeenCalled()
  })
})

function creates(count: number): Write[] {
  return Array.from({ length: count }, (_, index) => ({
    action: 'create' as const,
    tableId: 'activity' as const,
    rowId: `a${index}`,
    data: { action: 'test' },
  }))
}
