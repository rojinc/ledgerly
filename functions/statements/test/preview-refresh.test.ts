import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { describe, expect, it, vi } from 'vitest'
import {
  archiveJob,
  BUSINESS,
  beforeStaging,
  commitNow,
  expectHiddenFromDan,
  failure,
  fakes,
  job,
  leftOnTheirOwn,
  member,
  NOVEMBER_CLOSE,
  ok,
  op,
  payment,
  rowsOf,
  samProfile,
  shift,
  snapshotClosing,
  statement,
} from './harness'

type Preview = { snapshot: StatementSnapshot }

// September's final invoice left Acme owing Sam $50.00.
const september = statement('st-sep', {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  status: 'final',
  number: 9,
  displayNumber: 'INV-0009',
  snapshotJson: snapshotClosing(
    { start: '2026-09-01', end: '2026-09-30' },
    { acme: -5000, sam: 5000 },
  ),
})

describe('POST /statements/preview', () => {
  it('collects every unlocked posted transaction up to the period end, opening from the last final statement', async () => {
    const services = fakes(
      rowsOf(
        shift('s1', '2026-10-02', 240),
        shift('s2', '2026-10-30', 120, { category: 'cleaning' }),
        payment('p1', '2026-10-15', 5000),
        // Not in it: a shift after the period, one already locked, a voided one.
        shift('s3', '2026-11-01', 60),
        shift('s4', '2026-09-20', 60, { statementId: 'st-sep' }),
        shift('s5', '2026-10-03', 60, { status: 'void' }),
        { statements: [september] },
      ),
    )
    const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
      groupId: 'job',
      periodEnd: '2026-10-31',
    })
    expect(snapshot.period).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1', 'p1', 's2'])
    expect(snapshot.lines[0]).toMatchObject({
      kind: 'shift',
      totalCents: 10000,
      shift: { minutes: 240, rateCents: 2500 },
      shares: [
        { personId: 'acme', givenCents: 0, receivedCents: 10000 },
        { personId: 'sam', givenCents: 10000, receivedCents: 0 },
      ],
    })
    expect(snapshot.lines[2]).toMatchObject({ category: 'cleaning' })
    expect(snapshot.people).toEqual([
      {
        personId: 'acme',
        name: 'Acme',
        openingCents: -5000,
        givenCents: 5000,
        receivedCents: 15000,
        closingCents: -15000,
      },
      {
        personId: 'sam',
        name: 'Sam',
        openingCents: 5000,
        givenCents: 15000,
        receivedCents: 5000,
        closingCents: 15000,
      },
    ])
    expect(snapshot.issuer).toEqual({ personId: 'sam', name: 'Sam', business: BUSINESS })
    expect(snapshot.recipient).toEqual({
      personId: 'acme',
      name: 'Acme',
      emails: ['billing@acme.example'],
    })
    expect(snapshot.invoice).toEqual({ balanceDueCents: 15000, paymentTermsDays: 14 })
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it.each([
    [
      'a field today’s rule refuses',
      { ...BUSINESS, abn: '1' },
      { businessName: 'Sam Cleans', email: 'sam@example.com', bank: BUSINESS.bank },
    ],
    [
      'the whole bank when one part is refused',
      { ...BUSINESS, bank: { ...BUSINESS.bank, bsb: '12' } },
      { businessName: 'Sam Cleans', abn: '51824753556', email: 'sam@example.com' },
    ],
    ['every field when the JSON isn’t an object', ['Sam Cleans'], {}],
    [
      'nothing, with the rule’s own clean-up, as before',
      { abn: '51 824 753 556', bank: { ...BUSINESS.bank, bsb: '062-000' } },
      { abn: '51824753556', bank: BUSINESS.bank },
    ],
  ])(
    'keeps the business details that read, leaving out %s, without a word (#543)',
    async (_case, stored, business) => {
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const services = fakes({ profiles: [samProfile(JSON.stringify(stored))] })
      const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
        groupId: 'job',
        periodEnd: '2026-10-31',
      })
      expect(snapshot.issuer?.business).toEqual(business)
      expect(warnings).not.toHaveBeenCalled()
    },
  )

  it('has no business details when the stored JSON doesn’t parse (#543)', async () => {
    const services = fakes({ profiles: [samProfile('{')] })
    const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
      groupId: 'job',
      periodEnd: '2026-10-31',
    })
    expect(snapshot.issuer?.business).toEqual({})
  })

  it('opens from a final invoice whose business details a later rule refuses (#543)', async () => {
    const stored = JSON.parse(september.snapshotJson as string)
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 240), {
        statements: [
          {
            ...september,
            snapshotJson: JSON.stringify({
              ...stored,
              issuer: { ...stored.issuer, business: { businessName: 'Sam Cleans', abn: '1' } },
            }),
          },
        ],
      }),
    )
    const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
      groupId: 'job',
      periodEnd: '2026-10-31',
    })
    expect(snapshot.people.map((person) => person.openingCents)).toEqual([-5000, 5000])
  })

  it('ends today in the group time zone when no periodEnd is given', async () => {
    // October is drafted: the job's next period, November, hasn't ended.
    const services = fakes({
      ...rowsOf(shift('s1', '2026-11-02', 60), shift('s2', '2026-11-03', 60)),
      groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
      groupId: 'job',
    })
    expect(snapshot.period).toEqual({ start: '2026-11-01', end: '2026-11-02' })
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1'])
  })

  it('ends on the job’s period end while that period waits for the job, as a close would', async () => {
    // 07:00 on 2 November: October ended, and the job hasn't drafted it yet.
    const services = fakes(rowsOf(shift('s1', '2026-10-30', 60), shift('s2', '2026-11-02', 60)))
    const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
      groupId: 'job',
    })
    expect(snapshot.period).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1'])
  })

  it('previews a house divide for any member, with suggested transfers', async () => {
    const services = fakes()
    const { snapshot } = await ok<Preview>(
      services,
      'POST',
      '/statements/preview',
      { groupId: 'house', periodEnd: '2026-10-31' },
      'u-bob',
    )
    expect(snapshot).toMatchObject({ group: { type: 'house' }, people: [], transfers: [] })
    expect(snapshot.invoice).toBeUndefined()
  })

  it('previews an archived group', async () => {
    const services = fakes({ groups: [job({}, { archivedAt: '2026-10-20T00:00:00.000Z' })] })
    const { snapshot } = await ok<Preview>(services, 'POST', '/statements/preview', {
      groupId: 'job',
      periodEnd: '2026-10-31',
    })
    expect(snapshot.group.id).toBe('job')
  })

  it.each([
    ['someone outside the group', 'u-dan', 403, 'NOT_A_MEMBER'],
    ['nobody signed in', null, 401, 'UNAUTHENTICATED'],
  ])('refuses %s', async (_case, user, status, code) => {
    const response = await failure(fakes(), 'POST', '/statements/preview', { groupId: 'job' }, user)
    expect(response).toMatchObject({ status, code })
  })

  it('refuses a body that fails the schema', async () => {
    const response = await failure(fakes(), 'POST', '/statements/preview', { groupId: 'job', x: 1 })
    expect(response.code).toBe('VALIDATION_FAILED')
  })
})

describe('a member who left', () => {
  // Dan joined Acme's group as a viewer, then left: still in its team after moving out (the
  // row is the same), out of it after leaving on their own (permissions.md#members).
  async function withDanLeft() {
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 60), { statements: [statement('st1')] }),
    )
    const { $id: _, ...row } = member('m-dan', 'job', 'dan', 'viewer', 'left')
    await commitNow(services.db, [
      { action: 'create', databaseId: 'main', tableId: 'members', rowId: 'm-dan', data: row },
    ])
    return services
  }
  const preview = { groupId: 'job', periodEnd: '2026-10-31' }

  it('can still preview after moving out', async () => {
    const services = await withDanLeft()
    const { snapshot } = await ok<Preview>(
      services,
      'POST',
      '/statements/preview',
      preview,
      'u-dan',
    )
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1'])
  })

  it('is an outsider after leaving on their own: NOT_A_MEMBER on preview, NOT_FOUND on refresh', async () => {
    const services = await withDanLeft()
    leftOnTheirOwn(services, 'u-dan')
    expect((await failure(services, 'POST', '/statements/preview', preview, 'u-dan')).code).toBe(
      'NOT_A_MEMBER',
    )
    await expectHiddenFromDan(services, 'refresh', ['st1'])
  })
})

describe('POST /statements/{id}/refresh', () => {
  it('recalculates a draft from the transactions as they are now', async () => {
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 120), { statements: [statement('st1')] }),
    )
    const refreshed = await ok<Statements>(services, 'POST', '/statements/st1/refresh')
    const snapshot = JSON.parse(refreshed.snapshotJson) as StatementSnapshot
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1'])
    expect(snapshot.invoice?.balanceDueCents).toBe(5000)
    expect(refreshed.status).toBe('draft')
  })

  it('lets a viewer refresh, but not in an archived group', async () => {
    const services = fakes({
      members: [
        member('m-alice', 'house', 'alice', 'admin'),
        member('m-bob', 'house', 'bob', 'viewer'),
      ],
      statements: [statement('st-house', { groupId: 'house', type: 'divide' })],
    })
    const refreshed = await ok<Statements>(
      services,
      'POST',
      '/statements/st-house/refresh',
      undefined,
      'u-bob',
    )
    expect(refreshed.status).toBe('draft')
    const archived = fakes({
      groups: [job({}, { archivedAt: '2026-10-20T00:00:00.000Z' })],
      statements: [statement('st1')],
    })
    expect((await failure(archived, 'POST', '/statements/st1/refresh')).code).toBe('ARCHIVED')
  })

  it('refuses a body with any field before it reads anything, and takes an empty one (#482)', async () => {
    const services = fakes({ statements: [statement('st1')] })
    const extra = { snapshot: 'mine' }
    expect(await failure(services, 'POST', '/statements/st1/refresh', extra)).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    // Not NOT_FOUND: the body is checked before the statement is looked up.
    expect(await failure(services, 'POST', '/statements/nope/refresh', extra)).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('statements')[0]?.snapshotJson).toBe('{}')
    const refreshed = await ok<Statements>(services, 'POST', '/statements/st1/refresh', {})
    expect(refreshed.snapshotJson).not.toBe('{}')
  })

  it('stores nothing when the schema refuses the snapshot (#549)', async () => {
    // A currency an older rule allowed: the snapshot copies it, and no read could parse it back.
    const services = fakes({
      groups: [job({}, { currency: 'aud' })],
      statements: [statement('st1')],
    })
    expect(await failure(services, 'POST', '/statements/st1/refresh')).toMatchObject({
      status: 500,
      code: 'INTERNAL',
    })
    expect(services.db.rows('statements')[0]?.snapshotJson).toBe('{}')
  })

  it('refuses a statement that is no longer a draft', async () => {
    const services = fakes({ statements: [statement('st1', { status: 'final' })] })
    const response = await failure(services, 'POST', '/statements/st1/refresh')
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')[0]?.snapshotJson).toBe('{}')
  })

  it('leaves the snapshot alone when a finalize starts while it refreshes', async () => {
    const services = fakes({ statements: [statement('st1')] })
    const stage = services.db.createOperations.bind(services.db)
    vi.spyOn(services.db, 'createOperations').mockImplementationOnce(async (params) => {
      const { $id } = await services.db.createTransaction()
      await stage({
        transactionId: $id,
        operations: [
          {
            action: 'update',
            databaseId: 'main',
            tableId: 'statements',
            rowId: 'st1',
            data: { status: 'finalizing' },
          },
        ],
      })
      await services.db.updateTransaction({ transactionId: $id, commit: true })
      return stage(params)
    })
    const response = await failure(services, 'POST', '/statements/st1/refresh')
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')[0]).toMatchObject({
      status: 'finalizing',
      snapshotJson: '{}',
    })
  })

  it('answers CONFLICT when the statement is deleted before its write is staged, then NOT_FOUND (#238)', async () => {
    const services = fakes({ statements: [statement('st1')] })
    // Appwrite refuses to stage an update of a row deleted since it was read (#238).
    beforeStaging(services.db, [op('statements', 'st1', {}, 'delete')])
    expect(await failure(services, 'POST', '/statements/st1/refresh')).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
    expect(await failure(services, 'POST', '/statements/st1/refresh')).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    })
  })

  it('answers someone outside the group as for a missing statement, archived or not', async () => {
    const services = fakes({
      statements: [
        statement('st1'),
        statement('st-final', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'final',
        }),
      ],
    })
    await expectHiddenFromDan(services, 'refresh', ['st1', 'st-final'])
    await archiveJob(services)
    await expectHiddenFromDan(services, 'refresh', ['st1'])
    expect((await failure(services, 'POST', '/statements/st1/refresh')).code).toBe('ARCHIVED')
    expect(services.db.rows('statements')[0]?.snapshotJson).toBe(statement('st1').snapshotJson)
  })
})
