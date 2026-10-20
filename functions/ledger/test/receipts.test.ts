import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, filesOf, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

const TEAM = ['read("team:house")']
// As an uploader may set them: readable by anyone, and their own to change or delete.
const UPLOADED = ['read("any")', ...TEAM, 'update("user:u-alice")', 'delete("user:u-alice")']

// Alice's $90.00 expense t1, posted, with photos f1 and f2 uploaded for the house.
async function withExpense(receiptFileIds?: string[]) {
  const db = seed()
  const files = filesOf(db)
  files.upload('f1', 'house', { permissions: UPLOADED })
  files.upload('f2', 'house', { permissions: UPLOADED })
  const response = await call(db, 'POST', '/transactions', expense({ receiptFileIds }))
  expect(response.status).toBe(200)
  return { db, files }
}

const setReceipts = (db: Db, receiptFileIds: string[], user = 'u-alice', id = 't1') =>
  call(db, 'POST', `/transactions/${id}/receipts`, { receiptFileIds }, user)

const receiptActivity = (db: Db) =>
  rows.activity(db).filter((row) => row.action === 'transaction.updated')

/** Commits `data` to a row at once, as another request that got there first. */
async function commitNow(db: Db, tableId: string, rowId: string, data: Record<string, unknown>) {
  const tx = await db.createTransaction()
  await db.createOperations({
    transactionId: tx.$id,
    operations: [{ action: 'update', databaseId: 'main', tableId, rowId, data }],
  })
  await db.updateTransaction({ transactionId: tx.$id, commit: true })
}

/** Runs `meanwhile` once, after the files are checked and before their reset and the commit. */
function betweenCheckAndCommit(db: Db, meanwhile: () => Promise<unknown>) {
  const files = filesOf(db)
  const update = files.updateFile.bind(files)
  vi.spyOn(files, 'updateFile').mockImplementationOnce(async (fileId, permissions) => {
    await meanwhile()
    return update(fileId, permissions)
  })
}

describe('POST /transactions/{id}/receipts', () => {
  it('sets the list, limits each file to the team and records it in one activity row', async () => {
    const { db, files } = await withExpense()
    files.upload('f3', 'house', {
      mimeType: 'application/pdf',
      permissions: ['read("any")', ...TEAM, 'update("user:u-alice")', 'delete("user:u-alice")'],
    })
    const response = await setReceipts(db, ['f3', 'f1'])
    expect(response.status).toBe(200)
    expect(response.body.data?.transaction.receiptFileIds).toEqual(['f3', 'f1'])
    expect(rows.transactions(db)[0]).toMatchObject({
      receiptFileIds: ['f3', 'f1'],
      totalCents: 9000,
      updatedBy: 'alice',
      overridden: false,
    })
    // Nobody can read it from outside the group, or swap or delete it, any more.
    expect(files.permissions('f3')).toEqual(TEAM)
    expect(files.permissions('f1')).toEqual(TEAM)
    const [activity, ...more] = receiptActivity(db)
    expect(more).toEqual([])
    expect(activity).toMatchObject({
      actorPersonId: 'alice',
      transactionId: 't1',
      summary: 'Changed the receipts on “Groceries”',
    })
    expect(JSON.parse(activity?.changesJson ?? '')).toEqual({
      receiptFileIds: { before: [], after: ['f3', 'f1'] },
    })
  })

  it('changes nothing else: the shares and items stay as they are', async () => {
    const { db } = await withExpense()
    const before = { shares: rows.shares(db), items: rows.items(db) }
    await setReceipts(db, ['f1'])
    expect({ shares: rows.shares(db), items: rows.items(db) }).toEqual(before)
  })

  it('returns the stored view and writes nothing when the list is the same', async () => {
    const { db } = await withExpense(['f1', 'f2'])
    const getFile = vi.spyOn(filesOf(db), 'getFile')
    const response = await setReceipts(db, ['f1', 'f2'])
    expect(response.status).toBe(200)
    expect(response.body.data?.transaction.receiptFileIds).toEqual(['f1', 'f2'])
    expect(receiptActivity(db)).toEqual([])
    expect(getFile).not.toHaveBeenCalled()
  })

  it('records a new order as a change', async () => {
    const { db } = await withExpense(['f1', 'f2'])
    expect((await setReceipts(db, ['f2', 'f1'])).status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toEqual(['f2', 'f1'])
    expect(receiptActivity(db)).toHaveLength(1)
  })

  it('removes a receipt and leaves the file and its permissions alone', async () => {
    const { db, files } = await withExpense(['f1', 'f2'])
    expect((await setReceipts(db, ['f2'])).status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toEqual(['f2'])
    expect(files.permissions('f1')).toEqual(TEAM)
    expect(JSON.parse(receiptActivity(db)[0]?.changesJson ?? '')).toEqual({
      receiptFileIds: { before: ['f1', 'f2'], after: ['f2'] },
    })
    expect((await setReceipts(db, [])).status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(files.permissions('f2')).toEqual(TEAM)
  })

  it('checks only the files that aren’t on the row already', async () => {
    const { db, files } = await withExpense(['f1'])
    // A file stays attached even if Storage no longer has it.
    files.stored.delete('f1')
    files.upload('f3')
    const getFile = vi.spyOn(files, 'getFile')
    expect((await setReceipts(db, ['f1', 'f3'])).status).toBe(200)
    expect(getFile.mock.calls).toEqual([['f3']])
  })

  it('lets one file be a receipt on two transactions of the group', async () => {
    const { db } = await withExpense(['f1'])
    const response = await call(db, 'POST', '/transactions', expense({ id: 't2' }))
    expect(response.status).toBe(200)
    expect((await setReceipts(db, ['f1'], 'u-alice', 't2')).status).toBe(200)
  })

  it('lets an admin change the receipts on someone else’s row', async () => {
    const { db } = await withExpense()
    await call(db, 'POST', '/transactions', expense({ id: 't2' }), 'u-bob')
    expect((await setReceipts(db, ['f1'], 'u-bob', 't2')).status).toBe(200)
    expect((await setReceipts(db, ['f1', 'f2'], 'u-alice', 't2')).status).toBe(200)
  })

  it('marks a schedule occurrence as overridden', async () => {
    const db = seed({
      transactions: [
        {
          $id: 'sch1_20261020',
          groupId: 'house',
          kind: 'expense',
          status: 'scheduled',
          date: '2026-10-20',
          description: 'Cleaner',
          totalCents: 9000,
          inputJson: JSON.stringify({ split: { mode: 'equal', personIds: ['alice', 'bob'] } }),
          scheduleId: 'sch1',
          overridden: false,
          statementId: null,
          receiptFileIds: null,
          createdBy: 'alice',
          updatedBy: 'alice',
        },
      ],
    })
    filesOf(db).upload('f1')
    expect((await setReceipts(db, ['f1'], 'u-alice', 'sch1_20261020')).status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({
      status: 'scheduled',
      receiptFileIds: ['f1'],
      overridden: true,
    })
  })

  it.each([
    ['a viewer', 'u-cara', 403, 'FORBIDDEN'],
    ['a member, on someone else’s row', 'u-bob', 403, 'FORBIDDEN'],
    ['someone outside the group', 'u-dan', 404, 'NOT_FOUND'],
    ['nobody signed in', null, 401, 'UNAUTHENTICATED'],
  ])('refuses %s', async (_case, user, status, code) => {
    const { db, files } = await withExpense()
    files.upload('f3', 'house', { permissions: ['read("any")', ...TEAM] })
    const response = await setReceipts(db, ['f3'], user as string)
    expect(response.status).toBe(status)
    expect(response.body.error?.code).toBe(code)
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(files.permissions('f3')).toEqual(['read("any")', ...TEAM])
  })

  it('answers an outsider exactly as it answers an ID that doesn’t exist', async () => {
    const { db } = await withExpense()
    const outsider = await setReceipts(db, ['f1'], 'u-dan')
    const missing = await setReceipts(db, ['f1'], 'u-dan', 'nope')
    expect(outsider).toEqual(missing)
  })

  it('refuses a locked transaction with LOCKED', async () => {
    const { db } = await withExpense()
    await commitNow(db, 'transactions', 't1', { statementId: 'st1' })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('LOCKED')
  })

  it('refuses with LOCKED while a statement covering the date is being finalized', async () => {
    const { db } = await withExpense()
    const tx = await db.createTransaction()
    await db.createOperations({
      transactionId: tx.$id,
      operations: [
        {
          action: 'create',
          databaseId: 'main',
          tableId: 'statements',
          rowId: 'st1',
          data: {
            groupId: 'house',
            type: 'divide',
            periodStart: '2026-10-01',
            periodEnd: '2026-10-31',
            status: 'finalizing',
            snapshotJson: '{}',
          },
        },
      ],
    })
    await db.updateTransaction({ transactionId: tx.$id, commit: true })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('LOCKED')
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(filesOf(db).permissions('f1')).toEqual(UPLOADED)
  })

  it('refuses an archived group with ARCHIVED', async () => {
    const { db } = await withExpense()
    await commitNow(db, 'groups', 'house', { archivedAt: NOW.toISOString() })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('ARCHIVED')
    expect(filesOf(db).permissions('f1')).toEqual(UPLOADED)
  })

  it('refuses a void transaction and a running timer with VALIDATION_FAILED', async () => {
    const { db } = await withExpense()
    await call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' })
    expect((await setReceipts(db, ['f1'])).body.error?.code).toBe('VALIDATION_FAILED')
    await call(db, 'POST', '/timer/start', { id: 'run1', groupId: 'job' }, 'u-sam')
    filesOf(db).upload('f9', 'job', { permissions: ['read("any")', 'read("team:job")'] })
    const running = await setReceipts(db, ['f9'], 'u-sam', 'run1')
    expect(running.body.error?.code).toBe('VALIDATION_FAILED')
    expect(filesOf(db).permissions('f9')).toEqual(['read("any")', 'read("team:job")'])
  })

  it('refuses a body that fails the schema', async () => {
    const { db } = await withExpense()
    const response = await call(db, 'POST', '/transactions/t1/receipts', {
      receiptFileIds: ['f1', 'f1'],
    })
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
  })
})

describe('the file check (permissions.md#storage)', () => {
  // Every write that attaches files runs the same check.
  const senders = {
    'POST /transactions': (db: Db, receiptFileIds: string[]) =>
      call(db, 'POST', '/transactions', expense({ id: 't3', receiptFileIds })),
    PATCH: (db: Db, receiptFileIds: string[]) =>
      call(db, 'PATCH', '/transactions/t1', expense({ receiptFileIds })),
    '/receipts': (db: Db, receiptFileIds: string[]) => setReceipts(db, receiptFileIds),
  }

  it.each([
    ['a missing file', 'nope', undefined],
    // A statement PDF's ID isn't in the receipts bucket, so it's missing there too.
    ['a statement PDF', 'st1', undefined],
    ['another group’s file', 'g1', { permissions: ['read("team:job")'] }],
    ['a file only its uploader can read', 'g2', { permissions: ['read("user:u-alice")'] }],
    ['a web page', 'h1', { mimeType: 'text/html' }],
    ['an SVG', 'h2', { mimeType: 'image/svg+xml' }],
    // Its last chunk could still replace the content and permissions.
    ['a file still uploading', 'u1', { complete: false }],
  ])(
    'refuses %s with VALIDATION_FAILED at its index, and changes nothing',
    async (_case, bad, file) => {
      for (const [route, send] of Object.entries(senders)) {
        const { db, files } = await withExpense()
        if (file) files.upload(bad, 'house', file)
        const uploaded = ['read("any")', ...TEAM]
        files.upload('f3', 'house', { permissions: uploaded })
        const before = { transactions: rows.transactions(db), activity: rows.activity(db) }
        const response = await send(db, ['f3', bad])
        expect(response.status, route).toBe(400)
        expect(response.body.error?.code).toBe('VALIDATION_FAILED')
        expect(response.body.error?.details).toEqual([
          { code: 'custom', path: ['receiptFileIds', 1], message: expect.any(String) },
        ])
        expect({ transactions: rows.transactions(db), activity: rows.activity(db) }).toEqual(before)
        // The good file is left as it was uploaded.
        expect(files.permissions('f3'), route).toEqual(uploaded)
      }
    },
  )

  it('accepts every image type and PDFs', async () => {
    const { db, files } = await withExpense()
    const types = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
    const ids = [...types, 'application/pdf'].map((mimeType, index) => {
      files.upload(`ok${index}`, 'house', { mimeType })
      return `ok${index}`
    })
    expect((await setReceipts(db, ids)).status).toBe(200)
  })

  it('names every bad file, and the same answer for a missing one as for another group’s', async () => {
    const { db, files } = await withExpense()
    files.upload('g1', 'job')
    const response = await setReceipts(db, ['nope', 'f1', 'g1'])
    const details = response.body.error?.details as { path: unknown[]; message: string }[]
    expect(details.map((issue) => issue.path)).toEqual([
      ['receiptFileIds', 0],
      ['receiptFileIds', 2],
    ])
    expect(details[0]?.message).toBe(details[1]?.message)
    expect(response.body.error?.message).not.toMatch(/nope|g1|job/)
  })

  it.each([
    ['getFile', 500],
    ['updateFile', 500],
    // Not a database race: the route doesn't run again.
    ['updateFile', 409],
  ] as const)('answers INTERNAL when Storage’s %s fails with %i', async (method, code) => {
    const { db } = await withExpense()
    const getFile = vi.spyOn(filesOf(db), 'getFile')
    vi.spyOn(filesOf(db), method).mockRejectedValue(
      new AppwriteException('Server Error', code, 'general_unknown'),
    )
    const response = await setReceipts(db, ['f1'])
    expect(response.status).toBe(500)
    expect(response.body.error?.code).toBe('INTERNAL')
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(getFile).toHaveBeenCalledTimes(1)
  })

  it('refuses a file swapped for another under the same ID before its reset', async () => {
    const { db, files } = await withExpense()
    const read = files.getFile.bind(files)
    vi.spyOn(files, 'getFile').mockImplementationOnce(async (fileId) => {
      const checked = await read(fileId)
      // The uploader still has `delete`: they replace the photo with a web page.
      files.upload(fileId, 'house', { mimeType: 'text/html', permissions: ['read("any")'] })
      return checked
    })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(response.body.error?.details).toEqual([
      { code: 'custom', path: ['receiptFileIds', 0], message: expect.any(String) },
    ])
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    // Only the group can read the swapped file now.
    expect(files.permissions('f1')).toEqual(TEAM)
  })

  it('refuses a file deleted between its check and its reset', async () => {
    const { db, files } = await withExpense()
    const read = files.getFile.bind(files)
    vi.spyOn(files, 'getFile').mockImplementationOnce(async (fileId) => {
      const checked = await read(fileId)
      files.stored.delete(fileId)
      return checked
    })
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
  })
})

describe('receipts on POST /transactions', () => {
  it('stores the checked list and limits each file to the team', async () => {
    const db = seed()
    const files = filesOf(db)
    files.upload('f1', 'house', { permissions: ['read("any")', ...TEAM, 'delete("users")'] })
    const response = await call(db, 'POST', '/transactions', expense({ receiptFileIds: ['f1'] }))
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toEqual(['f1'])
    expect(files.permissions('f1')).toEqual(TEAM)
  })

  it('stores no receipts as null', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense({ receiptFileIds: [] }))
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
  })

  it('returns a retry with the same list, and refuses another list with CONFLICT', async () => {
    const { db } = await withExpense(['f1'])
    const retry = await call(db, 'POST', '/transactions', expense({ receiptFileIds: ['f1'] }))
    expect(retry.status).toBe(200)
    expect(retry.body.data?.transaction.receiptFileIds).toEqual(['f1'])
    for (const receiptFileIds of [['f1', 'f2'], [], undefined]) {
      const other = await call(db, 'POST', '/transactions', expense({ receiptFileIds }))
      expect(other.body.error?.code).toBe('CONFLICT')
    }
    expect(rows.transactions(db)).toHaveLength(1)
  })

  it('takes a retry after a failed commit, with the file already limited to the team', async () => {
    const db = seed()
    const files = filesOf(db)
    files.upload('f1', 'house', { permissions: UPLOADED })
    const commit = db.updateTransaction.bind(db)
    vi.spyOn(db, 'updateTransaction').mockImplementationOnce(async (params) => {
      if (params.commit) throw new AppwriteException('Server Error', 500, 'general_unknown')
      return commit(params)
    })
    const body = expense({ receiptFileIds: ['f1'] })
    expect((await call(db, 'POST', '/transactions', body)).body.error?.code).toBe('INTERNAL')
    expect(rows.transactions(db)).toEqual([])
    expect(files.permissions('f1')).toEqual(TEAM)
    const retry = await call(db, 'POST', '/transactions', body)
    expect(retry.status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toEqual(['f1'])
  })

  it('treats no list and an empty list as the same on a retry', async () => {
    const { db } = await withExpense()
    const retry = await call(db, 'POST', '/transactions', expense({ receiptFileIds: [] }))
    expect(retry.status).toBe(200)
  })
})

describe('receipts on PATCH /transactions/{id}', () => {
  it('keeps the stored list when the body has none', async () => {
    const { db } = await withExpense(['f1'])
    const response = await call(db, 'PATCH', '/transactions/t1', expense({ totalCents: 12000 }))
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({ totalCents: 12000, receiptFileIds: ['f1'] })
    const changes = JSON.parse(receiptActivity(db)[0]?.changesJson ?? '')
    expect(changes.receiptFileIds).toBeUndefined()
  })

  it('replaces the list after the check, and records it', async () => {
    const { db, files } = await withExpense(['f1'])
    files.upload('f3', 'house', { permissions: ['read("any")', ...TEAM] })
    const response = await call(
      db,
      'PATCH',
      '/transactions/t1',
      expense({ description: 'Big shop', receiptFileIds: ['f3'] }),
    )
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toEqual(['f3'])
    expect(files.permissions('f3')).toEqual(TEAM)
    expect(JSON.parse(receiptActivity(db)[0]?.changesJson ?? '')).toMatchObject({
      description: { before: 'Groceries', after: 'Big shop' },
      receiptFileIds: { before: ['f1'], after: ['f3'] },
    })
  })

  it('writes an edit that changes only the receipts', async () => {
    const { db } = await withExpense(['f1'])
    const response = await call(db, 'PATCH', '/transactions/t1', expense({ receiptFileIds: [] }))
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(receiptActivity(db)).toHaveLength(1)
    // Nobody's part changed, so the change email sends nothing (scheduling.md#step-3b).
    const half = [
      { personId: 'alice', netCents: 4500 },
      { personId: 'bob', netCents: -4500 },
    ]
    expect(JSON.parse(receiptActivity(db)[0]?.changesJson ?? '')).toEqual({
      receiptFileIds: { before: ['f1'], after: [] },
      nets: { before: half, after: half },
    })
  })

  it('writes nothing when the list and everything else are the same', async () => {
    const { db } = await withExpense(['f1'])
    await call(db, 'PATCH', '/transactions/t1', expense({ receiptFileIds: ['f1'] }))
    expect(receiptActivity(db)).toEqual([])
  })
})

describe('a receipt change that raced another request', () => {
  it('runs again when another edit commits between the check and the commit', async () => {
    const { db, files } = await withExpense()
    files.upload('f3', 'house', { permissions: ['read("any")', ...TEAM] })
    betweenCheckAndCommit(db, () =>
      call(db, 'PATCH', '/transactions/t1', expense({ description: 'Big shop' })),
    )
    const response = await setReceipts(db, ['f3'])
    // The first commit failed. The rerun passes the check again with the reset file.
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]).toMatchObject({
      description: 'Big shop',
      receiptFileIds: ['f3'],
    })
    expect(files.permissions('f3')).toEqual(TEAM)
    expect(receiptActivity(db).map((row) => row.summary)).toEqual([
      'Changed “Big shop”',
      'Changed the receipts on “Big shop”',
    ])
  })

  it('stores nothing when a void commits between the check and the commit', async () => {
    const { db } = await withExpense()
    betweenCheckAndCommit(db, () =>
      call(db, 'POST', '/transactions/t1/void', { reason: 'Duplicate' }),
    )
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    expect(rows.transactions(db)[0]).toMatchObject({ status: 'void', receiptFileIds: null })
    expect(receiptActivity(db)).toEqual([])
    // The reset happened before the commit failed; the file is only more private.
    expect(filesOf(db).permissions('f1')).toEqual(TEAM)
  })

  it('answers ARCHIVED when the group is archived between the check and the commit', async () => {
    const { db } = await withExpense()
    betweenCheckAndCommit(db, () =>
      commitNow(db, 'groups', 'house', { archivedAt: NOW.toISOString() }),
    )
    const response = await setReceipts(db, ['f1'])
    expect(response.body.error?.code).toBe('ARCHIVED')
    expect(rows.transactions(db)[0]?.receiptFileIds).toBeNull()
    expect(filesOf(db).permissions('f1')).toEqual(TEAM)
  })

  it('compares with the list another request stored after this one read the row', async () => {
    const { db } = await withExpense()
    // The other request commits just before this one stages its guard.
    const stage = db.createOperations.bind(db)
    vi.spyOn(db, 'createOperations').mockImplementationOnce(async (params) => {
      await setReceipts(db, ['f1'])
      return stage(params)
    })
    const response = await setReceipts(db, ['f1'])
    expect(response.status).toBe(200)
    expect(receiptActivity(db)).toHaveLength(1)
  })

  it('records the list another request set meanwhile as before', async () => {
    const { db } = await withExpense()
    betweenCheckAndCommit(db, () => setReceipts(db, ['f2']))
    const response = await setReceipts(db, ['f1'])
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.receiptFileIds).toEqual(['f1'])
    expect(
      receiptActivity(db).map((row) => JSON.parse(row.changesJson ?? '').receiptFileIds),
    ).toEqual([
      { before: [], after: ['f2'] },
      { before: ['f2'], after: ['f1'] },
    ])
  })
})
