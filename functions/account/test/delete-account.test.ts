import type { DeleteAccountResult } from '@ledgerly/core/schemas/identity'
import { removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import {
  account,
  beforeCommit,
  beforeStaging,
  call,
  crashOnCall,
  crashOnList,
  type Fakes,
  FakeUsers,
  failure,
  fakes,
  group,
  insert,
  member,
  minutesAgo,
  NOW,
  occurrence,
  ok,
  person,
  rowOf,
  schedule,
  setRow,
  TODAY,
  teamOf,
} from './harness'

const DELETED_AT = NOW.toISOString()
const EARLIER = '2026-10-18T19:00:00.000Z'
const ARCHIVED_AT = '2026-10-01T00:00:00.000Z'
const ALL_TABLES = [
  'persons',
  'identities',
  'profiles',
  'groups',
  'members',
  'transactions',
  'items',
  'schedules',
  'statements',
  'activity',
  'invites',
] as const

// Sam (p1, u1) shares the house h1 with Alex (p2, u2), the other admin, and works for Acme (p3,
// u3, the employer's viewer) in e1. Every group is kept, so with nothing to purge, steps 5–7
// run too. Sam's weekly groceries in h1 are made up to 2 November.
const groceries = schedule('sGroceries', 'h1', 'p1', ['p1', 'p2'])

function kept(accountOverrides: Parameters<typeof account>[0] = {}) {
  return fakes(
    {
      persons: [
        // Bootstrap gives the user read access to their own person; step 6 takes it away.
        person('p1', 'u1', { displayName: 'Sam Lee', $permissions: ['read("user:u1")'] }),
        person('p2', 'u2'),
        person('p3', 'u3'),
      ],
      identities: [
        identity('i1', 'email:sam@example.com', 'p1'),
        identity('i2', 'phone:+61412345678', 'p1'),
        identity('i3', 'email:alex@example.com', 'p2'),
      ],
      profiles: [profile('u1', 'p1'), profile('u2', 'p2')],
      invites: [invite('v1', 'p1'), invite('v2', 'p1'), invite('v3', 'p2')],
      groups: [group('h1', 'house', 'p2'), group('e1', 'employer', 'p1')],
      members: [
        member('h1', 'p1', { displayName: 'Sam' }),
        member('h1', 'p2'),
        member('e1', 'p1', { displayName: 'Sam' }),
        member('e1', 'p3', { role: 'viewer' }),
      ],
      schedules: [groceries],
      transactions: [
        occurrence(groceries, '2026-10-12'),
        occurrence(groceries, '2026-10-19'),
        occurrence(groceries, '2026-10-26'),
        occurrence(groceries, '2026-11-02'),
      ],
    },
    {
      accounts: [account(accountOverrides)],
      teams: { h1: ['u1', 'u2'], e1: ['u1', 'u3'] },
    },
  )
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: key.split(':')[0], personId, verified: true, verifiedAt: null }
}

function profile(userId: string, personId: string) {
  return { $id: userId, personId, timezone: 'Australia/Sydney', region: 'AU-NSW' }
}

function invite(id: string, invitedBy: string) {
  return {
    $id: id,
    groupId: 'h1',
    memberId: 'h1-p2',
    identityKey: 'email:kim@example.com',
    tokenHash: `hash-${id}`,
    channel: 'email',
    invitedBy,
    sentAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-15T00:00:00.000Z',
  }
}

function timer(id: string, groupId: string) {
  return {
    $id: id,
    groupId,
    kind: 'shift',
    status: 'running',
    date: TODAY,
    description: 'Shift',
    totalCents: 0,
    inputJson: '{}',
    startedAt: minutesAgo(30),
    createdBy: 'p1',
    updatedBy: 'p1',
  }
}

function remove(services: Fakes) {
  return ok<DeleteAccountResult>(services)
}

// Their personal group: nobody else is ever in its team, so it's purged (purge.test.ts).
async function withPersonalGroup(services: Fakes) {
  await insert(services, 'groups', [group('me', 'personal', 'p1')])
  await insert(services, 'members', [member('me', 'p1')])
  await services.teams.create({ teamId: 'me', name: 'Personal' })
  await services.teams.createMembership({ teamId: 'me', roles: [], userId: 'u1' })
}

function activityIn(services: Fakes, groupId: string) {
  return services.db.rows('activity').filter((row) => row.groupId === groupId)
}

/** Every row, team and account, for "changes nothing" and "the same rows" checks. */
function state(services: Fakes) {
  const rows = Object.fromEntries(
    ALL_TABLES.map((tableId) => [
      tableId,
      services.db
        .rows(tableId)
        // Made by the clock or at random: Appwrite's timestamps, guard values, activity IDs.
        .map(({ $createdAt, $updatedAt, $sequence, rev, ...row }) =>
          JSON.stringify(tableId === 'activity' ? { ...row, $id: 'activity' } : row),
        )
        .sort(),
    ]),
  )
  const teams = Object.fromEntries(
    services.teams.teamIds().map((teamId) => [teamId, teamOf(services, teamId)]),
  )
  return { rows, teams, users: ['u1', 'u2', 'u3'].map((id) => services.users.account(id)) }
}

describe('POST /delete: refusals, which change nothing', () => {
  it('needs the body { confirm: "DELETE" }, even once the deletion has started', async () => {
    const services = kept()
    const before = state(services)
    for (const body of [undefined, {}, { confirm: 'delete' }, { confirm: 'DELETE', also: 1 }]) {
      expect(await failure(services, { body })).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      })
    }
    expect(state(services)).toEqual(before)
    await setRow(services, 'persons', 'p1', { deletedAt: EARLIER })
    expect((await failure(services, { body: {} })).code).toBe('VALIDATION_FAILED')
  })

  it('asks them to sign in again once the session is more than 10 minutes old', async () => {
    const stale = kept({ sessions: [{ $id: 's1', $createdAt: minutesAgo(10.001) }] })
    const before = state(stale)
    expect(await failure(stale)).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      details: { reason: 'reauth' },
    })
    expect(state(stale)).toEqual(before)
    const atTheLimit = kept({ sessions: [{ $id: 's1', $createdAt: minutesAgo(10) }] })
    expect(await remove(atTheLimit)).toEqual({ deletedAt: DELETED_AT, finished: true })
  })

  it('fails closed: a JWT without a session, a session Appwrite doesn’t return, or a bad date', async () => {
    const reauth = { status: 403, code: 'FORBIDDEN', details: { reason: 'reauth' } }
    const services = kept({
      sessions: [
        { $id: 's1', $createdAt: minutesAgo(1) },
        { $id: 's2', $createdAt: 'not a date' },
      ],
    })
    const before = state(services)
    expect(await failure(services, { sessionId: null })).toEqual(reauth)
    expect(await failure(services, { sessionId: 's9' })).toEqual(reauth)
    expect(await failure(services, { sessionId: 's2' })).toEqual(reauth)
    expect(state(services)).toEqual(before)
  })

  it('refuses for 24 hours after a password change', async () => {
    const recent = kept({ passwordUpdate: minutesAgo(24 * 60 - 0.001) })
    const before = state(recent)
    expect(await failure(recent)).toEqual({
      status: 403,
      code: 'FORBIDDEN',
      details: { reason: 'recent_password_change' },
    })
    expect(state(recent)).toEqual(before)
    expect((await remove(kept({ passwordUpdate: minutesAgo(24 * 60) }))).finished).toBe(true)
    // An account that never set a password.
    expect((await remove(kept({ passwordUpdate: '' }))).finished).toBe(true)
  })

  it('refuses while a timer runs in a group that isn’t archived', async () => {
    const services = kept()
    await insert(services, 'transactions', [timer('t1', 'e1')])
    const before = state(services)
    expect(await failure(services)).toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(state(services)).toEqual(before)
    // A timer left in an archived group can't be stopped, and doesn't count.
    await setRow(services, 'groups', 'e1', { archivedAt: ARCHIVED_AT })
    expect((await remove(services)).deletedAt).toBe(DELETED_AT)
  })

  it('refuses the only joined admin of a house with another active member, naming the houses', async () => {
    const services = fakes(
      {
        persons: [person('p1', 'u1'), person('p2', 'u2'), person('p3', 'u3')],
        groups: [
          group('h1', 'house', 'p1'),
          group('h2', 'house', 'p1'),
          group('h3', 'house', 'p1', { archivedAt: ARCHIVED_AT }),
          group('h4', 'house', 'p1'),
          group('q1', 'pair', 'p1'),
        ],
        members: [
          member('h1', 'p1'),
          member('h1', 'p2', { role: 'member' }),
          member('h2', 'p1'),
          member('h2', 'p2', { role: 'member' }),
          member('h2', 'p3', { role: 'viewer', status: 'left', leftOn: '2026-09-01' }),
          // Archived, nobody else who could be made admin, or not a house: no refusal.
          member('h3', 'p1'),
          member('h3', 'p2', { role: 'member' }),
          member('h4', 'p1'),
          member('h4', 'p2', { role: 'viewer', status: 'left', leftOn: '2026-09-01' }),
          member('h4', 'p3', { role: 'member', status: 'placeholder' }),
          member('q1', 'p1'),
          member('q1', 'p2', { role: 'member' }),
        ],
      },
      {
        teams: {
          h1: ['u1', 'u2'],
          h2: ['u1', 'u2', 'u3'],
          h3: ['u1', 'u2'],
          h4: ['u1', 'u2'],
          q1: ['u1', 'u2'],
        },
      },
    )
    const before = state(services)
    expect(await failure(services)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { groupIds: ['h1', 'h2'] },
    })
    expect(state(services)).toEqual(before)
    await setRow(services, 'members', 'h1-p2', { role: 'admin' })
    await setRow(services, 'members', 'h2-p2', { role: 'admin' })
    expect((await remove(services)).deletedAt).toBe(DELETED_AT)
  })

  it('checks in order: the session, the password, a timer, then the houses', async () => {
    const services = kept({
      sessions: [{ $id: 's1', $createdAt: minutesAgo(11) }],
      passwordUpdate: minutesAgo(1),
    })
    await insert(services, 'transactions', [timer('t1', 'e1')])
    await setRow(services, 'members', 'h1-p2', { role: 'member' })
    expect((await failure(services)).details).toEqual({ reason: 'reauth' })
    services.users = new FakeUsers([account({ passwordUpdate: minutesAgo(1) })])
    expect((await failure(services)).details).toEqual({ reason: 'recent_password_change' })
    services.users = new FakeUsers([account()])
    expect((await failure(services)).code).toBe('CONFLICT')
    await setRow(services, 'transactions', 't1', { status: 'void' })
    expect(await failure(services)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { groupIds: ['h1'] },
    })
  })

  it('needs a person, as identity’s routes do', async () => {
    const services = fakes()
    expect(await failure(services)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })
})

describe('POST /delete: steps 2 and 3', () => {
  it('marks the person deleted, then labels, blocks and signs out the user', async () => {
    const services = kept({
      labels: ['beta'],
      sessions: [
        { $id: 's1', $createdAt: minutesAgo(1) },
        { $id: 's2', $createdAt: minutesAgo(60) },
      ],
    })
    // Out of time before the groups, so the rest waits.
    services.outOfTime = () => true
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({
      userId: 'u1',
      deletedAt: DELETED_AT,
      displayName: 'Former member',
      rev: expect.stringMatching(/^[a-z0-9]{20}$/),
      // Until step 6.
      $permissions: ['read("user:u1")'],
    })
    expect(services.users.account('u1')).toMatchObject({
      labels: ['beta', 'deleted'],
      status: false,
      sessions: [],
    })
  })

  it('carries on without the checks once deletedAt is set, keeping that deletedAt', async () => {
    const services = kept({ sessions: [], passwordUpdate: minutesAgo(1) })
    await setRow(services, 'persons', 'p1', { deletedAt: EARLIER })
    await insert(services, 'transactions', [timer('t1', 'e1')])
    expect(await remove(services)).toEqual({ deletedAt: EARLIER, finished: true })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('keeps the deletedAt of a deletion that got there first', async () => {
    const services = kept()
    beforeStaging(
      services.db,
      (operations) => operations.includes('deletedAt'),
      () => setRow(services, 'persons', 'p1', { deletedAt: EARLIER }),
    )
    expect(await remove(services)).toEqual({ deletedAt: EARLIER, finished: true })
  })

  it('changes nothing when another write to the person lands first', async () => {
    const services = kept()
    const before = state(services)
    // An invite's guard write, say.
    beforeCommit(services.db, () => setRow(services, 'persons', 'p1', { rev: 'invite' }))
    expect(await failure(services)).toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(state(services)).toEqual(before)
  })

  it.each([
    ['already unlinked by a deletion past step 6', null],
    ['now naming another user', 'u9'],
  ])('changes nothing when the person, marked deleted meanwhile, is %s', async (_, userId) => {
    const services = kept()
    let raced: ReturnType<typeof state> | undefined
    beforeStaging(
      services.db,
      (operations) => operations.includes('deletedAt'),
      async () => {
        await setRow(services, 'persons', 'p1', { deletedAt: EARLIER, userId })
        raced = state(services)
      },
    )
    // Not a deletion of this user's to carry on.
    expect(await failure(services)).toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(state(services)).toEqual(raced)
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ displayName: 'Sam Lee' })
  })
})

describe('POST /delete: each group they joined', () => {
  it('keeps a group someone else is in: Former member, left and viewer, then out of the team', async () => {
    const services = kept()
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({
      displayName: 'Former member',
      status: 'left',
      role: 'viewer',
      leftOn: TODAY,
    })
    // With a fresh group rev (ledger.md#concurrency), and still Alex's to run.
    expect(rowOf(services, 'groups', 'h1')).toMatchObject({
      archivedAt: null,
      rev: expect.stringMatching(/^[a-z0-9]{20}$/),
    })
    expect(teamOf(services, 'h1')).toEqual(['u2'])
    // A member.left by them that names no one, so the row counts as leaving on their own.
    expect(activityIn(services, 'h1')).toEqual([
      expect.objectContaining({
        actorPersonId: 'p1',
        action: 'member.left',
        subjectPersonId: 'p1',
        summary: 'left',
        at: DELETED_AT,
        $permissions: ['read("team:h1")'],
      }),
    ])
    expect(activityIn(services, 'h1')[0]?.changesJson ?? null).toBeNull()
  })

  it('archives a kept employer or pair group with no other joined admin', async () => {
    const services = kept()
    await insert(services, 'groups', [group('q1', 'pair', 'p1'), group('q2', 'pair', 'p1')])
    await insert(services, 'members', [
      member('q1', 'p1'),
      member('q1', 'p2'),
      member('q2', 'p1'),
      member('q2', 'p3', { role: 'member' }),
    ])
    for (const [teamId, userId] of [
      ['q1', 'u2'],
      ['q2', 'u3'],
    ] as const) {
      await services.teams.create({ teamId, name: teamId })
      await services.teams.createMembership({ teamId, roles: [], userId: 'u1' })
      await services.teams.createMembership({ teamId, roles: [], userId })
    }
    expect((await remove(services)).finished).toBe(true)
    // The statements cron selects groups by nextCloseAt, so an archived group leaves it.
    expect(rowOf(services, 'groups', 'e1')).toMatchObject({
      archivedAt: DELETED_AT,
      nextCloseAt: null,
    })
    expect(rowOf(services, 'groups', 'q1')).toMatchObject({ archivedAt: null })
    expect(rowOf(services, 'groups', 'q2')).toMatchObject({ archivedAt: DELETED_AT })
    // As an admin's archive does, so the others see why; it names no one.
    for (const [groupId, archived] of [
      ['e1', true],
      ['q1', false],
      ['q2', true],
    ] as const) {
      const rows = activityIn(services, groupId).filter((row) => row.action === 'group.archived')
      expect(rows).toEqual(
        archived
          ? [expect.objectContaining({ actorPersonId: 'p1', summary: 'Archived the group' })]
          : [],
      )
    }
    expect(rowOf(services, 'members', 'e1-p1')).toMatchObject({ status: 'left', role: 'viewer' })
    expect(teamOf(services, 'e1')).toEqual(['u3'])
    expect(teamOf(services, 'q2')).toEqual(['u3'])
  })

  it('archives a kept house where nobody else could be made admin', async () => {
    const services = kept()
    // Alex moved out, so nobody left in the house could take over.
    await setRow(services, 'members', 'h1-p2', {
      role: 'viewer',
      status: 'left',
      leftOn: '2026-09-30',
    })
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'groups', 'h1')).toMatchObject({ archivedAt: DELETED_AT })
  })

  it('sets leftOn only when it’s empty, and never before joinedOn', async () => {
    const services = kept()
    await insert(services, 'groups', [group('h2', 'house', 'p2')])
    await insert(services, 'members', [
      member('h2', 'p1', { role: 'member', joinedOn: '2026-11-01' }),
      member('h2', 'p2'),
    ])
    await services.teams.create({ teamId: 'h2', name: 'h2' })
    await services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u1' })
    await services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u2' })
    // Sam moved out of h1 already, and is moving into h2 next month.
    await setRow(services, 'members', 'h1-p1', {
      role: 'viewer',
      status: 'left',
      leftOn: '2026-09-30',
    })
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({ leftOn: '2026-09-30' })
    expect(rowOf(services, 'members', 'h2-p1')).toMatchObject({ leftOn: '2026-11-01' })
  })

  it('ends the schedules they created or whose template names them, on the earlier of their end and today', async () => {
    const services = kept()
    const named = schedule('sNamed', 'h1', 'p2', ['p1', 'p2'])
    const other = schedule('sOther', 'h1', 'p2', ['p2'])
    const ended = schedule('sEnded', 'h1', 'p1', ['p1'], {
      endsOn: '2026-10-10',
      generatedThrough: '2026-10-10',
      nextRunAt: null,
    })
    const archived = schedule('sArchived', 'e1', 'p1', ['p1'])
    await insert(services, 'schedules', [named, other, ended, archived])
    await insert(services, 'transactions', [
      occurrence(named, '2026-10-26'),
      occurrence(other, '2026-10-26'),
      occurrence(archived, '2026-10-26'),
    ])
    // Edited, so the schedule leaves it alone.
    await setRow(services, 'transactions', 'sGroceries_20261026', { overridden: true })
    // Ending a schedule in an archived group is refused; it never runs again anyway.
    await setRow(services, 'groups', 'e1', { archivedAt: ARCHIVED_AT })
    const otherBefore = rowOf(services, 'schedules', 'sOther')
    const archivedBefore = rowOf(services, 'schedules', 'sArchived')
    expect((await remove(services)).finished).toBe(true)

    expect(rowOf(services, 'schedules', 'sGroceries')).toMatchObject({
      endsOn: TODAY,
      generatedThrough: TODAY,
      nextRunAt: DELETED_AT,
    })
    expect(rowOf(services, 'schedules', 'sNamed')).toMatchObject({ endsOn: TODAY })
    expect(rowOf(services, 'schedules', 'sEnded')).toMatchObject({
      endsOn: '2026-10-10',
      generatedThrough: '2026-10-18',
      nextRunAt: DELETED_AT,
    })
    expect(rowOf(services, 'schedules', 'sOther')).toEqual(otherBefore)
    expect(rowOf(services, 'schedules', 'sArchived')).toEqual(archivedBefore)
    // Only the ones after today that can still change go.
    expect(services.db.rows('transactions').map((row) => row.$id)).toEqual([
      'sGroceries_20261012',
      'sGroceries_20261019',
      'sGroceries_20261026',
      'sOther_20261026',
      'sArchived_20261026',
    ])
  })

  it('waits with the archive while a statement is being finalized, then finishes on a later run', async () => {
    const services = kept()
    await insert(services, 'statements', [
      {
        $id: 'st1',
        groupId: 'e1',
        type: 'invoice',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        status: 'finalizing',
        snapshotJson: '{}',
      },
    ])
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'members', 'e1-p1')).toMatchObject({ status: 'left' })
    expect(rowOf(services, 'groups', 'e1')).toMatchObject({ archivedAt: null })
    expect(teamOf(services, 'e1')).toEqual(['u1', 'u3'])
    expect(teamOf(services, 'h1')).toEqual(['u2'])
    // Steps 5–7 wait for every group.
    expect(rowOf(services, 'identities', 'i1')).toBeDefined()
    expect(services.users.account('u1')).toBeDefined()

    // A done group is skipped; this one carries on from the archive.
    await setRow(services, 'statements', 'st1', { status: 'final' })
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'groups', 'e1')).toMatchObject({ archivedAt: DELETED_AT })
    expect(teamOf(services, 'e1')).toEqual(['u3'])
    // One member.left each, never a second on the rerun, and the archive's row once.
    expect(activityIn(services, 'e1').map((row) => row.action)).toEqual([
      'member.left',
      'group.archived',
    ])
    expect(activityIn(services, 'h1').map((row) => row.action)).toEqual(['member.left'])
  })

  it('leaves a keep for a later run when the group’s time zone changes before it commits', async () => {
    const services = kept()
    // Read in Sydney, where it's already 19 October; in Los Angeles it's still the 18th.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rowId":"h1-p1"'),
      () => setRow(services, 'groups', 'h1', { timezone: 'America/Los_Angeles' }),
    )
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({ status: 'active', leftOn: null })
    expect(activityIn(services, 'h1')).toEqual([])
    expect(teamOf(services, 'h1')).toEqual(['u1', 'u2'])
    vi.restoreAllMocks()
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({
      status: 'left',
      leftOn: '2026-10-18',
    })
  })

  it.each([
    [
      'an admin moved them out',
      { status: 'left', role: 'viewer', leftOn: '2026-10-05' },
      '2026-10-05',
    ],
    ['an admin moved their start to next month', { joinedOn: '2026-11-01' }, '2026-11-01'],
    ['a merge gave the row to another person', { personId: 'p9' }, null],
    ['an admin removed the row', null, null],
  ] as const)(
    'leaves a keep for a later run when %s after the rows were listed',
    async (_, change, leftOn) => {
      const services = kept()
      beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"h1-p1"'),
        () =>
          change
            ? setRow(services, 'members', 'h1-p1', change)
            : withTransaction(services.db, (tx) =>
                tx.write({ action: 'delete', tableId: 'members', rowId: 'h1-p1' }),
              ),
      )
      const before = rowOf(services, 'members', 'h1-p1')
      expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
      expect(rowOf(services, 'members', 'h1-p1')).toEqual(
        change ? { ...before, ...change, $updatedAt: expect.any(String) } : undefined,
      )
      expect(activityIn(services, 'h1')).toEqual([])
      vi.restoreAllMocks()
      expect((await remove(services)).finished).toBe(true)
      // A row still theirs is kept on the rerun, with the dates as they are now.
      if (leftOn) {
        expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({
          displayName: 'Former member',
          status: 'left',
          leftOn,
        })
      }
    },
  )

  it('leaves the archive for a later run when the group was archived meanwhile, never twice', async () => {
    const services = kept()
    // Another run of this deletion, say, archived e1 first.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"archivedAt"') && operations.includes('"rowId":"e1"'),
      async () => {
        await setRow(services, 'groups', 'e1', { archivedAt: EARLIER, nextCloseAt: null })
        await insert(services, 'activity', [
          {
            $id: 'aArchived',
            groupId: 'e1',
            actorPersonId: 'p1',
            action: 'group.archived',
            summary: 'Archived the group',
            at: EARLIER,
          },
        ])
      },
    )
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'groups', 'e1')).toMatchObject({ archivedAt: EARLIER })
    expect(teamOf(services, 'e1')).toEqual(['u1', 'u3'])
    vi.restoreAllMocks()
    // The rerun finds it archived, so it only leaves the team.
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'groups', 'e1')).toMatchObject({ archivedAt: EARLIER })
    expect(teamOf(services, 'e1')).toEqual(['u3'])
    expect(activityIn(services, 'e1').map((row) => row.action)).toEqual([
      'member.left',
      'group.archived',
    ])
  })

  it('purges a group nobody else is in, such as their personal group, and keeps the others', async () => {
    const services = kept()
    await withPersonalGroup(services)
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'groups', 'me')).toBeUndefined()
    expect(rowOf(services, 'members', 'me-p1')).toBeUndefined()
    expect(teamOf(services, 'me')).toBeUndefined()
    expect(activityIn(services, 'me')).toEqual([])
    expect(teamOf(services, 'h1')).toEqual(['u2'])
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({ status: 'left' })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null })
  })

  it('leaves groups where they never joined exactly as they are', async () => {
    const services = kept()
    await insert(services, 'groups', [group('g5', 'house', 'p2')])
    await insert(services, 'members', [
      member('g5', 'p1', { role: 'member', status: 'placeholder' }),
      member('g5', 'p2'),
    ])
    await services.teams.create({ teamId: 'g5', name: 'g5' })
    await services.teams.createMembership({ teamId: 'g5', roles: [], userId: 'u2' })
    const placeholder = rowOf(services, 'members', 'g5-p1')
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'members', 'g5-p1')).toEqual(placeholder)
    expect(rowOf(services, 'groups', 'g5')).not.toHaveProperty('rev')
    expect(activityIn(services, 'g5')).toEqual([])
  })

  it('carries on the purge of a group whose team is gone, without deciding again', async () => {
    const services = kept()
    await insert(services, 'groups', [group('g6', 'house', 'p1', { archivedAt: DELETED_AT })])
    await insert(services, 'members', [member('g6', 'p1')])
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'groups', 'g6')).toBeUndefined()
    expect(rowOf(services, 'members', 'g6-p1')).toBeUndefined()
  })

  it('never decides again: a kept group stays kept once everyone else has left its team', async () => {
    const services = kept()
    crashOnList(services, (tableId) => tableId === 'schedules', 2)
    expect((await call(services)).status).toBe(500)
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({ status: 'left' })
    vi.restoreAllMocks()
    await removeFromTeam(services.teams, 'h1', 'u2')
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'groups', 'h1')).toBeDefined()
    expect(rowOf(services, 'schedules', 'sGroceries')).toMatchObject({ endsOn: TODAY })
    expect(teamOf(services, 'h1')).toEqual([])
    expect(activityIn(services, 'h1')).toHaveLength(1)
  })
})

describe('POST /delete: steps 5 to 7', () => {
  it('once every group is done, deletes their identities, sent invites and profile, unlinks the person, then the user', async () => {
    const services = kept()
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['i3'])
    expect(services.db.rows('invites').map((row) => row.$id)).toEqual(['v3'])
    expect(services.db.rows('profiles').map((row) => row.$id)).toEqual(['u2'])
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({
      userId: null,
      deletedAt: DELETED_AT,
      displayName: 'Former member',
      $permissions: [],
    })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('also deletes the identities of a person still being merged into them, and no one else’s', async () => {
    const services = kept()
    // P's merge into Sam was cut off before its identities moved (they move last).
    await insert(services, 'persons', [
      person('pMerging', null, { mergedInto: 'p1' }),
      person('pOther', null, { mergedInto: 'p2' }),
    ])
    await insert(services, 'identities', [
      identity('iM', 'email:sam.old@example.com', 'pMerging'),
      identity('iO', 'email:someone@example.com', 'pOther'),
    ])
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['i3', 'iO'])
  })

  it('waits for a group joined or made after step 4 listed their member rows, which a rerun does', async () => {
    const services = kept()
    // Alex added Sam to the house g5; Sam hasn't joined it yet (D-016).
    await insert(services, 'groups', [group('g5', 'house', 'p2')])
    await insert(services, 'members', [
      member('g5', 'p1', { role: 'member', status: 'placeholder' }),
      member('g5', 'p2'),
    ])
    await services.teams.create({ teamId: 'g5', name: 'g5' })
    await services.teams.createMembership({ teamId: 'g5', roles: [], userId: 'u2' })
    // Once the rows are listed (at the first keep), Sam's join of g5 commits, and so does a
    // group h2 Sam made.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rowId":"e1-p1"'),
      async () => {
        await services.teams.createMembership({ teamId: 'g5', roles: [], userId: 'u1' })
        await setRow(services, 'members', 'g5-p1', { status: 'active' })
        await insert(services, 'groups', [group('h2', 'house', 'p1')])
        await insert(services, 'members', [member('h2', 'p1'), member('h2', 'p2')])
        await services.teams.create({ teamId: 'h2', name: 'h2' })
        await services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u1' })
        await services.teams.createMembership({ teamId: 'h2', roles: [], userId: 'u2' })
      },
    )
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    // The groups it listed are done; steps 5–7 wait for the others.
    expect(teamOf(services, 'h1')).toEqual(['u2'])
    expect(rowOf(services, 'members', 'g5-p1')).toMatchObject({ status: 'active' })
    expect(rowOf(services, 'identities', 'i1')).toBeDefined()
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1' })
    expect(services.users.account('u1')).toBeDefined()

    vi.restoreAllMocks()
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    for (const groupId of ['g5', 'h2']) {
      expect(rowOf(services, 'members', `${groupId}-p1`)).toMatchObject({
        displayName: 'Former member',
        status: 'left',
        role: 'viewer',
      })
      expect(teamOf(services, groupId)).toEqual(['u2'])
    }
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('purges a person a bootstrap made after step 2, with its personal group, then deletes the user', async () => {
    const services = kept()
    // A bootstrap that read no label and no deleted person before step 3, and no profile once
    // step 5 had deleted it, commits its person, profile, personal group and team before step 6.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"userId":null'),
      async () => {
        await services.teams.create({ teamId: 'gNew', name: 'Personal' })
        await services.teams.createMembership({ teamId: 'gNew', roles: [], userId: 'u1' })
        await insert(services, 'persons', [person('pNew', 'u1', { claimedAt: DELETED_AT })])
        await insert(services, 'profiles', [profile('u1', 'pNew')])
        await insert(services, 'identities', [identity('iNew', 'email:sam@example.com', 'pNew')])
        await insert(services, 'groups', [group('gNew', 'personal', 'pNew')])
        await insert(services, 'members', [member('gNew', 'pNew')])
      },
    )
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    for (const [tableId, rowId] of [
      ['persons', 'pNew'],
      ['profiles', 'u1'],
      ['identities', 'iNew'],
      ['groups', 'gNew'],
      ['members', 'gNew-pNew'],
    ] as const) {
      expect(rowOf(services, tableId, rowId)).toBeUndefined()
    }
    expect(teamOf(services, 'gNew')).toBeUndefined()
    expect(activityIn(services, 'gNew')).toEqual([])
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('keeps the user while the person a bootstrap made isn’t empty after all', async () => {
    const services = kept()
    // It adopted a placeholder someone had added to a group.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"userId":null'),
      () => insert(services, 'persons', [person('pNew', 'u1', { claimedAt: DELETED_AT })]),
    )
    await insert(services, 'members', [
      member('h1', 'pNew', { role: 'member', status: 'placeholder' }),
    ])
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'persons', 'pNew')).toMatchObject({ userId: 'u1', deletedAt: null })
    expect(rowOf(services, 'members', 'h1-pNew')).toBeDefined()
    expect(services.users.account('u1')).toMatchObject({ labels: ['deleted'], status: false })
  })
})

describe('POST /delete: reruns and the time budget', () => {
  // e1 comes first ($id order): kept and archived, then h1, kept with Sam's schedule.
  const crashes: Array<[string, (services: Fakes) => void]> = [
    ['step 2', (services) => crashOnCall(services.users, 'updateLabels')],
    ['step 3', (services) => crashOnCall(services.teams, 'listMemberships')],
    ['a keep', (services) => crashOnList(services, (tableId) => tableId === 'schedules')],
    [
      'ending the schedules',
      (services) =>
        crashOnList(
          services,
          (tableId, queries) => tableId === 'members' && queries.includes('role'),
          2,
        ),
    ],
    ['the archive', (services) => crashOnCall(services.teams, 'deleteMembership')],
    [
      'one group',
      (services) =>
        crashOnCall(services.teams, 'listMemberships', (params) => params.teamId === 'h1'),
    ],
    ['step 4', (services) => crashOnList(services, (tableId) => tableId === 'identities')],
    [
      'step 5',
      (services) => {
        const stage = services.db.createOperations.bind(services.db)
        let crashed = false
        vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
          if (!crashed && JSON.stringify(params.operations).includes('"userId":null')) {
            crashed = true
            throw new Error('Crashed')
          }
          return stage(params)
        })
      },
    ],
  ]

  async function oneRun() {
    const services = kept()
    expect((await remove(services)).finished).toBe(true)
    return state(services)
  }

  it.each(crashes)('leaves the same rows after a crash after %s and a rerun', async (_, crash) => {
    const services = kept()
    crash(services)
    const crashed = await call(services)
    expect(crashed.status).toBe(500)
    // Only IDs and codes in the log line, never the error's message.
    expect(crashed.logs.join('\n')).not.toMatch(/Crashed|Sam|@/)
    vi.restoreAllMocks()
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(state(services)).toEqual(await oneRun())
  })

  it('leaves only the user, labelled and blocked, to the hourly job after a crash after step 6', async () => {
    const services = kept()
    crashOnCall(services.users, 'delete')
    expect((await call(services)).status).toBe(500)
    vi.restoreAllMocks()
    // No person names the user any more, so only the job can find it (hourly-job.test.ts).
    expect(await failure(services)).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    const { users, ...rest } = state(services)
    const { users: _, ...done } = await oneRun()
    expect(rest).toEqual(done)
    expect(users[0]).toMatchObject({ labels: ['deleted'], status: false, sessions: [] })
  })

  it('keeps the user when out of time just after step 6', async () => {
    const services = kept()
    services.outOfTime = () => rowOf(services, 'persons', 'p1')?.userId === null
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null, $permissions: [] })
    // Labelled and blocked, for the hourly job (#50 PR-3).
    expect(services.users.account('u1')).toMatchObject({ labels: ['deleted'], status: false })
  })

  it('stops between groups once out of time, and a rerun carries on', async () => {
    const services = kept()
    services.outOfTime = vi
      .fn(() => false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true)
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(teamOf(services, 'e1')).toEqual(['u3'])
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({ status: 'active' })
    services.outOfTime = () => false
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(state(services)).toEqual(await oneRun())
  })
})

describe('other routes', () => {
  it('answers like every function', async () => {
    const services = kept()
    expect(await failure(services, { method: 'GET' })).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(services, { userId: null })).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
  })

  it('GET /health is public and says nothing about the caller', async () => {
    const { status, body } = await call(kept(), { method: 'GET', path: '/health', userId: null })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { fn: 'account', version: 'dev' } })
  })
})
