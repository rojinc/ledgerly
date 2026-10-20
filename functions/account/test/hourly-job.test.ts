import { readFileSync } from 'node:fs'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountRoutes } from '../src/main'
import type { JobResult } from '../src/routes/hourly-job'
import {
  account,
  call,
  crashOnCall,
  crashOnList,
  type FakeAccount,
  type Fakes,
  FakeUsers,
  failure,
  fakes,
  group,
  insert,
  member,
  minutesAgo,
  NOW,
  ok,
  person,
  rowOf,
  setRow,
  teamOf,
} from './harness'

// The route got past step 3 five minutes ago, then stopped.
const STARTED = minutesAgo(5)
const SEEN_TABLES = [
  'persons',
  'identities',
  'profiles',
  'groups',
  'members',
  'statements',
  'activity',
] as const

afterEach(() => {
  vi.restoreAllMocks()
})

/** u1, labelled `deleted`, blocked and signed out at `$updatedAt`. */
function labelled(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return account({
    labels: ['deleted'],
    status: false,
    sessions: [],
    $updatedAt: STARTED,
    ...overrides,
  })
}

// Sam (p1, u1) is alone in their personal group `me`, and the only admin of the employer group
// e1, where Acme (p3, u3) is a viewer. Sam's deletion set `deletedAt` (null: not started yet), and
// their person still names u1.
function unfinished(deletedAt: string | null = STARTED, sam: FakeAccount = labelled()) {
  return fakes(
    {
      persons: [
        person('p1', 'u1', { displayName: deletedAt ? 'Former member' : 'Sam', deletedAt }),
        person('p3', 'u3'),
      ],
      identities: [
        identity('i1', 'email:sam@example.com', 'p1'),
        identity('i3', 'email:acme@example.com', 'p3'),
      ],
      profiles: [profile('u1', 'p1')],
      groups: [group('me', 'personal', 'p1'), group('e1', 'employer', 'p1')],
      members: [
        member('me', 'p1'),
        member('e1', 'p1', { displayName: 'Sam' }),
        member('e1', 'p3', { role: 'viewer' }),
      ],
    },
    { accounts: [sam, account({ $id: 'u3' })], teams: { me: ['u1'], e1: ['u1', 'u3'] } },
  )
}

// Steps 1–6 are done: no person names u1 any more, but the user is still there.
function leftUser() {
  return fakes(
    {
      persons: [person('p1', null, { displayName: 'Former member', deletedAt: STARTED })],
    },
    { accounts: [labelled(), account({ $id: 'u3' })] },
  )
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: key.split(':')[0], personId, verified: true, verifiedAt: null }
}

function profile(userId: string, personId: string) {
  return { $id: userId, personId, timezone: 'Australia/Sydney', region: 'AU-NSW' }
}

// A bootstrap that read u1 before step 3 labelled it made pNew, its profile, identity and
// personal group, after step 2.
async function withStray(services: Fakes) {
  await services.teams.create({ teamId: 'gNew', name: 'Personal' })
  await services.teams.createMembership({ teamId: 'gNew', roles: [], userId: 'u1' })
  await insert(services, 'persons', [person('pNew', 'u1', { claimedAt: STARTED })])
  await insert(services, 'profiles', [profile('u1', 'pNew')])
  await insert(services, 'identities', [identity('iNew', 'email:sam@example.com', 'pNew')])
  await insert(services, 'groups', [group('gNew', 'personal', 'pNew')])
  await insert(services, 'members', [member('gNew', 'pNew')])
}

function runJob(services: Fakes) {
  return ok<JobResult>(services, { path: '/', body: undefined, userId: null, scheduled: true })
}

/** Every row, team and account, for "changes nothing" and "the same rows" checks. */
function state(services: Fakes) {
  const rows = Object.fromEntries(
    SEEN_TABLES.map((tableId) => [
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
  return { rows, teams, users: ['u1', 'u3'].map((id) => services.users.account(id)) }
}

async function finishedOnce() {
  const services = unfinished()
  expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
  return state(services)
}

describe('POST / (the hourly job)', () => {
  it('runs only as its own cron', async () => {
    const services = unfinished()
    const before = state(services)
    expect(await failure(services, { path: '/', body: undefined })).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(await failure(services, { path: '/', body: undefined, userId: null })).toEqual({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
    // A person's request is never a cron run, whatever its trigger says.
    expect(await failure(services, { path: '/', body: undefined, scheduled: true })).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(state(services)).toEqual(before)
  })

  it('refuses a person before it needs the execution’s API key', async () => {
    const handler = createHandler(
      accountRoutes(() => {
        throw new Error('The x-appwrite-key header is missing')
      }),
      () => fakes().db,
      async () => 'u1',
    )
    let status: number | undefined
    await handler({
      req: {
        method: 'POST',
        path: '/',
        headers: { 'x-appwrite-user-jwt': 'h.e30.sig' },
        bodyText: '',
      },
      res: { json: (_body, code) => (status = code) },
      log: () => {},
      error: () => {},
    })
    expect(status).toBe(403)
  })

  it('returns counts and logs IDs only', async () => {
    const services = unfinished()
    const { body, logs } = await call(services, {
      path: '/',
      body: undefined,
      userId: null,
      scheduled: true,
    })
    expect(body).toEqual({
      ok: true,
      data: { finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 },
    })
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0] ?? '')).toMatchObject({ route: 'POST /', status: 200 })
  })
})

describe('POST /: finishing deletions', () => {
  it.each([
    ['a minute', 1],
    ['an hour', 60],
  ])('finishes steps 3 to 7 of a deletion started %s ago', async (_, minutes) => {
    const services = unfinished(minutesAgo(minutes))
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
    // Their personal group is purged, and the employer group kept and archived.
    expect(rowOf(services, 'groups', 'me')).toBeUndefined()
    expect(teamOf(services, 'me')).toBeUndefined()
    expect(rowOf(services, 'members', 'e1-p1')).toMatchObject({
      displayName: 'Former member',
      status: 'left',
      role: 'viewer',
    })
    expect(rowOf(services, 'groups', 'e1')).toMatchObject({ archivedAt: NOW.toISOString() })
    expect(teamOf(services, 'e1')).toEqual(['u3'])
    expect(rowOf(services, 'identities', 'i1')).toBeUndefined()
    expect(rowOf(services, 'profiles', 'u1')).toBeUndefined()
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null, $permissions: [] })
    expect(services.users.account('u1')).toBeUndefined()
    // Acme is untouched.
    expect(rowOf(services, 'identities', 'i3')).toBeDefined()
    expect(services.users.account('u3')).toBeDefined()
  })

  it('locks the user out first when the route stopped before step 3', async () => {
    const services = unfinished(STARTED, account())
    crashOnCall(services.teams, 'listMemberships')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 1 })
    expect(services.users.account('u1')).toMatchObject({
      labels: ['deleted'],
      status: false,
      sessions: [],
    })
    vi.restoreAllMocks()
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('skips a deletion started in the last minute, which the route may still be running', async () => {
    const services = unfinished(minutesAgo(0.5), labelled({ $updatedAt: minutesAgo(0.5) }))
    const before = state(services)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(state(services)).toEqual(before)
  })

  it.each<[string, (services: Fakes) => void]>([
    [
      'a group',
      (services) =>
        crashOnCall(services.teams, 'listMemberships', (params) => params.teamId === 'e1'),
    ],
    [
      'ending the schedules',
      (services) => crashOnList(services, (tableId) => tableId === 'schedules'),
    ],
    ['step 5', (services) => crashOnList(services, (tableId) => tableId === 'identities')],
    ['step 7', (services) => crashOnCall(services.users, 'delete')],
  ])(
    'counts a crash in %s, logging IDs only, and a later run finishes with the same rows',
    async (_, crash) => {
      const services = unfinished()
      crash(services)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const crashed = await call(services, {
        path: '/',
        body: undefined,
        userId: null,
        scheduled: true,
      })
      expect(crashed.body).toMatchObject({ ok: true, data: { failed: 1 } })
      expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { fn: 'unknown', event: 'account_finish_failed', personId: 'p1', cause: 'Error' },
      ])
      expect(crashed.logs.join('\n')).not.toMatch(/Crashed|Sam|@/)
      vi.restoreAllMocks()
      const rerun = await runJob(services)
      expect(rerun.failed).toBe(0)
      expect(state(services)).toEqual(await finishedOnce())
    },
  )

  it('keeps the user while its deletion waits for the next run, then finishes', async () => {
    const services = unfinished()
    // The archive of e1 waits until the finalize ends.
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
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    // Labelled long ago, and named by no person without `deletedAt`, but p1 still names it.
    expect(services.users.account('u1')).toBeDefined()
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1' })
    await setRow(services, 'statements', 'st1', { status: 'final' })
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
  })
})

describe('POST /: users labelled deleted', () => {
  it('deletes one that no person names any more, and changes nothing else', async () => {
    const services = leftUser()
    const { users: _, ...before } = state(services)
    expect(await runJob(services)).toEqual({ finished: 0, users: 1, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
    const { users, ...after } = state(services)
    expect(after).toEqual(before)
    expect(users[1]).toBeDefined()
  })

  it('waits while the label is less than a minute old, as after a route that crashed after step 6', async () => {
    const services = unfinished(null, account())
    crashOnCall(services.users, 'delete')
    expect((await call(services)).status).toBe(500)
    vi.restoreAllMocks()
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null })
    // The route labelled u1 just now, on the real clock.
    services.now = new Date()
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toMatchObject({ labels: ['deleted'] })
    services.now = new Date(Date.now() + 2 * 60_000)
    expect(await runJob(services)).toEqual({ finished: 0, users: 1, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('never touches a user without the label, even if a listing returned one', async () => {
    // Signed up, but not set up yet: no person names them.
    const others = [account({ $id: 'u7' }), account({ $id: 'u8', labels: ['vip'] })]
    const services = leftUser()
    services.users = new FakeUsers([labelled(), ...others])
    expect(await runJob(services)).toEqual({ finished: 0, users: 1, groups: 0, e2e: 0, failed: 0 })
    vi.spyOn(services.users, 'list').mockImplementation(async () => ({ users: others }))
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u7')).toBeDefined()
    expect(services.users.account('u8')).toBeDefined()
  })

  it('purges a person a bootstrap made after step 2, with its personal group, then deletes the user', async () => {
    const services = leftUser()
    await withStray(services)
    expect(await runJob(services)).toEqual({ finished: 0, users: 1, groups: 0, e2e: 0, failed: 0 })
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
    expect(services.db.rows('activity')).toEqual([])
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ deletedAt: STARTED, userId: null })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('keeps the user while the person a bootstrap made isn’t empty after all', async () => {
    const services = leftUser()
    await insert(services, 'persons', [person('pNew', 'u1', { claimedAt: STARTED })])
    // It adopted a placeholder someone had added to a group.
    await insert(services, 'members', [
      member('h1', 'pNew', { role: 'member', status: 'placeholder' }),
    ])
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(rowOf(services, 'persons', 'pNew')).toMatchObject({ userId: 'u1' })
    expect(services.users.account('u1')).toBeDefined()
  })

  it('works through every page of 100, past the users it skips, listing only labelled ones', async () => {
    const recent = minutesAgo(0.5)
    const ids = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}${`${index}`.padStart(3, '0')}`)
    const services = fakes(
      {},
      {
        accounts: [
          ...ids('a', 150).map(($id) => labelled({ $id, $updatedAt: recent })),
          ...ids('b', 105).map(($id) => labelled({ $id })),
          ...ids('c', 100).map(($id) => account({ $id })),
          labelled({ $id: 'z' }),
        ],
      },
    )
    const list = vi.spyOn(services.users, 'list')
    expect(await runJob(services)).toEqual({
      finished: 0,
      users: 106,
      groups: 0,
      e2e: 0,
      failed: 0,
    })
    expect(ids('a', 150).every((id) => services.users.account(id))).toBe(true)
    expect(ids('c', 100).every((id) => services.users.account(id))).toBe(true)
    expect(services.users.account('z')).toBeUndefined()
    // Three pages of the `deleted` label; the e2e pass lists its own label once, and finds none.
    const pagesOf = (label: string) =>
      list.mock.calls.filter(([{ queries }]) => queries.some((query) => query.includes(label)))
    expect(pagesOf('"deleted"')).toHaveLength(3)
    expect(pagesOf('"e2e"')).toHaveLength(1)
  })
})

// A run's Resend test address, as e2e/dev-project.ts makes them.
const RUN_ADDRESS = 'delivered+e2emq1abcd2f3e4a5-kim@resend.dev'

/** u1, labelled `e2e` and blocked by a run's teardown five minutes ago. */
function runUser(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return account({
    email: RUN_ADDRESS,
    labels: ['e2e'],
    status: false,
    sessions: [],
    $updatedAt: STARTED,
    ...overrides,
  })
}

// Kim (p1, u1), a flow's worker: alone in their personal group `me`, and in the archived employer
// group e1, whose employer (p3) never joined. Kim's identities have `keys`.
function e2eRun(kim: FakeAccount = runUser(), keys = [`email:${RUN_ADDRESS}`]) {
  return fakes(
    {
      persons: [person('p1', 'u1', { displayName: 'Kim e2emq1abcd2f3e4a5' }), person('p3', null)],
      identities: keys.map((key, index) => identity(`i${index + 1}`, key, 'p1')),
      profiles: [profile('u1', 'p1')],
      groups: [
        group('me', 'personal', 'p1'),
        group('e1', 'employer', 'p1', { archivedAt: STARTED }),
      ],
      members: [
        member('me', 'p1'),
        member('e1', 'p1'),
        member('e1', 'p3', { role: 'viewer', status: 'placeholder' }),
      ],
    },
    { accounts: [kim, account({ $id: 'u3' })], teams: { me: ['u1'], e1: ['u1'] } },
  )
}

describe('POST /: the e2e pass (#386)', () => {
  it('deletes a labelled user with a run’s address as POST /delete would, its groups and rows included', async () => {
    const services = e2eRun()
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 1, failed: 0 })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({
      deletedAt: NOW.toISOString(),
      displayName: 'Former member',
      userId: null,
    })
    for (const groupId of ['me', 'e1']) {
      expect(rowOf(services, 'groups', groupId)).toBeUndefined()
      expect(teamOf(services, groupId)).toBeUndefined()
    }
    expect(services.db.rows('members')).toEqual([])
    expect(rowOf(services, 'identities', 'i1')).toBeUndefined()
    expect(rowOf(services, 'profiles', 'u1')).toBeUndefined()
    expect(services.users.account('u1')).toBeUndefined()
    expect(services.users.account('u3')).toBeDefined()
  })

  it('keeps a group two of a run’s users share with the first, and purges it with the second', async () => {
    const bo = 'delivered+e2emq1abcd2f3e4a5-bo@resend.dev'
    const services = fakes(
      {
        persons: [person('p1', 'u1'), person('p2', 'u2')],
        identities: [
          identity('i1', `email:${RUN_ADDRESS}`, 'p1'),
          identity('i2', `email:${bo}`, 'p2'),
        ],
        groups: [
          group('me', 'personal', 'p1'),
          group('me2', 'personal', 'p2'),
          group('pr', 'pair', 'p1'),
        ],
        members: [member('me', 'p1'), member('me2', 'p2'), member('pr', 'p1'), member('pr', 'p2')],
      },
      {
        // Bo isn't labelled yet: the first run deletes Kim alone.
        accounts: [runUser(), runUser({ $id: 'u2', email: bo, labels: [] })],
        teams: { me: ['u1'], me2: ['u2'], pr: ['u1', 'u2'] },
      },
    )
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 1, failed: 0 })
    // Kept for Bo, with Kim's row as a former member's.
    expect(rowOf(services, 'groups', 'pr')).toBeDefined()
    expect(teamOf(services, 'pr')).toEqual(['u2'])
    expect(rowOf(services, 'members', 'pr-p2')).toMatchObject({ status: 'active' })
    expect(rowOf(services, 'members', 'pr-p1')).toMatchObject({ displayName: 'Former member' })
    // Labelled now, on the real clock, as FakeUsers stamps it.
    await services.users.updateLabels({ userId: 'u2', labels: ['e2e'] })
    services.now = new Date(Date.now() + 2 * 60_000)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 1, failed: 0 })
    expect(services.db.rows('groups')).toEqual([])
    expect(services.db.rows('members')).toEqual([])
    expect(teamOf(services, 'pr')).toBeUndefined()
    expect(services.users.account('u1')).toBeUndefined()
    expect(services.users.account('u2')).toBeUndefined()
  })

  it.each([
    ['no run ID', 'delivered+kim@resend.dev'],
    ['a run ID too short', 'delivered+e2eabc-kim@resend.dev'],
    ['another domain after it', 'delivered+e2emq1abcd2f3e4a5-kim@resend.dev.example.com'],
    ['another domain', 'delivered+e2emq1abcd2f3e4a5-kim@example.com'],
    ['a lookalike domain', 'delivered+e2emq1abcd2f3e4a5-kim@resend-dev'],
    ['a resend.dev subdomain', 'delivered+e2emq1abcd2f3e4a5-kim@mail.resend.dev'],
    ['upper case', 'Delivered+E2EMQ1ABCD2F3E4A5-KIM@RESEND.DEV'],
    ['no delivered+', 'e2emq1abcd2f3e4a5-kim@resend.dev'],
    ['something before it', 'x.delivered+e2emq1abcd2f3e4a5-kim@resend.dev'],
    ['a real address', 'kim@example.com'],
  ])('leaves alone a labelled user with %s, and says so by its ID only', async (_, email) => {
    const services = e2eRun(runUser({ email }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toMatchObject({ email, labels: ['e2e'] })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1', deletedAt: null })
    expect(rowOf(services, 'groups', 'me')).toBeDefined()
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { fn: 'unknown', event: 'e2e_user_not_deleted', userId: 'u1' },
    ])
  })

  it('never touches a run’s address without the label, even if a listing returned one', async () => {
    const services = e2eRun(runUser({ labels: [] }))
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    vi.spyOn(services.users, 'list').mockImplementation(async () => ({
      users: [runUser({ labels: ['vip'] })],
    }))
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeDefined()
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1', deletedAt: null })
  })

  it('fails the run, logged, when Appwrite refuses the label query, rather than finding nobody', async () => {
    const services = e2eRun()
    const list = services.users.list.bind(services.users)
    vi.spyOn(services.users, 'list').mockImplementation(async (params) => {
      if (params.queries.some((query) => query.includes('"e2e"'))) throw new Error('Refused')
      return list(params)
    })
    const { status, logs } = await call(services, {
      path: '/',
      body: undefined,
      userId: null,
      scheduled: true,
    })
    expect(status).toBe(500)
    expect(JSON.parse(logs[0] ?? '')).toMatchObject({ route: 'POST /', status: 500 })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1', deletedAt: null })
  })

  it('waits while the label is less than a minute old', async () => {
    const services = e2eRun(runUser({ $updatedAt: minutesAgo(0.5) }))
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ deletedAt: null })
    services.now = new Date(NOW.getTime() + 60_000)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 1, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('deletes a user with no person, as after a setup that failed before its first sign-in', async () => {
    const services = fakes({}, { accounts: [runUser(), account({ $id: 'u3' })] })
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 1, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
    expect(services.users.account('u3')).toBeDefined()
  })

  it.each([
    ['a real address beside the run’s', [`email:${RUN_ADDRESS}`, 'email:kim@example.com']],
    ['a phone', [`email:${RUN_ADDRESS}`, 'phone:+61400000000']],
    ['only a real address', ['email:kim@example.com']],
    ['none', []],
  ])(
    'leaves alone a run’s user whose person has %s as an identity, which the key can’t change',
    async (_, keys) => {
      const services = e2eRun(runUser(), keys)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await runJob(services)).toEqual({
        finished: 0,
        users: 0,
        groups: 0,
        e2e: 0,
        failed: 0,
      })
      expect(services.users.account('u1')).toMatchObject({ labels: ['e2e'] })
      expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1', deletedAt: null })
      expect(rowOf(services, 'groups', 'me')).toBeDefined()
      expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { fn: 'unknown', event: 'e2e_user_not_deleted', userId: 'u1' },
      ])
    },
  )

  it('finishes the person whose deletion started, purging a bootstrap’s stray, without checking identities again', async () => {
    // The user's own delete got past step 2 30 seconds ago (too soon for the account pass), then
    // stopped; p1 has no identity to check. A bootstrap made pNew meanwhile.
    const services = fakes(
      {
        persons: [person('p1', 'u1', { displayName: 'Former member', deletedAt: minutesAgo(0.5) })],
      },
      { accounts: [runUser(), account({ $id: 'u3' })] },
    )
    await withStray(services)
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 1, failed: 0 })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null })
    expect(rowOf(services, 'persons', 'pNew')).toBeUndefined()
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('leaves a deletion under way, labelled deleted, to the account pass', async () => {
    const services = e2eRun(runUser({ labels: ['e2e', 'deleted'] }))
    await setRow(services, 'persons', 'p1', { deletedAt: minutesAgo(0.5) })
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: 'u1' })
    services.now = new Date(NOW.getTime() + 60_000)
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('leaves a deletion it cut off to the account pass, which finishes it on the next run', async () => {
    const services = e2eRun()
    crashOnCall(services.teams, 'listMemberships')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runJob(services)).toEqual({ finished: 0, users: 0, groups: 0, e2e: 0, failed: 1 })
    // Past step 2, and locked out by step 3.
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ deletedAt: NOW.toISOString() })
    expect(services.users.account('u1')).toMatchObject({ labels: ['e2e', 'deleted'] })
    vi.restoreAllMocks()
    services.now = new Date(NOW.getTime() + 60 * 60_000)
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(services.users.account('u1')).toBeUndefined()
    expect(services.db.rows('groups')).toEqual([])
  })
})

describe('POST /: the time budget', () => {
  it('stops taking work once it is used up, and the next run carries on', async () => {
    const services = unfinished()
    await insert(services, 'persons', [
      person('p4', 'u4', { deletedAt: STARTED }),
      person('p5', 'u5', { deletedAt: STARTED }),
    ])
    services.users = new FakeUsers(
      ['u1', 'u4', 'u5', 'u9'].map(($id) => labelled({ $id })).concat(account({ $id: 'u3' })),
    )
    services.outOfTime = () => services.users.account('u1') === undefined
    expect(await runJob(services)).toEqual({ finished: 1, users: 0, groups: 0, e2e: 0, failed: 0 })
    expect(rowOf(services, 'persons', 'p4')).toMatchObject({ userId: 'u4' })
    expect(services.users.account('u9')).toBeDefined()
    services.outOfTime = () => false
    expect(await runJob(services)).toEqual({ finished: 2, users: 1, groups: 0, e2e: 0, failed: 0 })
    expect(['u4', 'u5', 'u9'].map((id) => services.users.account(id))).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe('appwrite/functions.json', () => {
  it('deploys account every 60 minutes (the plan allows no cron), with the job’s timeout, and the scopes its routes need', () => {
    const functions = JSON.parse(
      readFileSync(new URL('../../../appwrite/functions.json', import.meta.url), 'utf8'),
    ) as Array<{ $id: string }>
    expect(functions.find((entry) => entry.$id === 'account')).toEqual({
      $id: 'account',
      name: 'account',
      runtime: 'node-24',
      path: '../functions/account',
      entrypoint: 'dist/main.js',
      commands: '',
      ignore: ['*', '!dist/', '!dist/**', '!package.json'],
      execute: ['users'],
      events: [],
      interval: 60,
      timeout: 900,
      enabled: true,
      logging: true,
      scopes: [
        'rows.read',
        'rows.write',
        'teams.read',
        'teams.write',
        'users.read',
        'users.write',
        'files.read',
        'files.write',
      ],
    })
  })
})
