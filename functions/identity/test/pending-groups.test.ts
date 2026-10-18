import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import type { PendingGroup } from '../src/routes/pending-groups'
import {
  BEFORE,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  ok,
  placeholderRow,
  updateRow,
} from './harness'

// Sam had an account before anyone added them, so claim never joins these rows (D-016).
const SAM = {
  $id: 'pSam',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: null,
  mergedInto: null,
  deletedAt: null,
}

function group(id: string, name: string, extra: object = {}) {
  return {
    $id: id,
    type: 'pair',
    name,
    ownerPersonId: 'pAdmin',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: 'none',
    cycleAnchor: null,
    nextCloseAt: null,
    settingsJson: '{}',
    archivedAt: null,
    ...extra,
  }
}

const GROUPS = [
  group('g1', 'Zed and Sam'),
  group('g2', 'Ann and Sam', { archivedAt: '2026-10-02T00:00:00.000Z' }),
  group('g3', 'Joined already'),
  group('g4', 'Someone else'),
]

function fixture(members: Array<ReturnType<typeof placeholderRow>> = defaultMembers()) {
  return fakes(
    { persons: [SAM], groups: GROUPS, members },
    { teams: { g1: ['uAdmin'], g2: ['uAdmin'], g3: ['uAdmin', 'u1'], g4: ['uAdmin'] } },
  )
}

function defaultMembers() {
  return [
    placeholderRow('m1', 'g1', 'pSam', BEFORE),
    placeholderRow('m2', 'g2', 'pSam', BEFORE),
    placeholderRow('m3', 'g3', 'pSam', BEFORE, { status: 'active' }),
    placeholderRow('m4', 'g4', 'pOther', BEFORE),
  ]
}

function teamUsers(services: Fakes, groupId: string) {
  return services.teams.members(groupId)?.map((membership) => membership.userId)
}

function memberRow(services: Fakes, id: string) {
  return services.db.rows('members').find((row) => row.$id === id)
}

type Joined = { group: { $id: string; archivedAt: string | null }; member: { status: string } }

describe('GET /groups/pending', () => {
  it("lists the caller's placeholder groups, archived ones included, and nothing else", async () => {
    const services = fixture()
    const { groups } = await ok<{ groups: PendingGroup[] }>(services, 'GET', '/groups/pending')
    expect(groups).toEqual([
      { id: 'g2', type: 'pair', name: 'Ann and Sam', archivedAt: '2026-10-02T00:00:00.000Z' },
      { id: 'g1', type: 'pair', name: 'Zed and Sam', archivedAt: null },
    ])
  })

  it('pages through more than one page of placeholder rows', async () => {
    const services = fakes({
      persons: [SAM],
      groups: Array.from({ length: 101 }, (_, i) =>
        group(`g${i}`, `G${String(i).padStart(3, '0')}`),
      ),
      members: Array.from({ length: 101 }, (_, i) =>
        placeholderRow(`m${i}`, `g${i}`, 'pSam', BEFORE),
      ),
    })
    const { groups } = await ok<{ groups: PendingGroup[] }>(services, 'GET', '/groups/pending')
    expect(groups).toHaveLength(101)
    expect(groups.at(-1)?.id).toBe('g100')
  })

  it('is NOT_FOUND before bootstrap, and UNAUTHENTICATED without a JWT', async () => {
    const services = fixture()
    expect((await failure(services, 'GET', '/groups/pending', undefined, 'u2')).code).toBe(
      'NOT_FOUND',
    )
    expect((await failure(services, 'GET', '/groups/pending', undefined, null)).code).toBe(
      'UNAUTHENTICATED',
    )
  })
})

describe('POST /groups/{id}/join', () => {
  it('adds the team, then makes the member active with one member.joined row', async () => {
    const services = fixture()
    const joined = await ok<Joined>(services, 'POST', '/groups/g1/join')
    expect(joined.group.$id).toBe('g1')
    expect(joined.member).toMatchObject({ status: 'active' })
    expect(memberRow(services, 'm1')?.status).toBe('active')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'pSam',
        action: 'member.joined',
        $permissions: ['read("team:g1")'],
      }),
    ])
    // Not pending any more.
    const { groups } = await ok<{ groups: PendingGroup[] }>(services, 'GET', '/groups/pending')
    expect(groups.map((g) => g.id)).toEqual(['g2'])
  })

  it('joins an archived group', async () => {
    const services = fixture()
    const joined = await ok<Joined>(services, 'POST', '/groups/g2/join')
    expect(joined.group.archivedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(memberRow(services, 'm2')?.status).toBe('active')
    expect(teamUsers(services, 'g2')).toEqual(['uAdmin', 'u1'])
  })

  it('sets left, not active, for someone who moved out before joining', async () => {
    const services = fixture([placeholderRow('m1', 'g1', 'pSam', BEFORE, { leftOn: '2026-09-30' })])
    expect((await ok<Joined>(services, 'POST', '/groups/g1/join')).member.status).toBe('left')
  })

  it('finishes a join interrupted after the team add', async () => {
    const services = fixture()
    // An earlier call added the team membership, then failed before the row write.
    await services.teams.createMembership({ teamId: 'g1', roles: [], userId: 'u1' })
    expect((await ok<Joined>(services, 'POST', '/groups/g1/join')).member.status).toBe('active')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('returns an active or left row unchanged, without touching the team', async () => {
    const services = fixture([
      ...defaultMembers(),
      placeholderRow('m5', 'g4', 'pSam', BEFORE, { status: 'left', leftOn: '2026-09-30' }),
    ])
    const add = vi.spyOn(services.teams, 'createMembership')
    expect((await ok<Joined>(services, 'POST', '/groups/g3/join')).member.status).toBe('active')
    // g4's team doesn't hold Sam, and a retry leaves it that way.
    expect((await ok<Joined>(services, 'POST', '/groups/g4/join')).member.status).toBe('left')
    expect(add).not.toHaveBeenCalled()
    expect(teamUsers(services, 'g4')).toEqual(['uAdmin'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('is safe to send twice', async () => {
    const services = fixture()
    await ok(services, 'POST', '/groups/g1/join')
    expect((await ok<Joined>(services, 'POST', '/groups/g1/join')).member.status).toBe('active')
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it.each([
    ['a group with only someone else as placeholder', 'g4'],
    ['a group that does not exist', 'gMissing'],
  ])('is NOT_A_MEMBER for %s, before reading the group', async (_, groupId) => {
    const services = fixture()
    const getRow = vi.spyOn(services.db, 'getRow')
    const add = vi.spyOn(services.teams, 'createMembership')
    const result = await failure(services, 'POST', `/groups/${groupId}/join`)
    expect(result).toMatchObject({ status: 403, code: 'NOT_A_MEMBER' })
    expect(getRow).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(services.db.rows('activity')).toEqual([])
  })

  it('is NOT_A_MEMBER before bootstrap', async () => {
    expect((await failure(fixture(), 'POST', '/groups/g1/join', undefined, 'u2')).code).toBe(
      'NOT_A_MEMBER',
    )
  })

  it('takes back the team membership when an admin removed the row meanwhile', async () => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'members', rowId: 'm1' }),
        ),
    )
    expect((await failure(services, 'POST', '/groups/g1/join')).code).toBe('NOT_A_MEMBER')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('returns the row joined by a claim running at the same time', async () => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () => updateRow(services.db, 'members', 'm1', { status: 'active' }),
    )
    expect((await ok<Joined>(services, 'POST', '/groups/g1/join')).member.status).toBe('active')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
  })

  it('is VALIDATION_FAILED with a body, and logs IDs only', async () => {
    const services = fixture()
    expect((await failure(services, 'POST', '/groups/g1/join', { x: 1 })).code).toBe(
      'VALIDATION_FAILED',
    )
    const { logs } = await call(services, 'POST', '/groups/g1/join')
    expect(logs.join('\n')).not.toMatch(/Sam|Sammy|Zed|example\.com/)
  })
})
