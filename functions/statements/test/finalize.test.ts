import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acmeJoins,
  archiveJob,
  beforeStaging,
  commitNow,
  expectHiddenFromDan,
  failure,
  fakes,
  job,
  NOW,
  ok,
  op,
  payment,
  rowsOf,
  shift,
  snapshotClosing,
  statement,
} from './harness'

let errors: string[]
beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.push(line)
  })
})
afterEach(() => vi.restoreAllMocks())

type Services = ReturnType<typeof fakes>

// October: Sam worked 4 hours ($100.00), Acme paid $30.00; a November shift isn't in it.
const october = () =>
  rowsOf(
    shift('s1', '2026-10-02', 240),
    payment('p1', '2026-10-15', 3000),
    shift('s2', '2026-11-03', 60),
    { statements: [statement('st1')] },
  )

// September's final invoice says Acme owes $50.00, but no locked share backs that up, so
// finalizing October's s1 fails its check.
const failingCheck = () =>
  fakes(
    rowsOf(shift('s1', '2026-10-02', 240), {
      statements: [
        statement('st-sep', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'final',
          snapshotJson: snapshotClosing(
            { start: '2026-09-01', end: '2026-09-30' },
            { acme: -5000, sam: 5000 },
          ),
        }),
        statement('st1'),
      ],
    }),
  )

const finalize = (services: Services, send = false, id = 'st1', user = 'u-sam') =>
  ok<Statements>(services, 'POST', `/statements/${id}/finalize`, { send }, user)

const stored = (services: Services, id = 'st1') =>
  services.db.rows('statements').find((row) => row.$id === id) as unknown as Statements
const locks = (services: Services) =>
  Object.fromEntries(services.db.rows('transactions').map((row) => [row.$id, row.statementId]))
const lastNumber = (services: Services) => services.db.rows('profiles')[0]?.lastInvoiceNumber

describe('POST /statements/{id}/finalize', () => {
  it('numbers the invoice, locks what it covers, stores the PDF and marks it final', async () => {
    const services = fakes(october())
    const final = await finalize(services)
    expect(final).toMatchObject({
      status: 'final',
      number: 10,
      displayNumber: 'INV-0010',
      // 07:00 on 2 November in Sydney; 14 days' terms.
      issuedOn: '2026-11-02',
      dueOn: '2026-11-16',
      pdfFileId: 'st1',
      finalizedBy: 'sam',
      sentAt: null,
    })
    expect(stored(services)).toMatchObject(final)
    expect(lastNumber(services)).toBe(10)
    expect(locks(services)).toEqual({ s1: 'st1', p1: 'st1', s2: null })
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.invoice).toEqual({
      balanceDueCents: 7000,
      paymentTermsDays: 14,
      dueOn: '2026-11-16',
    })
    const pdf = services.files.stored.get('st1')
    expect(pdf).toMatchObject({ name: 'INV-0010.pdf', permissions: ['read("team:job")'] })
    expect(
      Buffer.from(pdf?.content ?? [])
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-')
    expect(services.db.rows('activity')).toMatchObject([
      {
        actorPersonId: 'sam',
        action: 'statement.finalized',
        summary: 'Invoice INV-0010 finalized',
      },
    ])
    expect(services.sent).toEqual([])
  })

  it('stages the group row with the finalizing status, for the ledger (ledger.md#concurrency)', async () => {
    const services = fakes(october())
    const stage = vi.spyOn(services.db, 'createOperations')
    await finalize(services)
    expect(stage.mock.calls[0]?.[0].operations).toEqual([
      expect.objectContaining({
        tableId: 'statements',
        rowId: 'st1',
        data: { status: 'finalizing' },
      }),
      expect.objectContaining({
        tableId: 'groups',
        rowId: 'job',
        data: { rev: expect.stringMatching(/^[a-z0-9]{20}$/) },
      }),
    ])
  })

  it('fails a ledger write staged before it once finalizing commits (ledger.md#concurrency)', async () => {
    const services = fakes(october())
    // The ledger's group guard, staged by a write that checked for finalizing statements first.
    const { $id } = await services.db.createTransaction()
    await services.db.createOperations({
      transactionId: $id,
      operations: [op('groups', 'job', { rev: 'ledgerguard000000000' })],
    })
    await finalize(services)
    await expect(
      services.db.updateTransaction({ transactionId: $id, commit: true }),
    ).rejects.toMatchObject({
      code: 409,
    })
  })

  it('gives the same result when finalized twice, numbering and uploading once', async () => {
    const services = fakes(october())
    const upload = vi.spyOn(services.files, 'upload')
    const first = await finalize(services)
    const again = await finalize(services)
    expect(again).toEqual(first)
    expect(lastNumber(services)).toBe(10)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('goes on after an interruption at the lock step, and numbers only once', async () => {
    // 95 shifts: locking takes two batches of at most 90 writes.
    const shifts = Array.from({ length: 95 }, (_, index) =>
      shift(`s${String(index).padStart(3, '0')}`, '2026-10-10', 60),
    )
    const services = fakes(rowsOf(...shifts, { statements: [statement('st1')] }))
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // Commits: 1 finalizing, 2 the number, 3 and 4 the lock batches.
      if (params.commit && ++commits === 4) throw new Error('The function was stopped')
      return commit(params)
    })
    expect(
      (await failure(services, 'POST', '/statements/st1/finalize', { send: false })).code,
    ).toBe('INTERNAL')
    expect(stored(services)).toMatchObject({ status: 'finalizing', number: 10 })
    expect(Object.values(locks(services)).filter((lock) => lock === 'st1')).toHaveLength(90)

    const final = await finalize(services)
    expect(final).toMatchObject({ status: 'final', number: 10, displayNumber: 'INV-0010' })
    expect(lastNumber(services)).toBe(10)
    expect(Object.values(locks(services)).every((lock) => lock === 'st1')).toBe(true)
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.lines).toHaveLength(95)
    expect(snapshot.invoice?.balanceDueCents).toBe(95 * 2500)
  })

  it('keeps the first issue date when an interrupted finalize runs again the next day', async () => {
    const services = fakes(october())
    vi.spyOn(services.files, 'upload').mockRejectedValueOnce(new Error('Storage is down'))
    await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(stored(services)).toMatchObject({
      status: 'finalizing',
      issuedOn: '2026-11-02',
      pdfFileId: null,
    })
    services.now = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)
    const final = await finalize(services)
    expect(final).toMatchObject({ status: 'final', issuedOn: '2026-11-02', dueOn: '2026-11-16' })
    expect(services.files.stored.has('st1')).toBe(true)
  })

  it('unlocks everything and goes back to draft when the check fails', async () => {
    // September's final invoice says Acme owes $50.00, but no locked share backs that up.
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 240), {
        statements: [
          statement('st-sep', {
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            status: 'final',
            snapshotJson: snapshotClosing(
              { start: '2026-09-01', end: '2026-09-30' },
              { acme: -5000, sam: 5000 },
            ),
          }),
          statement('st1'),
        ],
      }),
    )
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('INVARIANT_VIOLATION')
    expect(stored(services)).toMatchObject({ status: 'draft', number: 10, issuedOn: null })
    expect(locks(services)).toEqual({ s1: null })
    expect(services.files.stored.size).toBe(0)
    expect(errors).toEqual(['statements: statement st1 failed its check: fresh'])
  })

  it('takes the next number when another invoice took this one meanwhile', async () => {
    const services = fakes(october())
    const stage = services.db.createOperations.bind(services.db)
    let stagings = 0
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      // The second staging is the number: another finalize for Sam commits 10 just before.
      if (++stagings === 2) {
        const { $id } = await services.db.createTransaction()
        await stage({
          transactionId: $id,
          operations: [
            {
              action: 'update',
              databaseId: 'main',
              tableId: 'profiles',
              rowId: 'u-sam',
              data: { lastInvoiceNumber: 10 },
            },
          ],
        })
        await services.db.updateTransaction({ transactionId: $id, commit: true })
      }
      return stage(params)
    })
    expect(
      (await failure(services, 'POST', '/statements/st1/finalize', { send: false })).code,
    ).toBe('CONFLICT')
    expect(stored(services)).toMatchObject({ status: 'finalizing', number: null })
    expect((await finalize(services)).displayNumber).toBe('INV-0011')
    expect(lastNumber(services)).toBe(11)
  })

  it('finalizes only the oldest unfinished statement of the group', async () => {
    const services = fakes({
      statements: [
        statement('st1'),
        statement('st2', { periodStart: '2026-11-01', periodEnd: '2026-11-30' }),
      ],
    })
    expect(
      (await failure(services, 'POST', '/statements/st2/finalize', { send: false })).code,
    ).toBe('CONFLICT')
    expect(stored(services, 'st2').status).toBe('draft')
  })

  it('refuses a void statement', async () => {
    const services = fakes({ statements: [statement('st1', { status: 'void' })] })
    expect(
      (await failure(services, 'POST', '/statements/st1/finalize', { send: false })).code,
    ).toBe('VALIDATION_FAILED')
  })

  it('answers someone outside the group as for a missing statement; a viewer gets FORBIDDEN and an admin ARCHIVED', async () => {
    const services = fakes({
      statements: [
        statement('st1'),
        statement('st-void', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'void',
        }),
      ],
    })
    const body = { send: false }
    await expectHiddenFromDan(services, 'finalize', ['st1', 'st-void'], body)
    await acmeJoins(services)
    expect((await failure(services, 'POST', '/statements/st1/finalize', body, 'u-acme')).code).toBe(
      'FORBIDDEN',
    )
    await archiveJob(services)
    await expectHiddenFromDan(services, 'finalize', ['st1'], body)
    expect((await failure(services, 'POST', '/statements/st1/finalize', body)).code).toBe(
      'ARCHIVED',
    )
    expect(stored(services).status).toBe('draft')
  })

  it('refuses a house divide until divides come, and a member who is not an admin', async () => {
    const services = fakes({
      statements: [statement('st-house', { groupId: 'house', type: 'divide' })],
    })
    const asAdmin = await failure(
      services,
      'POST',
      '/statements/st-house/finalize',
      { send: false },
      'u-alice',
    )
    const asMember = await failure(
      services,
      'POST',
      '/statements/st-house/finalize',
      { send: false },
      'u-bob',
    )
    expect([asAdmin.code, asMember.code]).toEqual(['VALIDATION_FAILED', 'FORBIDDEN'])
  })

  it('emails the invoice when asked to send it', async () => {
    const services = fakes(october())
    const final = await finalize(services, true)
    expect(final.sentAt).toBe(NOW.toISOString())
    expect(
      services.sent.map(({ to, replyTo, idempotencyKey }) => ({ to, replyTo, idempotencyKey })),
    ).toEqual([
      {
        to: ['billing@acme.example'],
        replyTo: 'sam@example.com',
        idempotencyKey: 'invoice/st1/first/employer',
      },
      { to: 'sam@example.com', replyTo: undefined, idempotencyKey: 'invoice/st1/first/copy' },
    ])
    expect(services.sent[0]).toMatchObject({ subject: 'Invoice INV-0010 from Sam Cleans' })
    expect(services.sent[0]?.attachments?.[0]?.filename).toBe('INV-0010.pdf')
  })
})

describe('two finalize runs of one statement at once', () => {
  it('counts a transaction once when the other run locks it between this run’s two reads', async () => {
    const services = fakes(october())
    const list = services.db.listRows.bind(services.db)
    let locked = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      // The read of what's already locked to st1 comes after the read of what's unlocked.
      const lockedToThis =
        params.tableId === 'transactions' &&
        params.queries?.some((query) => query.includes('"equal","attribute":"statementId"'))
      if (lockedToThis && !locked) {
        locked = true
        await commitNow(services.db, [op('transactions', 's1', { statementId: 'st1' })])
      }
      return list(params)
    })
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1', 'p1'])
    expect(snapshot.invoice?.balanceDueCents).toBe(7000)
    expect(locks(services)).toEqual({ s1: 'st1', p1: 'st1', s2: null })
  })

  it('leaves the locks alone when its check fails after the other run stored the issue date', async () => {
    // The check fails, but the other run passed its check and stored issuedOn just before this
    // one goes back to draft.
    const services = failingCheck()
    // This run's stagings: 1 finalizing, 2 the number, 3 the lock batch, 4 back to draft.
    beforeStaging(services.db, [op('statements', 'st1', { issuedOn: '2026-11-02' })], 4)
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('CONFLICT')
    expect(stored(services)).toMatchObject({ status: 'finalizing', issuedOn: '2026-11-02' })
    expect(locks(services)).toEqual({ s1: 'st1' })
  })

  it('stops unlocking when another run starts finalizing the statement again', async () => {
    // This run went back to draft. Before its locks come off, a new run starts finalizing (its
    // step 1 writes the statement and the group row), and goes on to use those locks.
    const services = failingCheck()
    // This run's stagings: 1 finalizing, 2 the number, 3 the lock batch, 4 back to draft, 5 the
    // first unlock batch.
    beforeStaging(
      services.db,
      [
        op('statements', 'st1', { status: 'finalizing' }),
        op('groups', 'job', { rev: 'other-run' }),
      ],
      5,
    )
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('CONFLICT')
    expect(stored(services)).toMatchObject({ status: 'finalizing' })
    expect(locks(services)).toEqual({ s1: 'st1' })
  })
})

describe('auto-finalize (the statements job)', () => {
  it('finalizes a new draft at once when the group asks for it, without sending it', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 120)),
      groups: [job({ autoFinalize: true })],
    })
    expect(await ok(services, 'POST', '/', undefined, null)).toEqual({ drafted: 1, failed: 0 })
    expect(services.db.rows('statements')[0]).toMatchObject({
      status: 'final',
      displayNumber: 'INV-0010',
      finalizedBy: null,
      sentAt: null,
    })
    // Only the "ready to review" email.
    expect(services.sent).toHaveLength(1)
  })
})
