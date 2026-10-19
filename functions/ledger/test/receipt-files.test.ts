import type { ReceiptFiles } from '@ledgerly/core/generated/rows'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, filesOf, MEMBERS, NOW, rows, seed } from './harness'

// data-model.md#receiptfiles: the ledger keeps a row for each file a transaction lists, so the
// scheduler can delete the files nobody lists (scheduling.md#step-5-receipt-clean-up).

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

const LATER = '2026-10-18T05:00:00.000Z'

const receiptFiles = (db: Db) =>
  Object.fromEntries(
    (db.rows('receiptFiles') as unknown as ReceiptFiles[]).map((row) => [
      row.$id,
      {
        transactionIds: row.transactionIds,
        detachedAt: row.detachedAt,
        deletingAt: row.deletingAt,
      },
    ]),
  )

const listed = (...transactionIds: string[]) => ({
  transactionIds,
  detachedAt: null,
  deletingAt: null,
})
const detached = (at = NOW.toISOString()) => ({
  transactionIds: null,
  detachedAt: at,
  deletingAt: null,
})

// A house with photos f1, f2 and f3 uploaded for it, and Alice's expense t1 listing `receipts`.
async function withExpense(receiptFileIds?: string[]) {
  const db = seed()
  for (const fileId of ['f1', 'f2', 'f3']) filesOf(db).upload(fileId, 'house')
  const response = await call(db, 'POST', '/transactions', expense({ receiptFileIds }))
  expect(response.body.error).toBeUndefined()
  return db
}

const setReceipts = (db: Db, receiptFileIds: string[], id = 't1') =>
  call(db, 'POST', `/transactions/${id}/receipts`, { receiptFileIds })

/** Commits `operations` at once, as the scheduler would. */
async function commitNow(db: Db, ...operations: Record<string, unknown>[]) {
  const tx = await db.createTransaction()
  await db.createOperations({
    transactionId: tx.$id,
    operations: operations.map((operation) => ({
      databaseId: 'main',
      tableId: 'receiptFiles',
      ...operation,
    })),
  })
  await db.updateTransaction({ transactionId: tx.$id, commit: true })
}

// Scheduler step 5, pass 2: it starts deleting a file taken off every transaction.
const startDeleting = (db: Db, fileId: string) =>
  commitNow(db, { action: 'update', rowId: fileId, data: { deletingAt: LATER } })

// Pass 1: it starts deleting a file it found no row for.
const startDeletingNew = (db: Db, fileId: string) =>
  commitNow(db, {
    action: 'create',
    rowId: fileId,
    data: { transactionIds: null, detachedAt: NOW.toISOString(), deletingAt: LATER },
  })

/** Runs `meanwhile` once, just before this request commits. */
function beforeCommit(db: Db, meanwhile: () => Promise<unknown>) {
  const update = db.updateTransaction.bind(db)
  let done = false
  vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit && !done) {
      done = true
      await meanwhile()
    }
    return update(params)
  })
}

// The same answer as for a missing file (permissions.md#storage).
const refusedAt = (index: number) => ({
  code: 'VALIDATION_FAILED',
  details: [{ code: 'custom', path: ['receiptFileIds', index], message: expect.any(String) }],
})

describe('the receiptFiles rows', () => {
  it('lists the transaction on each file when it is created with receipts', async () => {
    const db = await withExpense(['f1', 'f2'])
    expect(receiptFiles(db)).toEqual({ f1: listed('t1'), f2: listed('t1') })
    // Server only (permissions.md).
    expect(db.rows('receiptFiles').map((row) => row.$permissions)).toEqual([[], []])
  })

  it('reads and writes no row when no file is added or taken off', async () => {
    const db = seed()
    const listRows = vi.spyOn(db, 'listRows')
    await call(db, 'POST', '/transactions', expense())
    await call(db, 'PATCH', '/transactions/t1', expense({ totalCents: 8000 }))
    expect(receiptFiles(db)).toEqual({})
    // Appwrite refuses an `equal` query with no values.
    expect(listRows.mock.calls.filter(([params]) => params.tableId === 'receiptFiles')).toEqual([])
  })

  it('adds and takes off files on /receipts, and marks when a file was taken off', async () => {
    const db = await withExpense(['f1', 'f2'])
    vi.setSystemTime(new Date(LATER))
    expect((await setReceipts(db, ['f2', 'f3'])).status).toBe(200)
    expect(receiptFiles(db)).toEqual({
      f1: detached(LATER),
      f2: listed('t1'),
      f3: listed('t1'),
    })
  })

  it('writes no row when only the order changes', async () => {
    const db = await withExpense(['f1', 'f2'])
    const before = db.rows('receiptFiles')
    expect((await setReceipts(db, ['f2', 'f1'])).status).toBe(200)
    expect(db.rows('receiptFiles')).toEqual(before)
  })

  it('clears detachedAt when a file is put back within its 24 hours', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    expect(receiptFiles(db)).toEqual({ f1: detached() })
    await setReceipts(db, ['f1'])
    expect(receiptFiles(db)).toEqual({ f1: listed('t1') })
  })

  it('keeps a file listed while another transaction still lists it', async () => {
    const db = await withExpense(['f1'])
    await call(db, 'POST', '/transactions', expense({ id: 't2', receiptFileIds: ['f1'] }))
    expect(receiptFiles(db)).toEqual({ f1: listed('t1', 't2') })
    await setReceipts(db, [], 't1')
    expect(receiptFiles(db)).toEqual({ f1: listed('t2') })
    await setReceipts(db, [], 't2')
    expect(receiptFiles(db)).toEqual({ f1: detached() })
  })

  it('writes the rows on PATCH, and keeps them when the body has no list', async () => {
    const db = await withExpense(['f1'])
    await call(db, 'PATCH', '/transactions/t1', expense({ totalCents: 8000 }))
    expect(receiptFiles(db)).toEqual({ f1: listed('t1') })
    await call(db, 'PATCH', '/transactions/t1', expense({ receiptFileIds: ['f2'] }))
    expect(receiptFiles(db)).toEqual({ f1: detached(), f2: listed('t1') })
  })

  it('keeps the files of a voided transaction listed', async () => {
    const db = await withExpense(['f1'])
    const response = await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect(response.status).toBe(200)
    expect(receiptFiles(db)).toEqual({ f1: listed('t1') })
  })

  it('lists a transaction once when its row already names it', async () => {
    const db = await withExpense([])
    // As a revert and the backfill might leave it: the row lists t1, and t1 doesn't list f1.
    await commitNow(db, {
      action: 'create',
      rowId: 'f1',
      data: listed('t1'),
      permissions: [],
    })
    expect((await setReceipts(db, ['f1'])).body.error).toBeUndefined()
    expect(receiptFiles(db)).toEqual({ f1: listed('t1') })
  })

  it('makes a detached row for a file taken off that has none (attached before #163)', async () => {
    const db = await withExpense(['f1'])
    // As for a file attached before the ledger kept these rows.
    await commitNow(db, { action: 'delete', rowId: 'f1' })
    await setReceipts(db, [])
    expect(receiptFiles(db)).toEqual({ f1: detached() })
  })
})

describe('a file the scheduler is deleting', () => {
  it('is refused like a missing file, and nothing is written or reset', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    filesOf(db).upload('f2', 'house', { permissions: ['read("any")', 'read("team:house")'] })
    await startDeleting(db, 'f1')
    const response = await setReceipts(db, ['f2', 'f1'])
    expect(response.status).toBe(400)
    expect(response.body.error).toMatchObject(refusedAt(1))
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(receiptFiles(db).f2).toBeUndefined()
    // The good file isn't limited to the team: the list was refused before any reset.
    expect(filesOf(db).permissions('f2')).toEqual(['read("any")', 'read("team:house")'])
  })

  it('is refused on create and PATCH too', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    await startDeleting(db, 'f1')
    const created = await call(
      db,
      'POST',
      '/transactions',
      expense({ id: 't2', receiptFileIds: ['f1'] }),
    )
    expect(created.body.error).toMatchObject(refusedAt(0))
    const patched = await call(db, 'PATCH', '/transactions/t1', expense({ receiptFileIds: ['f1'] }))
    expect(patched.body.error).toMatchObject(refusedAt(0))
  })

  it('is refused when the scheduler starts after the rows were read and before the staging', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    // getFile runs after the rows are read and before anything is staged.
    const getFile = filesOf(db).getFile.bind(filesOf(db))
    vi.spyOn(filesOf(db), 'getFile').mockImplementationOnce(async (fileId) => {
      await startDeleting(db, 'f1')
      return getFile(fileId)
    })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error).toMatchObject(refusedAt(0))
    expect(receiptFiles(db).f1).toMatchObject({ transactionIds: null, deletingAt: LATER })
  })

  it('is refused when a never-attached file gets its row after the read', async () => {
    const db = await withExpense()
    const getFile = filesOf(db).getFile.bind(filesOf(db))
    vi.spyOn(filesOf(db), 'getFile').mockImplementationOnce(async (fileId) => {
      await startDeletingNew(db, 'f1')
      return getFile(fileId)
    })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error).toMatchObject(refusedAt(0))
    expect(receiptFiles(db).f1).toMatchObject({ transactionIds: null, deletingAt: LATER })
  })

  it('is refused when the scheduler commits after the staging', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    beforeCommit(db, () => startDeleting(db, 'f1'))
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error).toMatchObject(refusedAt(0))
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
  })

  it('is refused when a never-attached file gets its row after the staging', async () => {
    const db = await withExpense()
    beforeCommit(db, () => startDeletingNew(db, 'f1'))
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error).toMatchObject(refusedAt(0))
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
  })

  it('is refused when the file and its row are both gone by the staging', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    const files = filesOf(db)
    const update = files.updateFile.bind(files)
    vi.spyOn(files, 'updateFile').mockImplementationOnce(async (fileId, permissions) => {
      const file = await update(fileId, permissions)
      // The whole of pass 2, after the reset and before this request stages.
      await startDeleting(db, 'f1')
      files.stored.delete('f1')
      await commitNow(db, { action: 'delete', rowId: 'f1' })
      return file
    })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error).toMatchObject(refusedAt(0))
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(receiptFiles(db)).toEqual({})
  })

  it('stores the list when the scheduler gave up on the file first', async () => {
    // Pass 2 found it attached again and skipped it: deletingAt never got set.
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    beforeCommit(db, () =>
      commitNow(db, { action: 'update', rowId: 'f1', data: { detachedAt: LATER } }),
    )
    expect((await setReceipts(db, ['f1'])).status).toBe(200)
    expect(receiptFiles(db)).toEqual({ f1: listed('t1') })
  })
})

describe('two writes to one file at once', () => {
  it('keeps both transactions when another attach commits between the read and the staging', async () => {
    const db = await withExpense(['f1'])
    for (const id of ['t2', 't3']) await call(db, 'POST', '/transactions', expense({ id }))
    const getFile = filesOf(db).getFile.bind(filesOf(db))
    vi.spyOn(filesOf(db), 'getFile').mockImplementationOnce(async (fileId) => {
      // Another request, start to finish, after this one read the rows. The group guard alone
      // runs this one again; the second read of the rows would too.
      expect((await setReceipts(db, ['f1'], 't3')).status).toBe(200)
      return getFile(fileId)
    })
    expect((await setReceipts(db, ['f1'], 't2')).status).toBe(200)
    expect(receiptFiles(db)).toEqual({ f1: listed('t1', 't3', 't2') })
  })

  it('keeps a transaction the backfill adds between the read and the staging', async () => {
    // Only the row changes, as the backfill's write does in a group this write doesn't guard:
    // the second read of the rows catches it.
    const db = await withExpense(['f1'])
    await call(db, 'POST', '/transactions', expense({ id: 't2' }))
    const getFile = filesOf(db).getFile.bind(filesOf(db))
    vi.spyOn(filesOf(db), 'getFile').mockImplementationOnce(async (fileId) => {
      await commitNow(db, { action: 'update', rowId: 'f1', data: { transactionIds: ['t1', 't0'] } })
      return getFile(fileId)
    })
    expect((await setReceipts(db, ['f1'], 't2')).status).toBe(200)
    expect(receiptFiles(db)).toEqual({ f1: listed('t1', 't0', 't2') })
  })
})

describe('a row deleted meanwhile', () => {
  it('runs the route again when Appwrite refuses to stage an update of it', async () => {
    const db = await withExpense(['f1'])
    await setReceipts(db, [])
    const stage = db.createOperations.bind(db)
    let refused = false
    vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
      const operations = params.operations as { tableId: string }[] | undefined
      if (!refused && operations?.some(({ tableId }) => tableId === 'receiptFiles')) {
        refused = true
        throw new AppwriteException('Row not found', 404, 'row_not_found')
      }
      return stage(params)
    })
    expect((await setReceipts(db, ['f1'])).status).toBe(200)
    expect(receiptFiles(db)).toEqual({ f1: listed('t1') })
  })
})

describe('the write budget', () => {
  it('stays within one transaction when 15 people, 30 items and 20 receipts all change (85 writes)', async () => {
    const people = Array.from({ length: 15 }, (_, index) => `p${String(index).padStart(2, '0')}`)
    const db = seed({
      // The group's balances row changes too (#49), with a new payer: the worst case.
      balances: [{ $id: 'house', peopleJson: '[]' }],
      members: [
        ...MEMBERS,
        ...people.map((personId) => ({
          $id: `m-${personId}`,
          groupId: 'house',
          personId,
          displayName: personId,
          role: 'member',
          status: 'placeholder',
          joinedOn: '2026-01-01',
        })),
      ],
    })
    const files = (name: string) => Array.from({ length: 10 }, (_, index) => `${name}${index}`)
    for (const fileId of [...files('old'), ...files('new')]) filesOf(db).upload(fileId, 'house')
    const body = (name: string, payer: string) =>
      expense({
        totalCents: undefined,
        split: undefined,
        payers: [{ personId: payer, cents: 45000 }],
        items: Array.from({ length: 30 }, (_, index) => ({
          name: `${name} ${index}`,
          amountCents: 1500,
          split: { mode: 'equal', personIds: people },
        })),
        receiptFileIds: files(name),
      })
    const created = await call(db, 'POST', '/transactions', body('old', 'p00'))
    expect(created.body.error).toBeUndefined()
    const staged = vi.spyOn(db, 'createOperations')
    const response = await call(db, 'PATCH', '/transactions/t1', body('new', 'p01'))
    expect(response.status).toBe(200)
    const writes = staged.mock.calls.reduce(
      (sum, [params]) => sum + (params.operations?.length ?? 0),
      0,
    )
    expect(writes).toBe(85)
    expect(Object.keys(receiptFiles(db))).toHaveLength(20)
  })
})
