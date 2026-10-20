import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  archiveJob,
  beforeStaging,
  call,
  commitNow,
  type Fakes,
  failure,
  fakes,
  house,
  job,
  member,
  NOVEMBER_CLOSE,
  ok,
  op,
  rowsOf,
  shift,
  snapshotClosing,
  statement,
} from './harness'

afterEach(() => vi.restoreAllMocks())

// The harness's NOW is 07:00 on 2 November in Sydney. October is final, so the job drafts
// November next, at 06:00 on 1 December.
const octoberFinal = statement('st-oct', {
  status: 'final',
  number: 9,
  displayNumber: 'INV-0009',
  snapshotJson: snapshotClosing({ start: '2026-10-01', end: '2026-10-31' }, {}),
})
const midNovember = (extra: Parameters<typeof rowsOf>[number] = {}) =>
  fakes({
    ...rowsOf(
      shift('s1', '2026-10-30', 60),
      shift('s2', '2026-11-01', 120),
      shift('s3', '2026-11-02', 60),
      { statements: [octoberFinal] },
      extra,
    ),
    groups: [job({}, { nextCloseAt: NOVEMBER_CLOSE })],
  })

// No regular invoices: the job never drafts one for Acme.
const noCycle = (extra: object = {}) =>
  job(
    {},
    { statementCycle: 'none', nextCloseAt: null, $createdAt: '2026-10-09T20:00:00.000Z', ...extra },
  )

const close = (services: Fakes, body: object = {}, userId = 'u-sam') =>
  ok<Statements>(services, 'POST', '/statements/close', { groupId: 'job', ...body }, userId)

const snapshotOf = (row: { snapshotJson: string }) =>
  JSON.parse(row.snapshotJson) as StatementSnapshot

const runJob = (services: Fakes) =>
  ok<{ drafted: number; failed: number }>(services, 'POST', '/', undefined, null)

describe('POST /statements/close', () => {
  it('drafts the period so far, leaving nextCloseAt alone, and finalize works as usual', async () => {
    const services = midNovember()
    const draft = await close(services)
    expect(draft).toMatchObject({
      type: 'invoice',
      status: 'draft',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-02',
    })
    // Every unlocked shift up to the end, including October's late one (core rule 1).
    expect(snapshotOf(draft).lines.map((line) => line.transactionId)).toEqual(['s1', 's2', 's3'])
    expect(services.db.rows('groups').find((g) => g.$id === 'job')?.nextCloseAt).toBe(
      NOVEMBER_CLOSE,
    )
    expect(services.db.rows('activity')).toMatchObject([
      {
        actorPersonId: 'sam',
        action: 'statement.drafted',
        summary: 'Statement for the period ending 2026-11-02 drafted',
      },
    ])
    // No "ready" email: the admin who closed it has it.
    expect(services.sent).toEqual([])
    const final = await ok<Statements>(services, 'POST', `/statements/${draft.$id}/finalize`, {
      send: false,
    })
    expect(final).toMatchObject({ status: 'final', displayNumber: 'INV-0010' })
  })

  it('leaves the draft for the admin when the group auto-finalizes', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-11-01', 60), { statements: [octoberFinal] }),
      groups: [job({ autoFinalize: true }, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    expect(await close(services)).toMatchObject({ status: 'draft' })
    expect(services.db.rows('statements').map((row) => row.status)).toEqual(['final', 'draft'])
  })

  it('leaves the rest for the admin, and logs nothing, while the early close is unfinished (#420)', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(line)
    })
    const services = fakes({
      ...rowsOf(shift('s1', '2026-11-01', 60), shift('s2', '2026-11-20', 60), {
        statements: [octoberFinal],
      }),
      groups: [job({ autoFinalize: true }, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    const early = await close(services)
    // 07:00 on 1 December in Sydney: November is due, and the early close is still a draft.
    services.now = new Date('2026-11-30T20:00:00.000Z')
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const rows = services.db.rows('statements')
    expect(rows.map((row) => [row.periodEnd, row.status])).toEqual([
      ['2026-10-31', 'final'],
      [early.periodEnd, 'draft'],
      ['2026-11-30', 'draft'],
    ])
    expect(errors).toEqual([])
  })

  it('takes the end it is given', async () => {
    const draft = await close(midNovember(), { periodEnd: '2026-11-01' })
    expect(draft).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-01' })
    expect(snapshotOf(draft).lines.map((line) => line.transactionId)).toEqual(['s1', 's2'])
  })

  it('leaves the rest of the period to the job, with no gap or overlap', async () => {
    const services = midNovember()
    const early = await close(services)
    await ok(services, 'POST', `/statements/${early.$id}/finalize`, { send: false })
    // 07:00 on 1 December in Sydney: November is due.
    services.now = new Date('2026-11-30T20:00:00.000Z')
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const rest = services.db.rows('statements').find((row) => row.status === 'draft')
    expect(rest).toMatchObject({ periodStart: '2026-11-03', periodEnd: '2026-11-30' })
  })

  it('leaves the job only nextCloseAt to move when the close reached the period’s end', async () => {
    // The harness's group: October is due at 06:00 on 1 November, and the job hasn't run yet.
    const services = fakes(rowsOf(shift('s1', '2026-10-30', 60)))
    // The default end is October's last day, not today, which the job's period doesn't reach.
    const draft = await close(services)
    expect(draft).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31' })
    expect(await runJob(services)).toEqual({ drafted: 0, failed: 0 })
    expect(services.db.rows('statements')).toHaveLength(1)
    expect(services.db.rows('groups').find((g) => g.$id === 'job')?.nextCloseAt).toBe(
      NOVEMBER_CLOSE,
    )
  })

  it('gives a group with no cycle its first invoice, INV-0001, from its earliest entry', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-20', 60), shift('s0', '2026-10-12', 60, { status: 'void' })),
      groups: [noCycle()],
    })
    await commitNow(services.db, [op('profiles', 'u-sam', { lastInvoiceNumber: 0 })])
    const draft = await close(services)
    expect(draft).toMatchObject({ periodStart: '2026-10-20', periodEnd: '2026-11-02' })
    const final = await ok<Statements>(services, 'POST', `/statements/${draft.$id}/finalize`, {
      send: false,
    })
    expect(final.displayNumber).toBe('INV-0001')
  })

  it('starts a group with no cycle on its earliest entry, not its latest', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-25', 60), shift('s2', '2026-10-14', 60)),
      groups: [noCycle()],
    })
    expect(await close(services)).toMatchObject({ periodStart: '2026-10-14' })
  })

  it('starts a group with no cycle and no entries on the day it was created', async () => {
    const draft = await close(fakes({ groups: [noCycle()] }))
    // Created at 07:00 on 10 October in Sydney.
    expect(draft).toMatchObject({ periodStart: '2026-10-10', periodEnd: '2026-11-02' })
  })

  it('drafts an empty divide for a house, which the admin can discard', async () => {
    const services = fakes({
      groups: [job(), { ...house, $createdAt: '2026-10-09T20:00:00.000Z' }],
    })
    const draft = await close(services, { groupId: 'house' }, 'u-alice')
    expect(draft).toMatchObject({
      type: 'divide',
      status: 'draft',
      periodStart: '2026-10-10',
      periodEnd: '2026-11-02',
    })
    expect(snapshotOf(draft).lines).toEqual([])
    await ok(services, 'POST', `/statements/${draft.$id}/discard`, {}, 'u-alice')
    expect(services.db.rows('statements')).toEqual([])
  })

  it('gives a retry the same draft', async () => {
    const services = midNovember()
    const first = await close(services)
    const again = await close(services, { periodEnd: '2026-11-02' })
    expect(again.$id).toBe(first.$id)
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('gives a retry the same statement while it’s being finalized', async () => {
    const services = midNovember()
    const first = await close(services)
    await commitNow(services.db, [op('statements', first.$id, { status: 'finalizing' })])
    expect((await close(services, { periodEnd: '2026-11-02' })).$id).toBe(first.$id)
  })

  it('gives back the job’s draft for the same end', async () => {
    const services = fakes({ statements: [statement('st-job')] })
    expect((await close(services)).$id).toBe('st-job')
    expect(services.db.rows('statements')).toHaveLength(1)
  })
})

describe('close refusals', () => {
  it.each([
    ['a member who is not an admin', { groupId: 'house' }, 'u-bob', 'FORBIDDEN'],
    ['someone outside the group', {}, 'u-dan', 'NOT_A_MEMBER'],
    ['a pair group', { groupId: 'pair' }, 'u-sam', 'VALIDATION_FAILED'],
    ['a day after today', { periodEnd: '2026-11-03' }, 'u-sam', 'VALIDATION_FAILED'],
    ['a day before the period starts', { periodEnd: '2026-10-31' }, 'u-sam', 'VALIDATION_FAILED'],
    ['an end that isn’t a date', { periodEnd: '2026-11-31' }, 'u-sam', 'VALIDATION_FAILED'],
  ])('refuses %s', async (_case, body, user, code) => {
    const services = midNovember()
    await commitNow(services.db, [
      op(
        'groups',
        'pair',
        { ...job(), $id: undefined, type: 'pair', settingsJson: '{"type":"pair"}' },
        'create',
      ),
      op(
        'members',
        'm-sam-pair',
        { ...member('m-sam-pair', 'pair', 'sam', 'admin'), $id: undefined },
        'create',
      ),
    ])
    const response = await failure(
      services,
      'POST',
      '/statements/close',
      { groupId: 'job', ...body },
      user,
    )
    expect(response.code).toBe(code)
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('refuses an archived group', async () => {
    const services = midNovember()
    await archiveJob(services)
    expect((await failure(services, 'POST', '/statements/close', { groupId: 'job' })).code).toBe(
      'ARCHIVED',
    )
  })

  it('refuses a day after the period the job drafts next, which the job would draft again', async () => {
    // October is due and the job hasn't drafted it: 1 November is in the next period.
    const services = fakes()
    const response = await failure(services, 'POST', '/statements/close', {
      groupId: 'job',
      periodEnd: '2026-11-01',
    })
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')).toEqual([])
  })

  it('checks the day again in a time zone changed just before the close is staged', async () => {
    // 2 November in Sydney is still 1 November in Honolulu: the 2nd hasn't come there yet.
    const services = midNovember()
    beforeStaging(services.db, [op('groups', 'job', { timezone: 'Pacific/Honolulu' })])
    const response = await failure(services, 'POST', '/statements/close', {
      groupId: 'job',
      periodEnd: '2026-11-02',
    })
    expect(response.code).toBe('VALIDATION_FAILED')
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('tries again when the cycle changed just before the close is staged', async () => {
    // No statement yet: the start comes from the cycle, read again from the stored group.
    const services = fakes({ ...rowsOf(shift('s1', '2026-10-20', 60)), groups: [noCycle()] })
    beforeStaging(services.db, [op('groups', 'job', { statementCycle: 'monthly' })])
    const { body } = await call(services, 'POST', '/statements/close', { groupId: 'job' })
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Something else changed this at the same time. Try again.',
      },
    })
    expect(services.db.rows('statements')).toEqual([])
  })

  it('refuses when the group is archived just before the close is staged', async () => {
    const services = midNovember()
    beforeStaging(services.db, [
      op('groups', 'job', { archivedAt: '2026-11-01T20:00:00.000Z', nextCloseAt: null }),
    ])
    expect((await failure(services, 'POST', '/statements/close', { groupId: 'job' })).code).toBe(
      'ARCHIVED',
    )
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('refuses while a statement of the group is finalizing', async () => {
    const services = midNovember({
      statements: [
        statement('st-sep', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'finalizing',
        }),
      ],
    })
    expect((await failure(services, 'POST', '/statements/close', { groupId: 'job' })).code).toBe(
      'CONFLICT',
    )
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('refuses while an earlier draft is unfinished, naming the oldest', async () => {
    const services = midNovember({
      statements: [
        statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
        statement('st-aug', { periodStart: '2026-08-01', periodEnd: '2026-08-31' }),
      ],
    })
    const { status, body } = await call(services, 'POST', '/statements/close', { groupId: 'job' })
    expect(status).toBe(409)
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', details: { draftId: 'st-aug' } },
    })
    expect(services.db.rows('statements')).toHaveLength(3)
  })

  it('refuses when a statement starts finalizing just before the close is staged', async () => {
    const services = midNovember({
      statements: [
        statement('st-sep', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'final',
        }),
      ],
    })
    beforeStaging(services.db, [op('statements', 'st-sep', { status: 'finalizing' })])
    expect((await failure(services, 'POST', '/statements/close', { groupId: 'job' })).code).toBe(
      'CONFLICT',
    )
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('makes one draft when two requests close the same period at once', async () => {
    const services = midNovember()
    beforeStaging(services.db, [
      op(
        'statements',
        'st-other',
        {
          ...statement('st-other', { periodStart: '2026-11-01', periodEnd: '2026-11-02' }),
          $id: undefined,
        },
        'create',
      ),
    ])
    // "Try again", not "finalize the earlier draft": the retry gets that draft back.
    const { body } = await call(services, 'POST', '/statements/close', { groupId: 'job' })
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Something else changed this at the same time. Try again.',
      },
    })
    vi.restoreAllMocks()
    expect((await close(services)).$id).toBe('st-other')
    expect(services.db.rows('statements')).toHaveLength(2)
  })

  it('tries again when a draft committed meanwhile moved the period’s start', async () => {
    // Another close drafted 1 November first; this one, for 2 November, would overlap it.
    const services = midNovember()
    beforeStaging(services.db, [
      op(
        'statements',
        'st-first',
        {
          ...statement('st-first', {
            periodStart: '2026-11-01',
            periodEnd: '2026-11-01',
            status: 'final',
          }),
          $id: undefined,
        },
        'create',
      ),
    ])
    expect((await failure(services, 'POST', '/statements/close', { groupId: 'job' })).code).toBe(
      'CONFLICT',
    )
    expect(services.db.rows('statements')).toHaveLength(2)
  })
})

describe('POST /statements/preview, the current period so far', () => {
  const preview = (services: Fakes, body: object, userId = 'u-sam') =>
    ok<{ snapshot: StatementSnapshot }>(services, 'POST', '/statements/preview', body, userId)

  it('starts at a no-cycle group’s first entry, as a close would, not on the 1st', async () => {
    const services = fakes({ ...rowsOf(shift('s1', '2026-10-20', 60)), groups: [noCycle()] })
    const { snapshot } = await preview(services, { groupId: 'job' })
    expect(snapshot.period).toEqual({ start: '2026-10-20', end: '2026-11-02' })
  })

  it('starts the day after the latest statement, for a member who isn’t an admin too', async () => {
    const services = fakes({
      groups: [job(), { ...house, $createdAt: '2026-10-09T20:00:00.000Z' }],
      statements: [
        statement('st-house', {
          groupId: 'house',
          type: 'divide',
          periodStart: '2026-10-10',
          periodEnd: '2026-10-25',
          status: 'void',
        }),
      ],
    })
    const { snapshot } = await preview(services, { groupId: 'house' }, 'u-bob')
    expect(snapshot.period).toEqual({ start: '2026-10-26', end: '2026-11-02' })
  })

  it('previews one day: the day after a close that ended yesterday', async () => {
    const services = midNovember({
      statements: [statement('st-1', { periodStart: '2026-11-01', periodEnd: '2026-11-01' })],
    })
    const { snapshot } = await preview(services, { groupId: 'job' })
    expect(snapshot.period).toEqual({ start: '2026-11-02', end: '2026-11-02' })
  })

  it('falls back to the cycle period on a day a statement already covers', async () => {
    const services = midNovember()
    const { snapshot } = await preview(services, { groupId: 'job', periodEnd: '2026-10-20' })
    expect(snapshot.period).toEqual({ start: '2026-10-01', end: '2026-10-20' })
  })
})

describe('reissue in a group with no cycle', () => {
  const finalRange = (id: string, start: string, end: string) =>
    statement(id, {
      periodStart: start,
      periodEnd: end,
      status: 'final',
      snapshotJson: snapshotClosing({ start, end }, {}),
    })
  const reissue = (services: Fakes, periodStart: string, periodEnd: string) =>
    call(services, 'POST', '/statements/reissue', { groupId: 'job', periodStart, periodEnd })

  it.each([
    ['the days after the latest statement', '2026-10-21', '2026-11-01'],
    ['a mistyped year', '2026-10-21', '2062-10-20'],
  ])('refuses %s, which only a close drafts', async (_case, start, end) => {
    const services = fakes({
      groups: [noCycle()],
      statements: [finalRange('st-a', '2026-10-10', '2026-10-20')],
    })
    expect((await reissue(services, start, end)).body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(services.db.rows('statements')).toHaveLength(1)
  })

  it('refuses any range in a group that has no statement yet', async () => {
    const services = fakes({ groups: [noCycle()] })
    expect((await reissue(services, '2026-10-10', '2026-10-20')).status).toBe(400)
  })

  it('redoes a void period', async () => {
    const services = fakes({
      groups: [noCycle()],
      statements: [
        finalRange('st-a', '2026-10-10', '2026-10-15'),
        statement('st-b', { periodStart: '2026-10-16', periodEnd: '2026-10-20', status: 'void' }),
      ],
    })
    const { body } = await reissue(services, '2026-10-16', '2026-10-20')
    expect(body).toMatchObject({ ok: true, data: { status: 'draft', periodEnd: '2026-10-20' } })
  })
})

describe('a no-cycle group’s first close', () => {
  it('ignores an entry dated after the end, so it isn’t refused as before the start', async () => {
    // Only an entry dated three weeks ahead: the first close starts on the day Acme was created.
    const services = fakes({ ...rowsOf(shift('s1', '2026-11-20', 60)), groups: [noCycle()] })
    expect(await close(services)).toMatchObject({
      periodStart: '2026-10-10',
      periodEnd: '2026-11-02',
    })
  })
})
