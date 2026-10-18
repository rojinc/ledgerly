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
const AT = '2026-10-18T00:00:00.000Z'

function activity(extra = {}) {
  return { groupId: 'g1', action: 'test', summary: 'Test', at: AT, ...extra }
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Staging that takes a few milliseconds, as over the network, so a missing await shows.
function slowStaging(db: FakeDb): FakeDb {
  const stage = db.createOperations.bind(db)
  vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    await later(5)
    return stage(params)
  })
  return db
}

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
        tableId: 'activity',
        rowId: 'a1',
        data: activity(),
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
          tableId: 'activity',
          rowId: 'a1',
          data: { ...activity(), $permissions: team },
        },
      ],
    ])
    expect(db.rows('shares').map((row) => [row.$id, row.givenCents])).toEqual([['s1', 150]])
    expect(db.rows('activity')).toEqual([
      expect.objectContaining({ $id: 'a1', summary: 'Test', $permissions: team }),
    ])
  })

  it('waits for a staging the route forgot to await before it commits', async () => {
    const db = slowStaging(seeded())
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: 'transactions',
        rowId: 't1',
        data: { description: 'Rent (Oct)' },
      })
      // No await: the commit must still include this delete.
      void tx.write({ action: 'delete', tableId: 'shares', rowId: 's2' })
    })
    expect(db.rows('transactions')[0]).toMatchObject({ description: 'Rent (Oct)' })
    expect(db.rows('shares').map((row) => row.$id)).toEqual(['s1'])
  })

  it('rolls back and throws when a staging fails, even one the route did not await', async () => {
    const db = slowStaging(seeded())
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    await expect(
      withTransaction(db, async (tx) => {
        await tx.write({
          action: 'update',
          tableId: 'shares',
          rowId: 's1',
          data: { givenCents: 1 },
        })
        void tx.write({
          action: 'update',
          tableId: 'shares',
          rowId: 's2',
          data: { $createdAt: AT },
        })
      }),
    ).rejects.toThrow('Row data may not set $createdAt')
    expect(updateTransaction).toHaveBeenCalledTimes(1)
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
    expect(db.rows('shares')[0]).toMatchObject({ givenCents: 100 })
  })

  it('rolls back, not commits, when the route catches a failed staging', async () => {
    const db = seeded()
    const createOperations = vi.spyOn(db, 'createOperations')
    createOperations.mockRejectedValueOnce(new Error('network'))
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    await expect(
      withTransaction(db, async (tx) => {
        await tx
          .write({ action: 'delete', tableId: 'shares', rowId: 's1' })
          .catch(() => 'ignored on purpose')
      }),
    ).rejects.toThrow('network')
    expect(updateTransaction).toHaveBeenCalledWith({ transactionId: 'tx1', rollback: true })
    expect(updateTransaction).not.toHaveBeenCalledWith(expect.objectContaining({ commit: true }))
    expect(db.rows('shares')).toHaveLength(2)
  })

  it('stages writes in call order, even when the route awaits neither', async () => {
    const db = seeded()
    const stage = db.createOperations.bind(db)
    // The first request is slower than the second, as can happen over the network.
    const delays = [10, 1]
    vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
      await later(delays.shift() ?? 0)
      return stage(params)
    })
    await withTransaction(db, async (tx) => {
      const update = (description: string) =>
        tx.write({ action: 'update', tableId: 'transactions', rowId: 't1', data: { description } })
      void update('first')
      void update('second')
    })
    expect(db.rows('transactions')[0]).toMatchObject({ description: 'second' })
  })

  it('refuses writes that start after the work has resolved, and commits none of them', async () => {
    const db = seeded()
    const updateTransaction = vi.spyOn(db, 'updateTransaction')
    const errors: unknown[] = []
    await withTransaction(db, async (tx) => {
      // biome-ignore lint/nursery/noMisusedPromises: the mistake this test is about
      ;['s1', 's2'].forEach(async (rowId) => {
        try {
          await later(5) // a read before each write
          await tx.write({ action: 'delete', tableId: 'shares', rowId })
        } catch (error) {
          errors.push(error)
        }
      })
    })
    await later(20)
    expect(errors).toEqual([
      new Error('tx.write was called after the transaction ended; await every write'),
      new Error('tx.write was called after the transaction ended; await every write'),
    ])
    expect(updateTransaction).not.toHaveBeenCalledWith(expect.objectContaining({ commit: true }))
    expect(db.rows('shares')).toHaveLength(2)
  })

  it('rolls everything back when a late write comes before the commit is sent', async () => {
    const db = slowStaging(seeded())
    const errors: unknown[] = []
    await expect(
      withTransaction(db, async (tx) => {
        // Still staging when the work resolves.
        void tx.write({ action: 'update', tableId: 'shares', rowId: 's1', data: { givenCents: 1 } })
        setTimeout(() => {
          tx.write({ action: 'delete', tableId: 'shares', rowId: 's2' }).catch((error: unknown) => {
            errors.push(error)
          })
        }, 1)
      }),
    ).rejects.toThrow('tx.write was called after the transaction ended')
    expect(errors).toHaveLength(1)
    expect(db.rows('shares')).toMatchObject([{ givenCents: 100 }, { $id: 's2' }])
  })

  it('cannot undo a commit for writes that come after it, which is why the lint rules matter', async () => {
    const db = slowStaging(seeded())
    const errors: unknown[] = []
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: 'transactions',
        rowId: 't1',
        data: { description: 'Rent (Oct)' },
      })
      // biome-ignore lint/nursery/noMisusedPromises: the mistake this test is about
      ;['s1', 's2'].forEach(async (rowId) => {
        try {
          await later(20) // longer than the commit takes
          await tx.write({ action: 'delete', tableId: 'shares', rowId })
        } catch (error) {
          errors.push(error)
        }
      })
    })
    await later(40)
    // The awaited write is committed; the late deletes were refused, not staged.
    expect(db.rows('transactions')[0]).toMatchObject({ description: 'Rent (Oct)' })
    expect(db.rows('shares')).toHaveLength(2)
    expect(errors).toHaveLength(2)
  })

  it('does not crash the process when nobody awaits a late write', async () => {
    const db = slowStaging(seeded())
    await expect(
      withTransaction(db, async (tx) => {
        void tx.write({ action: 'update', tableId: 'shares', rowId: 's1', data: { givenCents: 1 } })
        // Vitest fails the run on an unhandled rejection.
        setTimeout(() => {
          void tx.write({ action: 'delete', tableId: 'shares', rowId: 's2' })
        }, 1)
      }),
    ).rejects.toThrow('tx.write was called after the transaction ended')
    await later(10)
  })

  it('sends no more writes after a staging fails', async () => {
    const db = seeded()
    const createOperations = vi.spyOn(db, 'createOperations')
    createOperations.mockRejectedValueOnce(new Error('network'))
    await expect(
      withTransaction(db, async (tx) => {
        await tx
          .write({ action: 'delete', tableId: 'shares', rowId: 's1' })
          .catch(() => 'ignored on purpose')
        await expect(
          tx.write({ action: 'delete', tableId: 'shares', rowId: 's2' }),
        ).rejects.toThrow('network')
      }),
    ).rejects.toThrow('network')
    expect(createOperations).toHaveBeenCalledTimes(1)
    expect(db.rows('shares')).toHaveLength(2)
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
    data: activity(),
  }))
}
