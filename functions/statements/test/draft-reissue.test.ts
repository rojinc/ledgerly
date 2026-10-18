import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { failure, fakes, job, member, OCTOBER_CLOSE, ok, rowsOf, shift, statement } from './harness'

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
      idempotencyKey: `ready-${draft?.$id}-sam`,
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

  it('refuses a person, even an admin', async () => {
    const response = await failure(fakes(), 'POST', '/', undefined, 'u-sam')
    expect(response).toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })
})

describe('POST /statements/reissue', () => {
  const october = { groupId: 'job', periodStart: '2026-10-01', periodEnd: '2026-10-31' }

  it('drafts the range again, leaving nextCloseAt alone', async () => {
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 60), {
        statements: [statement('st-void', { status: 'void' })],
      }),
    )
    const draft = await ok<Statements>(services, 'POST', '/statements/reissue', october)
    expect(draft).toMatchObject({ ...october, status: 'draft', type: 'invoice' })
    expect(snapshotOf(draft).lines.map((line) => line.transactionId)).toEqual(['s1'])
    expect(services.db.rows('groups').find((g) => g.$id === 'job')?.nextCloseAt).toBe(OCTOBER_CLOSE)
    expect(services.db.rows('activity')).toMatchObject([
      { actorPersonId: 'sam', action: 'statement.reissued' },
    ])
  })

  it('gives a retry the same draft', async () => {
    const services = fakes()
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
