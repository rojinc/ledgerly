import type { Groups } from '@ledgerly/core/generated/rows'
import type { FakeDb } from '@ledgerly/server/appwrite/fake'
import { describe, expect, it } from 'vitest'
import {
  beforeCommit,
  beforeStaging,
  failure,
  fakes,
  group,
  member,
  NOW,
  ok,
  person,
  placeholder,
  TRY_AGAIN,
  updateRow,
} from './harness'

const CLOSE_AT = '2026-10-31T13:00:00.000Z'
const TIMER_RUNNING = 'A timer is running in this group. Stop or void it first.'
const FINALIZING = 'A statement in this group is being finalized. Finish it first.'

/** p1's employer group g2, with Acme as the placeholder employer, and `shifts` in it. */
function employerFixture(
  shifts: ReturnType<typeof shift>[] = [],
  statements: ReturnType<typeof statement>[] = [],
) {
  return fakes(
    {
      persons: [person(1), placeholder('pA', 'Acme')],
      groups: [group('g2', 'employer', { nextCloseAt: CLOSE_AT }), group('g3', 'employer')],
      members: [
        member('m1', 'g2', 'p1', 'admin', 'active'),
        member('mA', 'g2', 'pA', 'viewer', 'placeholder'),
        member('m3', 'g3', 'p1', 'admin', 'active'),
      ],
      transactions: shifts,
      statements,
    },
    { g2: ['u1'], g3: ['u1'] },
  )
}

/** An October invoice of `groupId` in `status`. */
function statement(id: string, status: string, groupId = 'g2') {
  return {
    $id: id,
    groupId,
    type: 'invoice',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    status,
    snapshotJson: '{}',
  }
}

/**
 * Finalize step 1 for `id` in g2, staged in a transaction of its own: the group guard and the
 * `finalizing` status. Returns its commit.
 */
async function stageFinalizing(db: FakeDb, id: string) {
  const { $id: transactionId } = await db.createTransaction()
  await db.createOperations({
    transactionId,
    operations: [
      { action: 'update', databaseId: 'main', tableId: 'groups', rowId: 'g2', data: { rev: id } },
      {
        action: 'update',
        databaseId: 'main',
        tableId: 'statements',
        rowId: id,
        data: { status: 'finalizing' },
      },
    ],
  })
  return () => db.updateTransaction({ transactionId, commit: true })
}

/** A shift in `groupId`; `running` is a timer that hasn't stopped (scheduling.md#timer-shifts). */
function shift(id: string, status: string, groupId = 'g2') {
  return {
    $id: id,
    groupId,
    kind: 'shift',
    status,
    date: '2026-10-19',
    description: 'Shift',
    totalCents: 0,
    startedAt: '2026-10-18T19:00:00.000Z',
    createdBy: 'p1',
    updatedBy: 'p1',
  }
}

/**
 * The writes of a `ledger POST /timer/start` in g2, staged in a transaction of their own: the
 * group guard and the running shift. Returns its commit.
 */
async function stageTimerStart(db: FakeDb, id: string) {
  const { $id: transactionId } = await db.createTransaction()
  const { $id, ...data } = shift(id, 'running')
  await db.createOperations({
    transactionId,
    operations: [
      { action: 'update', databaseId: 'main', tableId: 'groups', rowId: 'g2', data: { rev: id } },
      {
        action: 'create',
        databaseId: 'main',
        tableId: 'transactions',
        rowId: $id,
        data: { ...data, inputJson: '{}' },
      },
    ],
  })
  return () => db.updateTransaction({ transactionId, commit: true })
}

function houseFixture() {
  return fakes(
    {
      persons: [person(1), person(2), placeholder('pX')],
      groups: [group('g1', 'house', { statementCycle: 'monthly', nextCloseAt: CLOSE_AT })],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active'),
        member('mX', 'g1', 'pX', 'member', 'placeholder'),
      ],
    },
    { g1: ['u1', 'u2'] },
  )
}

describe('POST /groups/{id}/archive', () => {
  it('archives the group, stops its statements, and records it', async () => {
    const services = houseFixture()
    const archived = await ok<Groups>(services, 'POST', '/groups/g1/archive')
    expect(archived).toMatchObject({
      $id: 'g1',
      archivedAt: NOW.toISOString(),
      nextCloseAt: null,
      statementCycle: 'monthly',
    })
    expect(services.db.rows('groups')[0]).toMatchObject({
      archivedAt: NOW.toISOString(),
      nextCloseAt: null,
    })
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'group.archived',
        summary: 'Archived the group',
        at: NOW.toISOString(),
      }),
    ])
  })

  it('returns an archived group unchanged on a repeat', async () => {
    const services = houseFixture()
    const first = await ok<Groups>(services, 'POST', '/groups/g1/archive')
    const again = await ok<Groups>(services, 'POST', '/groups/g1/archive', undefined)
    expect(again).toEqual(first)
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('answers CONFLICT when another archive lands before staging, then returns the stored group', async () => {
    const services = houseFixture()
    const earlier = '2026-10-18T19:59:00.000Z'
    beforeStaging(services.db, 1, () =>
      updateRow(services.db, 'groups', 'g1', { archivedAt: earlier, nextCloseAt: null }),
    )
    expect(await failure(services, 'POST', '/groups/g1/archive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('activity')).toEqual([])
    expect(await ok(services, 'POST', '/groups/g1/archive')).toMatchObject({ archivedAt: earlier })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('makes the group read-only for write routes', async () => {
    const services = houseFixture()
    await ok(services, 'POST', '/groups/g1/archive')
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      status: 409,
      code: 'ARCHIVED',
    })
  })

  it('refuses while a timer is running in the group', async () => {
    const services = employerFixture([shift('t1', 'running')])
    expect(await failure(services, 'POST', '/groups/g2/archive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TIMER_RUNNING,
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ archivedAt: null, nextCloseAt: CLOSE_AT })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('archives once the timer has stopped or been voided, whatever runs in other groups', async () => {
    const services = employerFixture([
      shift('t1', 'posted'),
      shift('t2', 'void'),
      shift('t3', 'running', 'g3'),
    ])
    expect(await ok(services, 'POST', '/groups/g2/archive')).toMatchObject({
      archivedAt: NOW.toISOString(),
    })
  })

  it('refuses while a statement of the group is being finalized', async () => {
    const services = employerFixture([], [statement('st1', 'finalizing')])
    expect(await failure(services, 'POST', '/groups/g2/archive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: FINALIZING,
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ archivedAt: null, nextCloseAt: CLOSE_AT })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('archives with draft, final and void statements, whatever finalizes in other groups', async () => {
    const services = employerFixture(
      [],
      [
        statement('st1', 'draft'),
        statement('st2', 'final'),
        statement('st3', 'void'),
        statement('st4', 'finalizing', 'g3'),
      ],
    )
    expect(await ok(services, 'POST', '/groups/g2/archive')).toMatchObject({
      archivedAt: NOW.toISOString(),
    })
  })

  it('refuses when a finalize starts just before the archive stages', async () => {
    const services = employerFixture([], [statement('st1', 'draft')])
    beforeStaging(services.db, 1, async () => (await stageFinalizing(services.db, 'st1'))())
    expect(await failure(services, 'POST', '/groups/g2/archive')).toMatchObject({
      code: 'CONFLICT',
      message: FINALIZING,
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ archivedAt: null })
  })

  it('fails the archive when a finalize starts after its check, and refuses the retry', async () => {
    const services = employerFixture([], [statement('st1', 'draft')])
    beforeCommit(services.db, async () => (await stageFinalizing(services.db, 'st1'))())
    expect(await failure(services, 'POST', '/groups/g2/archive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ archivedAt: null })
    expect(await failure(services, 'POST', '/groups/g2/archive')).toMatchObject({
      message: FINALIZING,
    })
  })

  it('fails a finalize start staged before the archive commits', async () => {
    const services = employerFixture([], [statement('st1', 'draft')])
    const commitFinalizing = await stageFinalizing(services.db, 'st1')
    await ok(services, 'POST', '/groups/g2/archive')
    await expect(commitFinalizing()).rejects.toMatchObject({ code: 409 })
    expect(services.db.rows('statements')[0]).toMatchObject({ status: 'draft' })
  })

  it('refuses when a timer start commits just before the archive stages', async () => {
    const services = employerFixture()
    beforeStaging(services.db, 1, async () => (await stageTimerStart(services.db, 't1'))())
    expect(await failure(services, 'POST', '/groups/g2/archive')).toMatchObject({
      code: 'CONFLICT',
      message: TIMER_RUNNING,
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ archivedAt: null })
  })

  it('fails a timer start staged before the archive commits', async () => {
    const services = employerFixture()
    const commitStart = await stageTimerStart(services.db, 't1')
    await ok(services, 'POST', '/groups/g2/archive')
    // The start reruns (ledger.md#concurrency) and gets ARCHIVED from requireMember.
    await expect(commitStart()).rejects.toMatchObject({ code: 409 })
    expect(services.db.rows('transactions')).toEqual([])
  })

  it('fails the archive when a timer start commits after its check, and refuses the retry', async () => {
    const services = employerFixture()
    beforeCommit(services.db, async () => (await stageTimerStart(services.db, 't1'))())
    expect(await failure(services, 'POST', '/groups/g2/archive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ archivedAt: null, nextCloseAt: CLOSE_AT })
    expect(await failure(services, 'POST', '/groups/g2/archive')).toMatchObject({
      message: TIMER_RUNNING,
    })
    expect(services.db.rows('activity')).toEqual([])
  })

  it("won't archive a personal group", async () => {
    const services = fakes({
      persons: [person(1)],
      groups: [group('gp', 'personal')],
      members: [member('m1', 'gp', 'p1', 'admin', 'active')],
    })
    expect(await failure(services, 'POST', '/groups/gp/archive')).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: "A personal group can't be archived.",
    })
    expect(services.db.rows('groups')[0]?.archivedAt).toBeNull()
  })

  it('rejects a body', async () => {
    const services = houseFixture()
    expect(await failure(services, 'POST', '/groups/g1/archive', { archived: true })).toMatchObject(
      { code: 'VALIDATION_FAILED' },
    )
    expect(services.db.rows('groups')[0]?.archivedAt).toBeNull()
  })

  it('is for admins only', async () => {
    const services = houseFixture()
    expect(await failure(services, 'POST', '/groups/g1/archive', undefined, 'u2')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(await failure(services, 'POST', '/groups/g1/archive', undefined, 'u3')).toMatchObject({
      code: 'NOT_A_MEMBER',
    })
    expect(await failure(services, 'POST', '/groups/g1/archive', undefined, null)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
    expect(services.db.rows('groups')[0]?.archivedAt).toBeNull()
    expect(services.db.rows('activity')).toEqual([])
  })
})
