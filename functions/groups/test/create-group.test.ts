import type { CreateGroupResult } from '@ledgerly/core/schemas/groups'
import type { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import {
  beforeCommit,
  createRow,
  failure,
  fakes,
  group,
  member,
  NOW,
  ok,
  person,
  profile,
  TODAY,
  TRY_AGAIN,
  updateRow,
} from './harness'

const HOUSE = { id: 'g1', type: 'house', name: 'Flat' }
const EMPLOYER = {
  id: 'g1',
  type: 'employer',
  name: 'Acme work',
  counterpart: { displayName: 'Boss', email: 'boss@example.com' },
}
const PAIR = { id: 'g1', type: 'pair', name: 'Us', counterpart: { displayName: 'Kim' } }
const TEAM = ['read("team:g1")']

// User u1 (person p1) has set up their account.
function setUp(teams: Record<string, string[]> = {}) {
  return fakes({ persons: [person(1)], profiles: [profile(1)] }, teams)
}

function teamUsers(services: ReturnType<typeof setUp>) {
  return services.teams.members('g1')?.map((membership) => membership.userId)
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: key.split(':')[0], personId, verified: true, verifiedAt: null }
}

describe('POST /groups', () => {
  it('creates a house group with the creator as admin and the only team member', async () => {
    const services = setUp()
    const result = await ok<CreateGroupResult>(services, 'POST', '/groups', HOUSE)
    const { db, teams } = services
    expect(result.group).toMatchObject({
      $id: 'g1',
      type: 'house',
      name: 'Flat',
      ownerPersonId: 'p1',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      statementCycle: 'none',
      cycleAnchor: null,
      nextCloseAt: null,
      settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"days"}',
      archivedAt: null,
      $permissions: TEAM,
    })
    expect(result.members).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        personId: 'p1',
        displayName: 'Person 1',
        role: 'admin',
        status: 'active',
        joinedOn: TODAY,
        $permissions: TEAM,
      }),
    ])
    expect(db.rows('groups')).toEqual([result.group])
    expect(teams.members('g1')).toEqual([{ $id: expect.any(String), userId: 'u1', roles: [] }])
    expect(db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'group.created',
        summary: 'Created the group',
        at: NOW.toISOString(),
        $permissions: TEAM,
      }),
    ])
  })

  it('takes the given currency, time zone, region, cycle and settings', async () => {
    const services = setUp()
    const settings = { type: 'house', autoFinalize: true, defaultBillSplit: 'equal' }
    const { group: created } = await ok<CreateGroupResult>(services, 'POST', '/groups', {
      ...HOUSE,
      currency: 'NZD',
      timezone: 'Pacific/Auckland',
      region: 'NZ',
      statementCycle: 'monthly',
      settings,
    })
    expect(created).toMatchObject({
      currency: 'NZD',
      timezone: 'Pacific/Auckland',
      region: 'NZ',
      statementCycle: 'monthly',
      // 06:00 on 1 November in Auckland (UTC+13).
      nextCloseAt: '2026-10-31T17:00:00.000Z',
      settingsJson: JSON.stringify(settings),
    })
  })

  it('creates an employer group: monthly by default, counterpart a viewer placeholder', async () => {
    const services = setUp()
    const result = await ok<CreateGroupResult>(services, 'POST', '/groups', EMPLOYER)
    const { db, teams } = services
    expect(result.group).toMatchObject({
      statementCycle: 'monthly',
      // October's statement: 06:00 on 1 November in Sydney.
      nextCloseAt: '2026-10-31T19:00:00.000Z',
      settingsJson: JSON.stringify({
        type: 'employer',
        defaultRateCents: 0,
        paymentTermsDays: 14,
        autoFinalize: false,
        recipients: [],
      }),
    })
    const boss = db.rows('persons').find((row) => row.$id !== 'p1')
    expect(boss).toMatchObject({ displayName: 'Boss', $permissions: [] })
    expect(boss?.userId ?? null).toBeNull()
    expect(db.rows('identities')).toEqual([
      expect.objectContaining({
        key: 'email:boss@example.com',
        personId: boss?.$id,
        verified: false,
        $permissions: [],
      }),
    ])
    expect(result.members).toEqual([
      expect.objectContaining({ personId: 'p1', role: 'admin', status: 'active' }),
      expect.objectContaining({
        groupId: 'g1',
        personId: boss?.$id,
        displayName: 'Boss',
        role: 'viewer',
        status: 'placeholder',
        joinedOn: TODAY,
        $permissions: TEAM,
      }),
    ])
    expect(teams.members('g1')?.map((membership) => membership.userId)).toEqual(['u1'])
    expect(
      db.rows('activity').map((row) => [row.action, row.summary, row.subjectPersonId]),
    ).toEqual([
      ['group.created', 'Created the group', undefined],
      ['member.added', 'was added as a viewer', boss?.$id],
    ])
  })

  it('creates a pair group with the counterpart as an admin placeholder', async () => {
    const services = setUp()
    const { members } = await ok<CreateGroupResult>(services, 'POST', '/groups', PAIR)
    expect(members[1]).toMatchObject({ displayName: 'Kim', role: 'admin', status: 'placeholder' })
    expect(services.teams.members('g1')).toHaveLength(1)
    expect(services.db.rows('activity')[1]).toMatchObject({
      action: 'member.added',
      subjectPersonId: members[1]?.personId,
      summary: 'was added as an admin',
    })
  })

  it('adds a registered counterpart as a placeholder, outside the team', async () => {
    const services = fakes({
      persons: [person(1), person(2)],
      profiles: [profile(1)],
      identities: [identity('i2', 'email:boss@example.com', 'p2')],
    })
    const { members } = await ok<CreateGroupResult>(services, 'POST', '/groups', EMPLOYER)
    expect(members[1]).toMatchObject({ personId: 'p2', role: 'viewer', status: 'placeholder' })
    expect(services.db.rows('persons')).toHaveLength(2)
    // The row is about the person found, not the creator (data-model.md#activity).
    expect(services.db.rows('activity').filter((row) => row.action === 'member.added')).toEqual([
      expect.objectContaining({ subjectPersonId: 'p2' }),
    ])
    expect(services.teams.members('g1')).toEqual([
      { $id: expect.any(String), userId: 'u1', roles: [] },
    ])
  })

  it('starts with the period that contains a future anchor', async () => {
    const services = setUp()
    const { group: created } = await ok<CreateGroupResult>(services, 'POST', '/groups', {
      ...HOUSE,
      statementCycle: 'weekly',
      cycleAnchor: '2026-11-02',
    })
    // The week 2–8 November closes at 06:00 on 9 November in Sydney.
    expect(created).toMatchObject({
      cycleAnchor: '2026-11-02',
      nextCloseAt: '2026-11-08T19:00:00.000Z',
    })
  })

  it('ignores a future anchor for a monthly cycle', async () => {
    const services = setUp()
    const { group: created } = await ok<CreateGroupResult>(services, 'POST', '/groups', {
      ...HOUSE,
      statementCycle: 'monthly',
      cycleAnchor: '2026-12-15',
    })
    // October's statement: 06:00 on 1 November in Sydney.
    expect(created).toMatchObject({ nextCloseAt: '2026-10-31T19:00:00.000Z' })
  })

  it('returns the stored group when repeated, creating nothing new', async () => {
    const services = setUp()
    const first = await ok<CreateGroupResult>(services, 'POST', '/groups', EMPLOYER)
    const tables = ['persons', 'identities', 'groups', 'members', 'activity']
    const before = tables.map((table) => services.db.rows(table))
    const second = await ok<CreateGroupResult>(services, 'POST', '/groups', EMPLOYER)
    expect(second).toEqual(first)
    expect(tables.map((table) => services.db.rows(table))).toEqual(before)
    expect(services.teams.members('g1')).toHaveLength(1)
  })

  it('returns the stored group for a repeat that spells out the defaults', async () => {
    const services = setUp()
    const first = await ok<CreateGroupResult>(services, 'POST', '/groups', HOUSE)
    const second = await ok<CreateGroupResult>(services, 'POST', '/groups', {
      ...HOUSE,
      currency: 'AUD',
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      statementCycle: 'none',
      settings: { type: 'house', autoFinalize: false, defaultBillSplit: 'days' },
    })
    expect(second).toEqual(first)
    // The counterpart isn't compared: resolving it again could find someone else.
    await ok(services, 'POST', '/groups', { ...EMPLOYER, id: 'g2' })
    const employer = { ...EMPLOYER, id: 'g2', counterpart: { displayName: 'Other' } }
    expect(await ok(services, 'POST', '/groups', employer)).toMatchObject({ group: { $id: 'g2' } })
  })

  it.each([
    ['another name', { name: 'Other' }],
    ['another currency', { currency: 'NZD' }],
    ['another time zone', { timezone: 'Pacific/Auckland' }],
    ['another region', { region: 'AU-VIC' }],
    ['another cycle', { statementCycle: 'monthly' }],
    ['an anchor', { cycleAnchor: '2026-11-02', statementCycle: 'weekly' }],
    [
      'other settings',
      { settings: { type: 'house', autoFinalize: true, defaultBillSplit: 'days' } },
    ],
  ])('refuses a repeat with %s', async (_, change) => {
    const services = setUp()
    await ok(services, 'POST', '/groups', HOUSE)
    expect(await failure(services, 'POST', '/groups', { ...HOUSE, ...change })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'That ID is taken.',
    })
    expect(services.db.rows('groups')[0]).toMatchObject({ name: 'Flat', currency: 'AUD' })
  })

  it('refuses a repeat after the creator left the group', async () => {
    const services = setUp()
    const { members } = await ok<CreateGroupResult>(services, 'POST', '/groups', HOUSE)
    await updateRow(services.db, 'members', members[0]?.$id ?? '', { status: 'left' })
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      code: 'CONFLICT',
      message: 'That ID is taken.',
    })
  })

  it("refuses an ID that is someone else's group", async () => {
    const services = fakes({
      persons: [person(1), person(2)],
      profiles: [profile(1)],
      groups: [group('g1', 'house', { ownerPersonId: 'p2' })],
      members: [member('m2', 'g1', 'p2', 'admin', 'active')],
    })
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
    expect(services.db.rows('members')).toHaveLength(1)
  })

  it('refuses a team that already has another member', async () => {
    const services = setUp({ g1: ['u2'] })
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'That ID is taken.',
    })
    expect(services.teams.members('g1')?.map((membership) => membership.userId)).toEqual(['u2'])
    expect(services.db.rows('groups')).toEqual([])
  })

  it('refuses a team where the caller is the owner', async () => {
    const services = setUp({ g1: [] })
    await services.teams.createMembership({ teamId: 'g1', userId: 'u1', roles: ['owner'] })
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({ code: 'CONFLICT' })
    expect(services.db.rows('groups')).toEqual([])
  })

  it('uses a team an earlier try left empty: teams.create answers 409, the caller joins it', async () => {
    const services = setUp({ g1: [] })
    const create = vi.spyOn(services.teams, 'create')
    await ok(services, 'POST', '/groups', HOUSE)
    await expect(create.mock.results[0]?.value).rejects.toMatchObject({ code: 409 })
    expect(services.teams.members('g1')).toEqual([
      { $id: expect.any(String), userId: 'u1', roles: [] },
    ])
    expect(services.db.rows('groups')).toHaveLength(1)
  })

  it('finishes when an earlier try left a team holding just the caller', async () => {
    const services = setUp({ g1: ['u1'] })
    await ok(services, 'POST', '/groups', HOUSE)
    expect(services.teams.members('g1')).toEqual([
      { $id: expect.any(String), userId: 'u1', roles: [] },
    ])
    expect(services.db.rows('groups')).toHaveLength(1)
  })

  it('answers CONFLICT when the same group is created at the same time', async () => {
    const services = setUp()
    const { $id, ...data } = group('g1', 'house')
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'create', tableId: 'groups', rowId: $id, data }),
      ),
    )
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
  })

  it('leaves the team when someone else joined it at the same time', async () => {
    const services = setUp()
    // Another user's create of g1 added them between this one's claim and its own add.
    const fakeTeams: FakeTeams = services.teams
    const add = fakeTeams.createMembership.bind(fakeTeams)
    vi.spyOn(services.teams, 'createMembership').mockImplementationOnce(async (params) => {
      await add({ teamId: 'g1', userId: 'u2', roles: [] })
      return add(params)
    })
    expect(await failure(services, 'POST', '/groups', HOUSE)).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'That ID is taken.',
    })
    expect(teamUsers(services)).toEqual(['u2'])
    expect(services.db.rows('groups')).toEqual([])
  })

  it("leaves the team when another user's group commits first", async () => {
    const services = setUp()
    beforeCommit(services.db, () =>
      createRow(services.db, 'groups', group('g1', 'house', { ownerPersonId: 'p2' })),
    )
    expect(await failure(services, 'POST', '/groups', HOUSE)).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'That ID is taken.',
    })
    expect(teamUsers(services)).toEqual([])
    expect(services.db.rows('groups')).toEqual([expect.objectContaining({ ownerPersonId: 'p2' })])
  })

  it('leaves the team when the transaction fails', async () => {
    const services = setUp()
    vi.spyOn(services.db, 'createOperations').mockRejectedValueOnce(new Error('Appwrite is down'))
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      status: 500,
      code: 'INTERNAL',
    })
    expect(teamUsers(services)).toEqual([])
    expect(services.db.rows('groups')).toEqual([])
  })

  it('tries leaving the team a second time when the first try fails', async () => {
    const services = setUp()
    vi.spyOn(services.db, 'createOperations').mockRejectedValueOnce(new Error('Appwrite is down'))
    vi.spyOn(services.teams, 'deleteMembership').mockRejectedValueOnce(new Error('Teams is down'))
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      status: 500,
      code: 'INTERNAL',
    })
    expect(teamUsers(services)).toEqual([])
  })

  it.each([
    ['an unknown region', { ...HOUSE, region: 'AU-NWS' }],
    ['a missing counterpart', { id: 'g1', type: 'pair', name: 'Us' }],
    ['a house counterpart', { ...HOUSE, counterpart: { displayName: 'Kim' } }],
    ['a personal group', { ...HOUSE, type: 'personal' }],
    ['a weekly cycle without an anchor', { ...HOUSE, statementCycle: 'weekly' }],
    ['settings of another type', { ...HOUSE, settings: { type: 'pair' } }],
    ['an invalid email', { ...PAIR, counterpart: { displayName: 'Kim', email: 'nope' } }],
    ['an invalid phone', { ...PAIR, counterpart: { displayName: 'Kim', phone: '12' } }],
  ])('refuses %s', async (_, body) => {
    const services = setUp()
    expect(await failure(services, 'POST', '/groups', body)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('groups')).toEqual([])
    expect(services.teams.teamIds()).toEqual([])
  })

  it('refuses the creator as their own counterpart', async () => {
    const services = fakes({
      persons: [person(1)],
      profiles: [profile(1)],
      identities: [identity('i1', 'email:boss@example.com', 'p1')],
    })
    expect(await failure(services, 'POST', '/groups', EMPLOYER)).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: "You can't be your own counterpart.",
    })
    expect(services.db.rows('groups')).toEqual([])
    expect(services.teams.teamIds()).toEqual([])
  })

  it('needs a set-up account', async () => {
    const services = fakes({ persons: [person(1)] })
    expect(await failure(services, 'POST', '/groups', HOUSE)).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    })
    expect(services.teams.teamIds()).toEqual([])
  })

  it('needs a logged-in user', async () => {
    const services = setUp()
    expect(await failure(services, 'POST', '/groups', HOUSE, null)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
  })
})
