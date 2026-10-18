import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { closeAtFor } from '@ledgerly/core/dates/time-zone'
import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  afterLatestFinalRead,
  beforeStaging,
  failure,
  fakes,
  job,
  member,
  NOVEMBER_CLOSE,
  OCTOBER_CLOSE,
  ok,
  op,
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

const runJob = (services: ReturnType<typeof fakes>) =>
  ok<{ drafted: number; failed: number }>(services, 'POST', '/', undefined, null)

const snapshotOf = (row: { snapshotJson: string } | undefined) =>
  JSON.parse(row?.snapshotJson ?? '{}') as StatementSnapshot

// The job has drafted October: November is the next period it drafts.
const octoberDrafted = { groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })] }

describe('the statements job (POST /, cron)', () => {
  it('drafts the period that ended, moves nextCloseAt on, and emails the admins', async () => {
    const services = fakes(rowsOf(shift('s1', '2026-10-02', 120)))
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const [draft] = services.db.rows('statements') as unknown as Statements[]
    expect(draft).toMatchObject({
      groupId: 'job',
      type: 'invoice',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      status: 'draft',
      number: null,
      $permissions: ['read("team:job")'],
    })
    expect(snapshotOf(draft).lines.map((line) => line.transactionId)).toEqual(['s1'])
    // 06:00 on 1 December in Sydney.
    expect(services.db.rows('groups').find((g) => g.$id === 'job')?.nextCloseAt).toBe(
      '2026-11-30T19:00:00.000Z',
    )
    expect(services.db.rows('activity')).toMatchObject([
      { groupId: 'job', actorPersonId: null, action: 'statement.drafted' },
    ])
    expect(services.sent).toHaveLength(1)
    expect(services.sent[0]).toMatchObject({
      to: ['sam@example.com'],
      subject: 'Your October invoice for Acme is ready to review',
      idempotencyKey: `ready/${draft?.$id}/sam`,
    })
    expect(services.sent[0]?.text).toContain(
      `https://app.example.com/groups/job/statements/${draft?.$id}`,
    )
  })

  it('leaves groups alone that are not due, or have no invoices', async () => {
    const services = fakes({
      groups: [
        job({}, { nextCloseAt: '2026-11-30T19:00:00.000Z' }),
        { ...job(), $id: 'house2', type: 'house', settingsJson: '{"type":"house"}' },
      ],
    })
    expect(await runJob(services)).toEqual({ drafted: 0, failed: 0 })
    expect(services.db.rows('statements')).toEqual([])
  })

  it('takes the period from the stored nextCloseAt after a time zone change', async () => {
    const services = fakes({ groups: [job({}, { timezone: 'Australia/Perth' })] })
    await runJob(services)
    expect(services.db.rows('statements')[0]).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    })
    // 06:00 on 1 December in Perth.
    expect(services.db.rows('groups')[0]?.nextCloseAt).toBe('2026-11-30T22:00:00.000Z')
  })

  it('makes no second draft when another run drafted the period first', async () => {
    const services = fakes()
    const stage = services.db.createOperations.bind(services.db)
    vi.spyOn(services.db, 'createOperations').mockImplementationOnce(async (params) => {
      const { $id } = await services.db.createTransaction()
      await stage({
        transactionId: $id,
        operations: [
          {
            action: 'update',
            databaseId: 'main',
            tableId: 'groups',
            rowId: 'job',
            data: { nextCloseAt: '2026-11-30T19:00:00.000Z' },
          },
        ],
      })
      await services.db.updateTransaction({ transactionId: $id, commit: true })
      return stage(params)
    })
    expect(await runJob(services)).toEqual({ drafted: 0, failed: 0 })
    expect(services.db.rows('statements')).toEqual([])
    expect(services.sent).toEqual([])
  })

  it('logs a group it cannot draft, without names, and drafts the others', async () => {
    // job2 has lost its employer member, so an invoice has no recipient.
    const services = fakes({
      groups: [job(), { ...job(), $id: 'job2', name: 'Bobs Bakery' }],
      members: [
        member('m-sam', 'job', 'sam', 'admin'),
        member('m-acme', 'job', 'acme', 'viewer', 'placeholder'),
        member('m-sam2', 'job2', 'sam', 'admin'),
      ],
    })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 1 })
    expect(services.db.rows('statements').map((row) => row.groupId)).toEqual(['job'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('job2')
    expect(errors[0]).not.toMatch(/Bakery|Sam|@/)
  })

  it('keeps the draft when the email fails', async () => {
    const services = fakes()
    services.sendEmail = async () => {
      throw new Error('Resend is down')
    }
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    expect(services.db.rows('statements')).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })

  it('skips a period that a statement already reaches, and moves nextCloseAt on', async () => {
    // A reissue made before the guards above drafted the second half of October.
    const services = fakes({ statements: [statement('st-oct', { periodStart: '2026-10-15' })] })
    expect(await runJob(services)).toEqual({ drafted: 0, failed: 0 })
    expect(services.db.rows('statements')).toHaveLength(1)
    expect(services.db.rows('groups').find((g) => g.$id === 'job')?.nextCloseAt).toBe(
      NOVEMBER_CLOSE,
    )
    expect(services.sent).toEqual([])
  })

  it('leaves an archived group alone, even with nextCloseAt still set', async () => {
    const services = fakes({ groups: [job({}, { archivedAt: '2026-10-20T00:00:00.000Z' })] })
    expect(await runJob(services)).toEqual({ drafted: 0, failed: 0 })
    expect(services.db.rows('statements')).toEqual([])
  })

  it('doesn’t count a run that lost its commit to another run as failed', async () => {
    const services = fakes()
    const commit = services.db.updateTransaction.bind(services.db)
    vi.spyOn(services.db, 'updateTransaction').mockImplementationOnce(async (params) => {
      // The other run drafted October and moved nextCloseAt on just before this one commits.
      const { $id } = await services.db.createTransaction()
      await services.db.createOperations({
        transactionId: $id,
        operations: [op('groups', 'job', { nextCloseAt: NOVEMBER_CLOSE })],
      })
      await commit({ transactionId: $id, commit: true })
      return commit(params)
    })
    expect(await runJob(services)).toEqual({ drafted: 0, failed: 0 })
    expect(errors).toEqual([])
    expect(services.db.rows('statements')).toEqual([])
  })

  it('still auto-finalizes when the ready email can’t be built', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 60)),
      groups: [job({ autoFinalize: true })],
    })
    services.appUrl = ''
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    expect(services.db.rows('statements')[0]?.status).toBe('final')
    expect(errors).toEqual([
      expect.stringMatching(/^statements: ready email failed for statement \S+: RangeError$/),
    ])
  })

  describe('after a time zone or cycle change while due (#123)', () => {
    const septemberFinal = statement('st-sep', {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      status: 'final',
      snapshotJson: snapshotClosing({ start: '2026-09-01', end: '2026-09-30' }, {}),
    })
    const periods = (services: ReturnType<typeof fakes>) =>
      services.db
        .rows('statements')
        .filter((row) => row.$id !== 'st-sep')
        .map((row) => `${row.periodStart}..${row.periodEnd}`)
        .sort()

    it('starts the day after the last statement when the group moved from New York to Sydney', async () => {
      // October was due at 06:00 on 1 November in New York; Sydney is 15 hours ahead.
      const nextCloseAt = closeAtFor('2026-10-31' as LocalDate, 'America/New_York')
      const services = fakes({
        groups: [job({}, { timezone: 'Australia/Sydney', nextCloseAt })],
        statements: [septemberFinal],
      })
      expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
      // It reaches 1 November, the day the time stored in nextCloseAt falls on in Sydney.
      expect(periods(services)).toEqual(['2026-10-01..2026-11-01'])
    })

    it('leaves no gap or overlap when the cycle went from monthly to weekly', async () => {
      const weekly = { statementCycle: 'weekly', cycleAnchor: '2026-10-05' }
      const services = fakes({
        groups: [job({}, { ...weekly, nextCloseAt: OCTOBER_CLOSE })],
        statements: [septemberFinal],
      })
      // October, then the week ending Sunday 1 November, due at 06:00 on 2 November.
      expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
      expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
      expect(periods(services)).toEqual(['2026-10-01..2026-10-31', '2026-11-01..2026-11-01'])
    })

    it('takes the latest statement of this group, not a void one ending on the period end', async () => {
      // October's first half is final and its second half void; another group's statement
      // ends on 20 October.
      const services = fakes({
        statements: [
          statement('st-a', {
            periodEnd: '2026-10-14',
            status: 'final',
            snapshotJson: snapshotClosing({ start: '2026-10-01', end: '2026-10-14' }, {}),
          }),
          statement('st-b', { periodStart: '2026-10-15', status: 'void' }),
          statement('st-other', { groupId: 'job2', periodEnd: '2026-10-20' }),
        ],
      })
      expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
      expect(
        services.db
          .rows('statements')
          .filter((row) => row.status === 'draft' && row.groupId === 'job')
          .map((row) => `${row.periodStart}..${row.periodEnd}`),
      ).toEqual(['2026-10-15..2026-10-31'])
    })

    it('starts after a void statement, which a reissue redoes on its own', async () => {
      const services = fakes({
        groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })],
        statements: [septemberFinal, statement('st-oct', { status: 'void' })],
      })
      services.now = new Date('2026-12-01T20:00:00.000Z')
      expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
      expect(periods(services)).toEqual(['2026-10-01..2026-10-31', '2026-11-01..2026-11-30'])
    })
  })

  it('refuses a person, even an admin', async () => {
    const response = await failure(fakes(), 'POST', '/', undefined, 'u-sam')
    expect(response).toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })
})

describe('POST /statements/reissue', () => {
  const october = { groupId: 'job', periodStart: '2026-10-01', periodEnd: '2026-10-31' }

  it('drafts the range again, leaving nextCloseAt alone', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 60), {
        statements: [statement('st-void', { status: 'void' })],
      }),
      ...octoberDrafted,
    })
    const draft = await ok<Statements>(services, 'POST', '/statements/reissue', october)
    expect(draft).toMatchObject({ ...october, status: 'draft', type: 'invoice' })
    expect(snapshotOf(draft).lines.map((line) => line.transactionId)).toEqual(['s1'])
    expect(services.db.rows('groups').find((g) => g.$id === 'job')?.nextCloseAt).toBe(
      NOVEMBER_CLOSE,
    )
    expect(services.db.rows('activity')).toMatchObject([
      { actorPersonId: 'sam', action: 'statement.reissued' },
    ])
  })

  it('gives a retry the same draft', async () => {
    const services = fakes(octoberDrafted)
    const first = await ok<Statements>(services, 'POST', '/statements/reissue', october)
    const again = await ok<Statements>(services, 'POST', '/statements/reissue', october)
    expect(again.$id).toBe(first.$id)
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it.each([
    ['a member who is not an admin', { ...october, groupId: 'house' }, 'u-bob', 'FORBIDDEN'],
    [
      'a house, until divides come',
      { ...october, groupId: 'house' },
      'u-alice',
      'VALIDATION_FAILED',
    ],
    [
      'a range that ends before it starts',
      { ...october, periodEnd: '2026-09-30' },
      'u-sam',
      'VALIDATION_FAILED',
    ],
    ['someone outside the group', october, 'u-dan', 'NOT_A_MEMBER'],
  ])('refuses %s', async (_case, body, user, code) => {
    const services = fakes()
    expect((await failure(services, 'POST', '/statements/reissue', body, user)).code).toBe(code)
    expect(services.db.rows('statements')).toEqual([])
  })
})

describe('reissue guards', () => {
  const october = { groupId: 'job', periodStart: '2026-10-01', periodEnd: '2026-10-31' }

  it('refuses a range that ends on or before the latest final statement', async () => {
    const services = fakes({
      statements: [
        statement('st-oct', {
          status: 'final',
          snapshotJson: snapshotClosing({ start: '2026-10-01', end: '2026-10-31' }, {}),
        }),
      ],
    })
    const response = await failure(services, 'POST', '/statements/reissue', {
      ...october,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    })
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('refuses a range ending on the same day as a statement that isn’t void', async () => {
    // The job drafted October. A draft of its second half could never be finalized after it.
    const services = fakes({ ...octoberDrafted, statements: [statement('st-oct')] })
    const response = await failure(services, 'POST', '/statements/reissue', {
      ...october,
      periodStart: '2026-10-15',
    })
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('refuses a period the job hasn’t drafted yet', async () => {
    // November, on 2 November: the job would draft it again on 1 December.
    const services = fakes(octoberDrafted)
    const response = await failure(services, 'POST', '/statements/reissue', {
      groupId: 'job',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    })
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')).toEqual([])
  })

  const september = { groupId: 'job', periodStart: '2026-09-01', periodEnd: '2026-09-30' }
  const septemberVoid = statement('st-sep', { ...september, status: 'void' })

  it('refuses while a statement of the group is finalizing', async () => {
    // September was voided; October stopped half-way through finalizing.
    const services = fakes({
      ...octoberDrafted,
      statements: [septemberVoid, statement('st-oct', { status: 'finalizing', number: 10 })],
    })
    expect((await failure(services, 'POST', '/statements/reissue', september)).code).toBe(
      'CONFLICT',
    )
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('refuses when a statement starts finalizing just before the reissue is staged', async () => {
    const services = fakes({ ...octoberDrafted, statements: [septemberVoid, statement('st-oct')] })
    beforeStaging(services.db, [op('statements', 'st-oct', { status: 'finalizing' })])
    expect((await failure(services, 'POST', '/statements/reissue', september)).code).toBe(
      'CONFLICT',
    )
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('refuses when the finalizing statement turns final between its reads', async () => {
    // September is final and October is finalizing. Its last step commits just after the
    // reissue of 1–20 October reads the latest final statement.
    const services = fakes({
      ...octoberDrafted,
      statements: [
        statement('st-sep', {
          ...september,
          status: 'final',
          snapshotJson: snapshotClosing({ start: '2026-09-01', end: '2026-09-30' }, {}),
        }),
        statement('st-oct', { status: 'finalizing', number: 10 }),
      ],
    })
    afterLatestFinalRead(services.db, [op('statements', 'st-oct', { status: 'final' })])
    const response = await failure(services, 'POST', '/statements/reissue', {
      ...october,
      periodEnd: '2026-10-20',
    })
    expect(response.code).toBe('CONFLICT')
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('refuses October before the job drafts it, after a move from New York to Sydney (#123)', async () => {
    // The job would draft 1 October to 1 November on top of it.
    const nextCloseAt = closeAtFor('2026-10-31' as LocalDate, 'America/New_York')
    const services = fakes({
      groups: [job({}, { timezone: 'Australia/Sydney', nextCloseAt })],
      statements: [
        statement('st-sep', {
          ...september,
          status: 'final',
          snapshotJson: snapshotClosing({ start: '2026-09-01', end: '2026-09-30' }, {}),
        }),
      ],
    })
    expect((await failure(services, 'POST', '/statements/reissue', october)).code).toBe(
      'VALIDATION_FAILED',
    )
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('redoes a void week after the cycle went from weekly to monthly (#123)', async () => {
    // The job's next period starts after the void week, so redoing that week is allowed.
    const week = { periodStart: '2026-10-12', periodEnd: '2026-10-18' }
    const services = fakes({
      statements: [
        statement('st-wk1', {
          periodStart: '2026-10-05',
          periodEnd: '2026-10-11',
          status: 'final',
          snapshotJson: snapshotClosing({ start: '2026-10-05', end: '2026-10-11' }, {}),
        }),
        statement('st-wk2', { ...week, status: 'void' }),
      ],
    })
    const draft = await ok<Statements>(services, 'POST', '/statements/reissue', {
      groupId: 'job',
      ...week,
    })
    expect(draft).toMatchObject({ ...week, status: 'draft' })
  })

  it('makes one draft when two requests reissue the same range at once', async () => {
    const services = fakes()
    beforeStaging(services.db, [
      op('statements', 'st-other', { ...statement('st-other'), $id: undefined }, 'create'),
    ])
    expect((await failure(services, 'POST', '/statements/reissue', october)).code).toBe('CONFLICT')
    vi.restoreAllMocks()
    const again = await ok<Statements>(services, 'POST', '/statements/reissue', october)
    expect(again.$id).toBe('st-other')
    expect(services.db.rows('statements')).toHaveLength(1)
  })
})

describe('the job and failing groups', () => {
  it('drafts a healthy group even when more than a page of others fail every time', async () => {
    // 101 groups with older closes and no employer member: every invoice lacks a recipient.
    const broken = Array.from({ length: 101 }, (_, index) => ({
      ...job({}, { nextCloseAt: '2026-09-30T20:00:00.000Z' }),
      $id: `broken${String(index).padStart(3, '0')}`,
    }))
    const services = fakes({
      groups: [...broken, job()],
      members: [
        member('m-sam', 'job', 'sam', 'admin'),
        member('m-acme', 'job', 'acme', 'viewer', 'placeholder'),
      ],
    })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 101 })
    expect(services.db.rows('statements').map((row) => row.groupId)).toEqual(['job'])
  })
})

describe('who the job emails', () => {
  it('skips an unverified address and an admin who moved out', async () => {
    const services = fakes({
      identities: [
        {
          $id: 'i-sam',
          key: 'email:sam@example.com',
          type: 'email',
          personId: 'sam',
          verified: false,
          verifiedAt: null,
        },
        {
          $id: 'i-lee',
          key: 'email:lee@example.com',
          type: 'email',
          personId: 'lee',
          verified: true,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      members: [
        member('m-sam', 'job', 'sam', 'admin'),
        member('m-acme', 'job', 'acme', 'viewer', 'placeholder'),
        member('m-lee', 'job', 'lee', 'admin', 'left'),
      ],
    })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    expect(services.sent).toEqual([])
  })
})

describe('finalize keeps periods in order', () => {
  it('refuses when an earlier draft appears just before it starts finalizing', async () => {
    const services = fakes({
      statements: [statement('st-nov', { periodStart: '2026-11-01', periodEnd: '2026-11-30' })],
    })
    beforeStaging(services.db, [
      op('statements', 'st-oct', { ...statement('st-oct'), $id: undefined }, 'create'),
    ])
    const response = await failure(services, 'POST', '/statements/st-nov/finalize', { send: false })
    expect(response.code).toBe('CONFLICT')
    expect(services.db.rows('statements').find((row) => row.$id === 'st-nov')?.status).toBe('draft')
  })
})
