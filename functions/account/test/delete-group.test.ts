import type { DeleteAccountResult, DeleteGroupResult } from '@ledgerly/core/schemas/identity'
import { TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobResult } from '../src/routes/hourly-job'
import {
  account,
  beforeCommit,
  beforeCommitOf,
  beforeStaging,
  call,
  crashOnCall,
  type Fakes,
  FakeUsers,
  failure,
  fakes,
  group,
  member,
  minutesAgo,
  NOW,
  ok,
  person,
  rowOf,
  setRow,
  teamOf,
} from './harness'

const ARCHIVED_AT = '2026-10-01T00:00:00.000Z'
const PATH = '/groups/h2/delete'
// The hourly job's: started 5 minutes ago, so past its minute.
const CUT_OFF = minutesAgo(5)
const team = (groupId: string) => `read("team:${groupId}")`

afterEach(() => {
  vi.restoreAllMocks()
})

// Sam (p1, u1) is the only admin of the archived house h2, and alone in its team. Kim (only
// there) and Lee (also in Alex's house h1) are placeholders in it, and Ray (p3, u3), who made it,
// left it on their own. Sam and Lee are in h1 with Alex (p2, u2), which isn't archived. h2's t3 has the
// receipt r2, only its own, and r5, which h1's t9 lists too. Each house has a final statement
// with its PDF.
function world() {
  const services = fakes(
    {
      persons: [
        person('p1', 'u1', { displayName: 'Sam Lee' }),
        person('p2', 'u2'),
        person('p3', 'u3'),
        person('pKim', null),
        person('pLee', null),
      ],
      groups: [
        group('me', 'personal', 'p1'),
        group('h2', 'house', 'p3', { archivedAt: ARCHIVED_AT }),
        group('h1', 'house', 'p2'),
      ],
      members: [
        member('me', 'p1'),
        member('h2', 'p1'),
        member('h2', 'pKim', { role: 'member', status: 'placeholder' }),
        member('h2', 'pLee', { role: 'member', status: 'placeholder' }),
        member('h2', 'p3', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
        member('h1', 'p2'),
        member('h1', 'p1', { role: 'member' }),
        member('h1', 'pLee', { role: 'member', status: 'placeholder' }),
      ],
      transactions: [
        posted('t3', 'h2', 9000, { receiptFileIds: ['r2', 'r5'], statementId: 'st1' }),
        posted('t9', 'h1', 4000, { receiptFileIds: ['r5'] }),
      ],
      shares: [
        share('t3', 'h2', 'p1', 9000, 3000),
        share('t3', 'h2', 'pKim', 0, 3000),
        share('t3', 'h2', 'pLee', 0, 3000),
        share('t9', 'h1', 'p2', 4000, 2000),
        share('t9', 'h1', 'p1', 0, 2000),
      ],
      items: [
        { $id: 't3-item0', transactionId: 't3', position: 0, name: 'Bread', amountCents: 9000 },
      ],
      balances: [
        { $id: 'h2', peopleJson: '[]' },
        { $id: 'h1', peopleJson: '[]' },
      ],
      receiptFiles: [receipt('r2', ['t3']), receipt('r5', ['t3', 't9'])],
      statements: [statement('st1', 'h2'), statement('st9', 'h1')],
      activity: [activity('a2', 'h2'), activity('a9', 'h1')],
      invites: [
        {
          $id: 'vKim',
          groupId: 'h2',
          memberId: 'h2-pKim',
          identityKey: 'email:kim@example.com',
          tokenHash: 'vKim'.padEnd(64, '0'),
          channel: 'email',
          invitedBy: 'p1',
          sentAt: ARCHIVED_AT,
          expiresAt: '2026-10-15T00:00:00.000Z',
        },
      ],
    },
    { teams: { me: ['u1'], h2: ['u1'], h1: ['u1', 'u2'] } },
  )
  services.files.upload('receipts', 'r2', [team('h2')])
  services.files.upload('receipts', 'r5', [team('h2')])
  services.files.upload('statements', 'st1', [team('h2')])
  services.files.upload('statements', 'st9', [team('h1')])
  return services
}

function posted(id: string, groupId: string, totalCents: number, extra: object = {}) {
  return {
    $id: id,
    groupId,
    kind: 'expense',
    status: 'posted',
    date: '2026-09-15',
    description: 'Groceries',
    totalCents,
    inputJson: '{}',
    receiptFileIds: null,
    statementId: null,
    createdBy: 'p1',
    updatedBy: 'p1',
    ...extra,
  }
}

function share(
  transactionId: string,
  groupId: string,
  personId: string,
  givenCents: number,
  receivedCents: number,
) {
  return {
    $id: `${transactionId}-${personId}`,
    transactionId,
    personId,
    givenCents,
    receivedCents,
    groupId,
    date: '2026-09-15',
    kind: 'expense',
  }
}

function receipt(fileId: string, transactionIds: string[]) {
  return { $id: fileId, transactionIds, detachedAt: null, deletingAt: null }
}

function statement(id: string, groupId: string) {
  return {
    $id: id,
    groupId,
    type: 'divide',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status: 'final',
    snapshotJson: '{}',
    pdfFileId: id,
  }
}

function activity(id: string, groupId: string) {
  return {
    $id: id,
    groupId,
    actorPersonId: 'p1',
    action: 'group.archived',
    summary: 'Archived the group',
    at: ARCHIVED_AT,
  }
}

function remove(services: Fakes, options: Parameters<typeof call>[1] = {}) {
  return ok<DeleteGroupResult>(services, { path: PATH, ...options })
}

function refused(services: Fakes, options: Parameters<typeof call>[1] = {}) {
  return failure(services, { path: PATH, ...options })
}

function runJob(services: Fakes) {
  return ok<JobResult>(services, { path: '/', body: undefined, userId: null, scheduled: true })
}

/** h2's delete, as step 2 leaves it, by `deletingBy` at `deletingAt`, with its team gone. */
async function deleting(services: Fakes, deletingAt = CUT_OFF, deletingBy = 'p1') {
  await setRow(services, 'groups', 'h2', { deletingAt, deletingBy })
  await services.teams.delete({ teamId: 'h2' })
}

/** Every row, team and file, for "changes nothing" checks. */
function state(services: Fakes) {
  const rows = Object.fromEntries(
    Object.values(TABLES).map((tableId) => [
      tableId,
      services.db
        .rows(tableId)
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  )
  const teams = Object.fromEntries(
    services.teams.teamIds().map((teamId) => [teamId, teamOf(services, teamId)]),
  )
  return { rows, teams, files: services.files.ids().sort() }
}

// The rows of these groups (row ID = group ID for the group and its balances), and any item
// whose transaction is gone.
function leftOf(services: Fakes, groupIds: string[]) {
  const transactionIds = new Set(services.db.rows('transactions').map((row) => row.$id))
  return Object.values(TABLES).flatMap((tableId: TableId) =>
    services.db
      .rows(tableId)
      .filter(
        (row) =>
          groupIds.includes(row.groupId as string) ||
          groupIds.includes(row.$id) ||
          (tableId === 'items' && !transactionIds.has(row.transactionId as string)),
      )
      .map((row) => `${tableId}/${row.$id}`),
  )
}

// The end state of h2's delete: its rows, files and team gone, and h1's file kept.
function expectPurged(services: Fakes) {
  expect(leftOf(services, ['h2'])).toEqual([])
  expect(teamOf(services, 'h2')).toBeUndefined()
  expect(services.files.ids().sort()).toEqual(['receipts/r5', 'statements/st9'])
}

describe('POST /groups/{id}/delete: refusals, which change nothing', () => {
  it('needs the body { confirm: "DELETE" }, even once the delete has started', async () => {
    const services = world()
    const before = state(services)
    for (const body of [undefined, {}, { confirm: 'delete' }, { confirm: 'DELETE', id: 'h2' }]) {
      expect(await refused(services, { body })).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      })
    }
    expect(state(services)).toEqual(before)
    await deleting(services)
    expect((await refused(services, { body: {} })).code).toBe('VALIDATION_FAILED')
    expect(rowOf(services, 'groups', 'h2')).toBeDefined()
  })

  it('refuses no member row, a placeholder, someone who left on their own, or a person being deleted', async () => {
    const services = world()
    // Kim has an account, but never joined h2.
    await setRow(services, 'persons', 'pKim', { userId: 'u4' })
    const before = state(services)
    const notAMember = { status: 403, code: 'NOT_A_MEMBER' }
    for (const userId of ['u9', 'u4', 'u3']) {
      expect(await refused(services, { userId })).toMatchObject(notAMember)
    }
    expect(state(services)).toEqual(before)
    await setRow(services, 'persons', 'p1', { deletedAt: NOW.toISOString() })
    const deletingSam = state(services)
    expect(await refused(services)).toMatchObject(notAMember)
    expect(state(services)).toEqual(deletingSam)
  })

  it.each(['member', 'viewer'])('refuses a %s: only an admin deletes', async (role) => {
    const services = world()
    await setRow(services, 'members', 'h2-p1', { role })
    const before = state(services)
    expect(await refused(services)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(state(services)).toEqual(before)
  })

  it('asks them to sign in again once the session is over 10 minutes old, or can’t be found', async () => {
    const reauth = { status: 403, code: 'FORBIDDEN', details: { reason: 'reauth' } }
    const services = world()
    services.users = new FakeUsers([
      account({
        sessions: [
          { $id: 's1', $createdAt: minutesAgo(10.001) },
          { $id: 's2', $createdAt: 'not a date' },
        ],
      }),
    ])
    const before = state(services)
    for (const sessionId of ['s1', 's2', 's9', null]) {
      expect(await refused(services, { sessionId })).toEqual(reauth)
    }
    expect(state(services)).toEqual(before)
    services.users = new FakeUsers([
      account({ sessions: [{ $id: 's1', $createdAt: minutesAgo(10) }] }),
    ])
    expect(await remove(services)).toEqual({ finished: true })
  })

  it('refuses for 24 hours after a password change', async () => {
    const services = world()
    services.users = new FakeUsers([account({ passwordUpdate: minutesAgo(24 * 60 - 0.001) })])
    const before = state(services)
    expect(await refused(services)).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      details: { reason: 'recent_password_change' },
    })
    expect(state(services)).toEqual(before)
    services.users = new FakeUsers([account({ passwordUpdate: minutesAgo(24 * 60) })])
    expect(await remove(services)).toEqual({ finished: true })
  })

  it('refuses a personal group, archived or not, or a group that isn’t archived', async () => {
    const services = world()
    await setRow(services, 'groups', 'h2', { archivedAt: null })
    const before = state(services)
    const invalid = { status: 400, code: 'VALIDATION_FAILED' }
    expect(await refused(services, { path: '/groups/me/delete' })).toEqual(invalid)
    expect(await refused(services)).toEqual(invalid)
    expect(state(services)).toEqual(before)
    // As an account deletion's purge leaves it, archived, if it stops before the team goes.
    await setRow(services, 'groups', 'me', { archivedAt: ARCHIVED_AT })
    expect(await refused(services, { path: '/groups/me/delete' })).toEqual(invalid)
    expect(rowOf(services, 'groups', 'me')?.deletingAt ?? null).toBeNull()
    expect(teamOf(services, 'me')).toEqual(['u1'])
  })

  it.each([
    ['someone who joined', 'u2'],
    // Ray's `left` row stays in the team only if they moved out.
    ['someone who moved out', 'u3'],
  ])('refuses while anyone else is in its team: %s', async (_, userId) => {
    const services = world()
    await services.teams.createMembership({ teamId: 'h2', roles: [], userId })
    const before = state(services)
    const staged = vi.spyOn(services.db, 'createOperations')
    expect(await refused(services)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { reason: 'shared' },
    })
    // In step 1, before step 2 stages anything.
    expect(staged).not.toHaveBeenCalled()
    expect(state(services)).toEqual(before)
  })

  it('checks in order: the body, the member, the role, the session, the password, the group, then the team', async () => {
    const services = world()
    await setRow(services, 'members', 'h2-p1', { role: 'member' })
    await setRow(services, 'groups', 'h2', { archivedAt: null })
    await services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u2' })
    services.users = new FakeUsers([
      account({
        sessions: [{ $id: 's1', $createdAt: minutesAgo(11) }],
        passwordUpdate: minutesAgo(1),
      }),
    ])
    expect((await refused(services, { body: {}, userId: 'u9' })).code).toBe('VALIDATION_FAILED')
    expect((await refused(services, { userId: 'u3' })).code).toBe('NOT_A_MEMBER')
    expect((await refused(services)).code).toBe('FORBIDDEN')
    await setRow(services, 'members', 'h2-p1', { role: 'admin' })
    expect((await refused(services)).details).toEqual({ reason: 'reauth' })
    services.users = new FakeUsers([account({ passwordUpdate: minutesAgo(1) })])
    expect((await refused(services)).details).toEqual({ reason: 'recent_password_change' })
    services.users = new FakeUsers([account()])
    expect(await refused(services)).toEqual({ status: 400, code: 'VALIDATION_FAILED' })
    await setRow(services, 'groups', 'h2', { archivedAt: ARCHIVED_AT })
    expect((await refused(services)).details).toEqual({ reason: 'shared' })
    await services.teams.deleteMembership({
      teamId: 'h2',
      membershipId: services.teams.members('h2')?.find((m) => m.userId === 'u2')?.$id ?? '',
    })
    expect(await remove(services)).toEqual({ finished: true })
  })

  it('answers CONFLICT, writing nothing, when an unarchive commits while step 2 is staged', async () => {
    const services = world()
    beforeCommit(services.db, () => setRow(services, 'groups', 'h2', { archivedAt: null }))
    expect(await refused(services)).toEqual({ status: 409, code: 'CONFLICT' })
    const stored = rowOf(services, 'groups', 'h2')
    expect(stored?.archivedAt).toBeNull()
    expect([stored?.deletingAt ?? null, stored?.deletingBy ?? null]).toEqual([null, null])
    expect(teamOf(services, 'h2')).toEqual(['u1'])
    expect(leftOf(services, ['h2'])).toEqual(leftOf(world(), ['h2']))
  })

  it('refuses as step 1 does a group unarchived just before step 2 staged', async () => {
    const services = world()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"deletingAt"'),
      () => setRow(services, 'groups', 'h2', { archivedAt: null }),
    )
    expect(await refused(services)).toEqual({ status: 400, code: 'VALIDATION_FAILED' })
    expect(rowOf(services, 'groups', 'h2')?.archivedAt).toBeNull()
    expect(rowOf(services, 'groups', 'h2')?.deletingAt ?? null).toBeNull()
    expect(teamOf(services, 'h2')).toEqual(['u1'])
  })

  it('refuses as shared, writing nothing, when a join added itself to the team after step 1 read it', async () => {
    const services = world()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"deletingAt"'),
      () => services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u2' }),
    )
    expect(await refused(services)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { reason: 'shared' },
    })
    expect(rowOf(services, 'groups', 'h2')?.deletingAt ?? null).toBeNull()
    expect(teamOf(services, 'h2')).toEqual(['u1', 'u2'])
    expect(leftOf(services, ['h2'])).toEqual(leftOf(world(), ['h2']))
  })
})

describe('POST /groups/{id}/delete: deleting', () => {
  it('deletes the team, its files and its rows, keeping a receipt another group lists', async () => {
    const services = world()
    const staged = vi.spyOn(services.db, 'createOperations')
    expect(await remove(services)).toEqual({ finished: true })
    expectPurged(services)
    // Ending with the group row and the member row of deletingBy, not of whoever made the group.
    const last = staged.mock.calls.at(-1)?.[0].operations as Array<{
      tableId: string
      rowId: string
    }>
    expect(last.map(({ tableId, rowId }) => `${tableId}/${rowId}`)).toEqual([
      'groups/h2',
      'members/h2-p1',
    ])
    expect(leftOf(services, ['h1'])).toEqual(leftOf(world(), ['h1']))
    // r5 is t9's now; r2 went with t3, and its row waits, detached, for scheduler step 5.
    expect(rowOf(services, 'receiptFiles', 'r5')).toMatchObject({ transactionIds: ['t9'] })
    expect(rowOf(services, 'receiptFiles', 'r2')).toMatchObject({
      transactionIds: null,
      detachedAt: NOW.toISOString(),
    })
    // Sam keeps the account, and every other group.
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1', deletedAt: null })
    expect(rowOf(services, 'groups', 'me')).toBeDefined()
    expect(teamOf(services, 'h1')).toEqual(['u1', 'u2'])
  })

  it('marks a placeholder it leaves with no member row, for step 5c, and keeps its identity and name', async () => {
    const services = world()
    await remove(services)
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({
      displayName: 'pKim',
      orphanedAt: NOW.toISOString(),
    })
    // Lee is still in h1.
    expect(rowOf(services, 'persons', 'pLee')?.orphanedAt ?? null).toBeNull()
    expect(rowOf(services, 'members', 'h1-pLee')).toBeDefined()
    // Ray has an account, and keeps it.
    expect(rowOf(services, 'persons', 'p3')).toMatchObject({ userId: 'u3' })
    expect(rowOf(services, 'persons', 'p3')?.orphanedAt ?? null).toBeNull()
  })

  it('sets deletingAt and deletingBy first, the point of no return, then deletes the team', async () => {
    const services = world()
    crashOnCall(services.teams, 'delete')
    expect((await call(services, { path: PATH })).status).toBe(500)
    expect(rowOf(services, 'groups', 'h2')).toMatchObject({
      deletingAt: NOW.toISOString(),
      deletingBy: 'p1',
      rev: expect.stringMatching(/^[a-z0-9]{20}$/),
    })
    expect(teamOf(services, 'h2')).toEqual(['u1'])
    vi.restoreAllMocks()
    expect(await remove(services)).toEqual({ finished: true })
    expectPurged(services)
  })

  it('answers NOT_A_MEMBER once it has finished, which the app treats as done', async () => {
    const services = world()
    await remove(services)
    expect(await refused(services)).toMatchObject({ status: 403, code: 'NOT_A_MEMBER' })
  })

  it('carries on after the team is gone, skipping the session, password and group checks', async () => {
    const services = world()
    crashOnCall(services.files, 'getFile')
    expect((await call(services, { path: PATH })).status).toBe(500)
    vi.restoreAllMocks()
    expect(teamOf(services, 'h2')).toBeUndefined()
    // Both sign-in checks would refuse by now.
    services.users = new FakeUsers([
      account({
        sessions: [{ $id: 's1', $createdAt: minutesAgo(60) }],
        passwordUpdate: minutesAgo(1),
      }),
    ])
    expect(await remove(services)).toEqual({ finished: true })
    expectPurged(services)
  })

  it('carries on with someone in its team by then, as a join that raced step 2 leaves it', async () => {
    const services = world()
    crashOnCall(services.teams, 'delete')
    expect((await call(services, { path: PATH })).status).toBe(500)
    vi.restoreAllMocks()
    await services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u2' })
    expect(await remove(services)).toEqual({ finished: true })
    expectPurged(services)
  })

  it('carries on with a delete another call started just before, writing nothing of its own', async () => {
    const services = world()
    const other = minutesAgo(0.5)
    beforeStaging(
      services.db,
      (operations) => operations.includes('"deletingBy"'),
      () => setRow(services, 'groups', 'h2', { deletingAt: other, deletingBy: 'p1' }),
    )
    // Out of time once step 2 is done, so the group row stays to be read.
    services.outOfTime = () => true
    expect(await remove(services)).toEqual({ finished: false })
    expect(rowOf(services, 'groups', 'h2')).toMatchObject({ deletingAt: other, deletingBy: 'p1' })
    expect(teamOf(services, 'h2')).toBeUndefined()
  })

  it('stops once the time budget is used up, and the hourly job finishes it', async () => {
    const services = world()
    let calls = 0
    services.outOfTime = () => ++calls > 3
    expect(await remove(services)).toEqual({ finished: false })
    expect(rowOf(services, 'groups', 'h2')).toMatchObject({ deletingAt: NOW.toISOString() })
    services.outOfTime = () => false
    // Not while the route may still be running it.
    expect((await runJob(services)).groups).toBe(0)
    services.now = new Date(NOW.getTime() + 2 * 60_000)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 1, failed: 0 })
    expectPurged(services)
  })
})

describe('POST /: the group pass', () => {
  it.each([
    ['before step 3, with its team', false],
    ['after step 3', true],
  ])('finishes a delete cut off %s', async (_, teamGone) => {
    const services = world()
    await setRow(services, 'groups', 'h2', { deletingAt: CUT_OFF, deletingBy: 'p1' })
    if (teamGone) await services.teams.delete({ teamId: 'h2' })
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 1, failed: 0 })
    expectPurged(services)
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ orphanedAt: NOW.toISOString() })
  })

  it('skips a delete started in the last minute, which the route may still be running', async () => {
    const services = world()
    await deleting(services, minutesAgo(0.5))
    const before = state(services)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, failed: 0 })
    expect(state(services)).toEqual(before)
  })

  it('comes after the account pass, which settles the delete of someone being deleted', async () => {
    const services = world()
    // Sam deleted h2, then their account; both were cut off.
    await deleting(services)
    await setRow(services, 'persons', 'p1', { deletedAt: CUT_OFF, displayName: 'Former member' })
    services.users = new FakeUsers([
      account({ labels: ['deleted'], status: false, sessions: [], $updatedAt: CUT_OFF }),
    ])
    // The account pass purges h2 as one of Sam's groups, so the group pass finds nothing left.
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, failed: 0 })
    expectPurged(services)
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('leaves a group whose deletingBy row is gone to the account deletion that deleted it', async () => {
    const services = world()
    await deleting(services)
    // Another person's account deletion purges h2, and ends with its own row.
    await withTransaction(services.db, (tx) =>
      tx.write({ action: 'delete', tableId: 'members', rowId: 'h2-p1' }),
    )
    const before = state(services)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, failed: 0 })
    expect(state(services)).toEqual(before)
  })

  it('counts a crash, logged by group ID only, and a later run finishes', async () => {
    const services = world()
    await deleting(services)
    crashOnCall(services.files, 'getFile')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, failed: 1 })
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { fn: 'unknown', event: 'account_finish_failed', groupId: 'h2', cause: 'Error' },
    ])
    vi.restoreAllMocks()
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 1, failed: 0 })
    expectPurged(services)
  })
})

describe('a group delete racing the same admin’s account deletion', () => {
  // Each purge batch gives the group a fresh rev, so of two at once, one commit fails.
  const firstBatch = '"tableId":"balances","rowId":"h2"'

  it('the route loses: it answers finished false, logs no error, and the group is purged', async () => {
    const services = world()
    const errors = vi.spyOn(console, 'error')
    let sam: DeleteAccountResult | undefined
    beforeCommitOf(services, firstBatch, async () => {
      sam = await ok<DeleteAccountResult>(services)
    })
    const { status, body, logs } = await call(services, { path: PATH })
    expect({ status, body }).toEqual({ status: 200, body: { ok: true, data: { finished: false } } })
    expect(sam).toEqual({ deletedAt: NOW.toISOString(), finished: true })
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ route: 'POST /groups/:id/delete', status: 200 }),
    ])
    expect(errors).not.toHaveBeenCalled()
    expect(leftOf(services, ['h2'])).toEqual([])
    expect(services.files.ids().sort()).toEqual(['receipts/r5', 'statements/st9'])
  })

  it('the account deletion loses to the group pass: not finished, no error, and its next call finishes', async () => {
    const services = world()
    await deleting(services)
    const errors = vi.spyOn(console, 'error')
    let job: JobResult | undefined
    beforeCommitOf(services, firstBatch, async () => {
      job = await runJob(services)
    })
    expect(await ok<DeleteAccountResult>(services)).toEqual({
      deletedAt: NOW.toISOString(),
      finished: false,
    })
    // Sam's deletion is less than a minute old, so only the group pass took it.
    expect(job).toEqual({ finished: 0, users: 0, groups: 1, failed: 0 })
    expect(errors).not.toHaveBeenCalled()
    expectPurged(services)
    vi.restoreAllMocks()
    // The sessions are gone; the hourly job carries on.
    services.now = new Date(NOW.getTime() + 2 * 60_000)
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('the group pass loses: not finished, not failed, and no account_finish_failed', async () => {
    const services = world()
    await deleting(services)
    const errors = vi.spyOn(console, 'error')
    beforeCommitOf(services, firstBatch, async () => {
      expect((await ok<DeleteAccountResult>(services)).finished).toBe(true)
    })
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, failed: 0 })
    expect(errors).not.toHaveBeenCalled()
    expect(leftOf(services, ['h2'])).toEqual([])
    vi.restoreAllMocks()
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, failed: 0 })
  })
})
