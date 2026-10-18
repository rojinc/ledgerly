import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../http/app-error'
import { FakeDb } from './fake'
import { type Write, withTransaction, writeInBatches } from './transaction'

function seeded() {
  return new FakeDb({
    shares: [
      { $id: 's1', transactionId: 't1', givenCents: 100 },
      { $id: 's2', transactionId: 't1', givenCents: 0 },
    ],
  })
}

const team = ['read("team:g1")']

describe('withTransaction', () => {
  it('stages every write in one call and commits them together', async () => {
    const db = seeded()
    const createOperations = vi.spyOn(db, 'createOperations')
    const result = await withTransaction(db, async (tx) => {
      tx.write(
        { action: 'delete', tableId: 'shares', rowId: 's2' },
        { action: 'update', tableId: 'shares', rowId: 's1', data: { givenCents: 150 } },
      )
      tx.write({
        action: 'create',
        tableId: 'transactions',
        rowId: 't2',
        data: { totalCents: 150 },
        permissions: team,
      })
      tx.write({ action: 'upsert', tableId: 'shares', rowId: 's3', data: { givenCents: 0 } })
      return 'done'
    })
    expect(result).toBe('done')
    expect(createOperations).toHaveBeenCalledTimes(1)
    expect(createOperations.mock.calls[0]?.[0].operations).toEqual([
      { action: 'delete', databaseId: 'main', tableId: 'shares', rowId: 's2' },
      {
        action: 'update',
        databaseId: 'main',
        tableId: 'shares',
        rowId: 's1',
        data: { givenCents: 150 },
      },
      {
        action: 'create',
        databaseId: 'main',
        tableId: 'transactions',
        rowId: 't2',
        data: { totalCents: 150, $permissions: team },
      },
      {
        action: 'upsert',
        databaseId: 'main',
        tableId: 'shares',
        rowId: 's3',
        data: { givenCents: 0 },
      },
    ])
    expect(db.rows('shares').map((row) => [row.$id, row.givenCents])).toEqual([
      ['s1', 150],
      ['s3', 0],
    ])
    expect(db.rows('transactions')).toEqual([
      expect.objectContaining({ $id: 't2', totalCents: 150, $permissions: team }),
    ])
  })

  it('rolls back and rethrows when the work throws', async () => {
    const db = seeded()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    const forbidden = new AppError('FORBIDDEN', 'Admins only')
    await expect(
      withTransaction(db, async (tx) => {
        tx.write({ action: 'delete', tableId: 'shares', rowId: 's1' })
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
      withTransaction(db, async (tx) => {
        tx.write({ action: 'delete', tableId: 'shares', rowId: 's1' })
      }),
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

  it('applies nothing when the commit fails, and rethrows the conflict', async () => {
    const db = seeded()
    const commit = withTransaction(db, async (tx) => {
      tx.write(
        { action: 'delete', tableId: 'shares', rowId: 's2' },
        { action: 'create', tableId: 'shares', rowId: 's1', data: {} },
      )
    })
    await expect(commit).rejects.toBeInstanceOf(AppwriteException)
    await expect(commit).rejects.toMatchObject({ code: 409 })
    expect(db.rows('shares').map((row) => row.$id)).toEqual(['s1', 's2'])
  })

  it('rolls back instead of committing when nothing was written', async () => {
    const db = seeded()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    expect(await withTransaction(db, async () => 42)).toBe(42)
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
  })

  it('gives the work the transaction ID for its reads', async () => {
    const db = seeded()
    const id = await withTransaction(db, async (tx) => tx.id)
    expect(id).toBe('tx1')
  })

  it(`refuses more than ${MAX_OPS_PER_DB_TRANSACTION} writes`, async () => {
    const db = new FakeDb()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    await expect(
      withTransaction(db, async (tx) => tx.write(...creates(MAX_OPS_PER_DB_TRANSACTION + 1))),
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
