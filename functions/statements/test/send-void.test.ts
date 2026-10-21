import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acmeJoins,
  afterLatestFinalRead,
  archiveJob,
  beforeStaging,
  commitNow,
  expectHiddenFromDan,
  failure,
  fakes,
  job,
  NOVEMBER_CLOSE,
  NOW,
  ok,
  op,
  rowsOf,
  shift,
  statement,
} from './harness'

afterEach(() => vi.restoreAllMocks())

type Services = ReturnType<typeof fakes>

const finalize = (services: Services, id: string) =>
  ok<Statements>(services, 'POST', `/statements/${id}/finalize`, { send: false })

const stored = (services: Services, id: string) =>
  services.db.rows('statements').find((row) => row.$id === id) as unknown as Statements
const locks = (services: Services) =>
  Object.fromEntries(services.db.rows('transactions').map((row) => [row.$id, row.statementId]))

describe('POST /statements/{id}/send', () => {
  it('refuses a body with any field before it reads anything, and takes an empty one (#482)', async () => {
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 120), { statements: [statement('st1')] }),
    )
    await finalize(services, 'st1')
    const extra = { to: 'someone@example.com' }
    expect((await failure(services, 'POST', '/statements/st1/send', extra)).code).toBe(
      'VALIDATION_FAILED',
    )
    // Not NOT_FOUND: the body is checked before the statement is looked up.
    expect((await failure(services, 'POST', '/statements/nope/send', extra)).code).toBe(
      'VALIDATION_FAILED',
    )
    expect(services.sent).toEqual([])
    expect(stored(services, 'st1')?.sentAt).toBeNull()
    const sent = await ok<{ sentAt: string }>(services, 'POST', '/statements/st1/send', {})
    expect(sent.sentAt).toBe(NOW.toISOString())
  })

  it('sends a final invoice, and a resend gets its own idempotency keys', async () => {
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 120), { statements: [statement('st1')] }),
    )
    await finalize(services, 'st1')
    const first = await ok<{ sentAt: string }>(services, 'POST', '/statements/st1/send')
    expect(first.sentAt).toBe(NOW.toISOString())
    services.now = new Date(NOW.getTime() + 60_000)
    const again = await ok<{ sentAt: string }>(services, 'POST', '/statements/st1/send')
    expect(again.sentAt).toBe(services.now.toISOString())
    expect(services.sent.map((email) => email.idempotencyKey)).toEqual([
      'invoice/st1/first/employer',
      'invoice/st1/first/copy',
      `invoice/st1/${first.sentAt}/employer`,
      `invoice/st1/${first.sentAt}/copy`,
    ])
    expect(services.sent[0]).toMatchObject({
      to: ['billing@acme.example'],
      replyTo: 'sam@example.com',
    })
    expect(services.sent[0]?.text).toContain('$50.00 is due by 16 November 2026.')
    expect(services.db.rows('activity').map((row) => row.action)).toEqual([
      'statement.finalized',
      'statement.sent',
      'statement.sent',
    ])
  })

  it('sends to the billing emails the group has now, and no copy to a worker with no verified email', async () => {
    const services = fakes({ ...rowsOf({ statements: [statement('st1')] }), identities: [] })
    await finalize(services, 'st1')
    const settings = { recipients: ['accounts@acme.example'] }
    await services.db.updateTransaction({
      transactionId: (
        await services.db.createOperations({
          transactionId: (await services.db.createTransaction()).$id,
          operations: [
            {
              action: 'update',
              databaseId: 'main',
              tableId: 'groups',
              rowId: 'job',
              data: { settingsJson: job(settings).settingsJson },
            },
          ],
        })
      ).$id,
      commit: true,
    })
    await ok(services, 'POST', '/statements/st1/send')
    expect(services.sent).toHaveLength(1)
    expect(services.sent[0]).toMatchObject({ to: ['accounts@acme.example'], replyTo: undefined })
  })

  it('sends the worker’s copy even when they turned every email off on Profile', async () => {
    const services = fakes(rowsOf({ statements: [statement('st1')] }))
    await commitNow(services.db, [
      op('profiles', 'u-sam', { emailOptOuts: ['billDue', 'shiftToConfirm', 'statementReady'] }),
    ])
    await finalize(services, 'st1')
    await ok(services, 'POST', '/statements/st1/send')
    expect(services.sent.map((email) => email.to)).toEqual([
      ['billing@acme.example'],
      'sam@example.com',
    ])
  })

  it('keeps sentAt empty when the email fails', async () => {
    const services = fakes({ statements: [statement('st1')] })
    await finalize(services, 'st1')
    services.sendEmail = async () => {
      throw new Error('Resend is down')
    }
    expect((await failure(services, 'POST', '/statements/st1/send')).code).toBe('INTERNAL')
    expect(stored(services, 'st1').sentAt).toBeNull()
  })

  it.each([
    ['a draft', {}, {}, 'u-sam', 'VALIDATION_FAILED'],
    [
      'an invoice with no billing email',
      { recipients: [] },
      { finalized: true },
      'u-sam',
      'VALIDATION_FAILED',
    ],
  ])('refuses %s', async (_case, settings, { finalized }: { finalized?: boolean }, user, code) => {
    const services = fakes({ groups: [job(settings)], statements: [statement('st1')] })
    if (finalized) await finalize(services, 'st1')
    expect((await failure(services, 'POST', '/statements/st1/send', undefined, user)).code).toBe(
      code,
    )
    expect(services.sent).toEqual([])
  })

  it('answers someone outside the group as for a missing statement; a viewer gets FORBIDDEN and an admin ARCHIVED', async () => {
    const services = fakes({ statements: [statement('st1')] })
    // A draft, which send refuses, then a final one.
    await expectHiddenFromDan(services, 'send', ['st1'])
    await finalize(services, 'st1')
    await expectHiddenFromDan(services, 'send', ['st1'])
    await acmeJoins(services)
    expect(
      (await failure(services, 'POST', '/statements/st1/send', undefined, 'u-acme')).code,
    ).toBe('FORBIDDEN')
    await archiveJob(services)
    await expectHiddenFromDan(services, 'send', ['st1'])
    expect((await failure(services, 'POST', '/statements/st1/send')).code).toBe('ARCHIVED')
    expect(services.sent).toEqual([])
  })
})

describe('POST /statements/{id}/void', () => {
  // September: 1 hour ($25.00). October: 4 hours ($100.00). The job drafted both.
  const twoMonths = () =>
    fakes({
      ...rowsOf(shift('s0', '2026-09-10', 60), shift('s1', '2026-10-02', 240), {
        statements: [
          statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
          statement('st-oct'),
        ],
      }),
      groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })],
    })

  it('voids the latest final statement and unlocks its transactions, keeping its PDF', async () => {
    const services = twoMonths()
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    const voided = await ok<Statements>(services, 'POST', '/statements/st-oct/void', {
      reason: 'Wrong rate',
    })
    expect(voided).toMatchObject({ status: 'void', pdfFileId: 'st-oct', displayNumber: 'INV-0011' })
    expect(locks(services)).toEqual({ s0: 'st-sep', s1: null })
    expect(services.files.stored.has('st-oct')).toBe(true)
    expect(services.db.rows('activity').at(-1)).toMatchObject({
      action: 'statement.voided',
      actorPersonId: 'sam',
      changesJson: JSON.stringify({
        before: { status: 'final' },
        after: { status: 'void', reason: 'Wrong rate' },
      }),
    })
  })

  it('opens the next statement from the last final one that is not void', async () => {
    const services = twoMonths()
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    await ok(services, 'POST', '/statements/st-oct/void', { reason: 'Wrong rate' })
    const again = await ok<Statements>(services, 'POST', '/statements/reissue', {
      groupId: 'job',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    })
    const final = await finalize(services, again.$id)
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    // September's closing, not the voided October's.
    expect(snapshot.people.find((person) => person.personId === 'sam')).toMatchObject({
      openingCents: 2500,
      closingCents: 12500,
    })
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1'])
    expect(final.displayNumber).toBe('INV-0012')
    expect(locks(services)).toEqual({ s0: 'st-sep', s1: again.$id })
  })

  it('finishes an interrupted void when called again', async () => {
    const services = twoMonths()
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // Commit 1 voids it; commit 2 is the unlock batch.
      if (params.commit && ++commits === 2) throw new Error('The function was stopped')
      return commit(params)
    })
    await failure(services, 'POST', '/statements/st-oct/void', { reason: 'Wrong rate' })
    expect(stored(services, 'st-oct').status).toBe('void')
    expect(locks(services).s1).toBe('st-oct')
    vi.restoreAllMocks()
    await ok(services, 'POST', '/statements/st-oct/void', { reason: 'Wrong rate' })
    expect(locks(services).s1).toBeNull()
  })

  it.each([
    [
      'a final statement that is not the latest',
      'st-sep',
      { reason: 'x' },
      'u-sam',
      'VALIDATION_FAILED',
    ],
    ['a body with no reason', 'st-oct', {}, 'u-sam', 'VALIDATION_FAILED'],
  ])('refuses %s', async (_case, id, body, user, code) => {
    const services = twoMonths()
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    expect((await failure(services, 'POST', `/statements/${id}/void`, body, user)).code).toBe(code)
    expect(stored(services, id).status).toBe('final')
  })

  it('refuses a draft', async () => {
    const services = twoMonths()
    const response = await failure(services, 'POST', '/statements/st-sep/void', { reason: 'x' })
    expect(response.code).toBe('VALIDATION_FAILED')
  })

  it('answers someone outside the group as for a missing statement; a viewer gets FORBIDDEN and an admin ARCHIVED', async () => {
    const services = twoMonths()
    const body = { reason: 'x' }
    // Every state void refuses or handles on its own: a draft, a final one that isn't the
    // latest, and a void one (which a retry would finish unlocking), as well as the latest final.
    await expectHiddenFromDan(services, 'void', ['st-sep'], body)
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    await expectHiddenFromDan(services, 'void', ['st-sep', 'st-oct'], body)
    await acmeJoins(services)
    expect((await failure(services, 'POST', '/statements/st-oct/void', body, 'u-acme')).code).toBe(
      'FORBIDDEN',
    )
    expect(stored(services, 'st-oct').status).toBe('final')
    await ok(services, 'POST', '/statements/st-oct/void', body)
    await expectHiddenFromDan(services, 'void', ['st-oct'], body)
    await archiveJob(services)
    await expectHiddenFromDan(services, 'void', ['st-sep', 'st-oct'], body)
    expect((await failure(services, 'POST', '/statements/st-sep/void', body)).code).toBe('ARCHIVED')
    expect(stored(services, 'st-sep').status).toBe('final')
  })
})

describe('finalizing after a void', () => {
  it('finishes the unlock of an interrupted void before taking the snapshot', async () => {
    // September was voided, but the void stopped before it unlocked the 10 September shift.
    const services = fakes(
      rowsOf(
        shift('s0', '2026-09-10', 60, { statementId: 'st-sep' }),
        shift('s1', '2026-10-02', 240),
        {
          statements: [
            statement('st-sep', {
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'void',
            }),
            statement('st-oct'),
          ],
        },
      ),
    )
    const final = await finalize(services, 'st-oct')
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s0', 's1'])
    expect(locks(services)).toEqual({ s0: 'st-oct', s1: 'st-oct' })
  })
})

describe('a void still unlocking', () => {
  it('leaves a transaction alone that another statement locked meanwhile', async () => {
    const services = fakes({
      ...rowsOf(shift('s0', '2026-09-10', 60, { statementId: 'st-sep' }), {
        statements: [
          statement('st-sep', {
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            status: 'final',
          }),
          statement('st-oct'),
        ],
      }),
      groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    // The void's stagings: 1 void, 2 its first unlock batch. Just before 2, October's finalize
    // (which finished this void's unlock itself) has locked s0.
    beforeStaging(services.db, [op('transactions', 's0', { statementId: 'st-oct' })], 2)
    const voided = await ok<Statements>(services, 'POST', '/statements/st-sep/void', {
      reason: 'Wrong rate',
    })
    expect(voided.status).toBe('void')
    expect(locks(services)).toEqual({ s0: 'st-oct' })
  })
})

describe('void and finalize at the same moment', () => {
  it('refuses when a later statement turns final between its reads', async () => {
    // October's last finalize step commits just after the void reads the latest final one.
    const services = fakes({
      ...rowsOf(
        shift('s0', '2026-09-10', 60, { statementId: 'st-sep' }),
        shift('s1', '2026-10-02', 240, { statementId: 'st-oct' }),
        {
          statements: [
            statement('st-sep', {
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'final',
            }),
            statement('st-oct', { status: 'finalizing', number: 11 }),
          ],
        },
      ),
      groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    afterLatestFinalRead(services.db, [op('statements', 'st-oct', { status: 'final' })])
    const response = await failure(services, 'POST', '/statements/st-sep/void', { reason: 'x' })
    expect(response.code).toBe('CONFLICT')
    expect(stored(services, 'st-sep').status).toBe('final')
    expect(locks(services)).toEqual({ s0: 'st-sep', s1: 'st-oct' })
  })

  const threeMonths = () =>
    fakes(
      rowsOf(shift('s0', '2026-09-10', 60), shift('s1', '2026-10-02', 240), {
        statements: [
          statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
          statement('st-oct'),
          statement('st-nov', { periodStart: '2026-11-01', periodEnd: '2026-11-30' }),
        ],
      }),
    )

  it('refuses to void a statement that a later one was finalized on top of meanwhile', async () => {
    const services = threeMonths()
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    beforeStaging(services.db, [op('statements', 'st-nov', { status: 'final' })])
    const response = await failure(services, 'POST', '/statements/st-oct/void', { reason: 'x' })
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(stored(services, 'st-oct').status).toBe('final')
    expect(locks(services).s1).toBe('st-oct')
  })

  it('refuses while a later statement is being finalized', async () => {
    const services = threeMonths()
    await finalize(services, 'st-sep')
    await finalize(services, 'st-oct')
    beforeStaging(services.db, [op('statements', 'st-nov', { status: 'finalizing' })])
    const response = await failure(services, 'POST', '/statements/st-oct/void', { reason: 'x' })
    expect(response.code).toBe('CONFLICT')
    expect(stored(services, 'st-oct').status).toBe('final')
  })
})

describe('send at the same moment', () => {
  it('answers CONFLICT when another send recorded sentAt first', async () => {
    const services = fakes({ statements: [statement('st1')] })
    await finalize(services, 'st1')
    beforeStaging(services.db, [op('statements', 'st1', { sentAt: '2026-11-01T20:00:00.000Z' })])
    expect((await failure(services, 'POST', '/statements/st1/send')).code).toBe('CONFLICT')
    expect(stored(services, 'st1').sentAt).toBe('2026-11-01T20:00:00.000Z')
  })
})
