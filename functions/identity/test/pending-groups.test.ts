import type { PendingGroupsResult } from '@ledgerly/core/schemas/identity'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import {
  AFTER,
  BEFORE,
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  ok,
  placeholderRow,
  TRY_AGAIN,
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

// A pair group's name is its creator's label for the other person: here, for Sam.
const GROUPS = [
  group('g1', 'Sam'),
  group('g2', 'Sammy', { archivedAt: '2026-10-02T00:00:00.000Z' }),
  group('g3', 'Joined already'),
  group('g4', 'Someone else'),
  group('g5', 'Flat 2', { type: 'house' }),
  group('g6', 'Zed Cafe', { type: 'employer' }),
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
    placeholderRow('m5', 'g5', 'pSam', BEFORE),
    // The creators, already joined.
    placeholderRow('a1', 'g1', 'pZed', BEFORE, { displayName: 'Zed Park', status: 'active' }),
    placeholderRow('a2', 'g2', 'pAnn', BEFORE, { displayName: 'Ann Cho', status: 'active' }),
    placeholderRow('a5', 'g5', 'pAnn', BEFORE, { displayName: 'Ann Cho', status: 'active' }),
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
    const { groups } = await ok<PendingGroupsResult>(services, 'GET', '/groups/pending')
    expect(groups).toEqual([
      {
        id: 'g2',
        type: 'pair',
        name: 'Sammy',
        counterpartName: 'Ann Cho',
        archivedAt: '2026-10-02T00:00:00.000Z',
      },
      // A house keeps its own name, with no member named.
      { id: 'g5', type: 'house', name: 'Flat 2', archivedAt: null },
      { id: 'g1', type: 'pair', name: 'Sam', counterpartName: 'Zed Park', archivedAt: null },
    ])
  })

  it('names a pair group by the other member, never the caller’s own row', async () => {
    // Sam's own row comes last in the table, so it would win if it were read.
    const services = fixture([
      placeholderRow('a1', 'g1', 'pZed', BEFORE, { displayName: 'Zed Park', status: 'active' }),
      placeholderRow('m1', 'g1', 'pSam', BEFORE, { displayName: 'Sam' }),
    ])
    const { groups } = await ok<PendingGroupsResult>(services, 'GET', '/groups/pending')
    expect(groups).toEqual([
      { id: 'g1', type: 'pair', name: 'Sam', counterpartName: 'Zed Park', archivedAt: null },
    ])
  })

  it('pages through more than one page of placeholder rows, and of their other members', async () => {
    const services = fakes({
      persons: [SAM],
      groups: Array.from({ length: 101 }, (_, i) =>
        group(`g${i}`, `G${String(i).padStart(3, '0')}`),
      ),
      members: [
        ...Array.from({ length: 101 }, (_, i) => placeholderRow(`m${i}`, `g${i}`, 'pSam', BEFORE)),
        // Each pair's creator, so every group needs its other member's name.
        ...Array.from({ length: 101 }, (_, i) =>
          placeholderRow(`a${i}`, `g${i}`, `pC${i}`, BEFORE, {
            displayName: `C${String(i).padStart(3, '0')}`,
            status: 'active',
          }),
        ),
      ],
    })
    const { groups } = await ok<PendingGroupsResult>(services, 'GET', '/groups/pending')
    expect(groups).toHaveLength(101)
    // Every one named, past the first batch of 100 and past the default page size.
    expect(groups.every((g) => g.counterpartName === `C${g.name.slice(1)}`)).toBe(true)
    expect(groups.at(-1)).toMatchObject({ id: 'g100', counterpartName: 'C100' })
  })

  it('names no member for an employer group either', async () => {
    const services = fixture([
      placeholderRow('m6', 'g6', 'pSam', BEFORE),
      placeholderRow('a6', 'g6', 'pZed', BEFORE, { displayName: 'Zed Park', status: 'active' }),
    ])
    const { groups } = await ok<PendingGroupsResult>(services, 'GET', '/groups/pending')
    expect(groups).toEqual([{ id: 'g6', type: 'employer', name: 'Zed Cafe', archivedAt: null }])
  })

  it('is NOT_FOUND for a deleted account, whose person is never resolved from its userId', async () => {
    const services = fakes({
      persons: [{ ...SAM, deletedAt: BEFORE }],
      groups: GROUPS,
      members: defaultMembers(),
    })
    expect((await failure(services, 'GET', '/groups/pending')).code).toBe('NOT_FOUND')
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
        subjectPersonId: 'pSam',
        summary: 'joined',
        $permissions: ['read("team:g1")'],
      }),
    ])
    // Not pending any more.
    const { groups } = await ok<PendingGroupsResult>(services, 'GET', '/groups/pending')
    expect(groups.map((g) => g.id)).toEqual(['g2', 'g5'])
  })

  it('names no one in its member.joined row: no member, person or group name', async () => {
    const services = fakes(
      {
        persons: [SAM],
        groups: [group('g1', 'Vexwood Pairname')],
        members: [
          placeholderRow('m1', 'g1', 'pSam', BEFORE, { displayName: 'Quorra Membername' }),
          placeholderRow('a1', 'g1', 'pZed', BEFORE, {
            displayName: 'Zeffo Creatorname',
            status: 'active',
          }),
        ],
      },
      { teams: { g1: ['uAdmin'] } },
    )
    await ok<Joined>(services, 'POST', '/groups/g1/join')
    const names = [
      ...services.db.rows('persons').map((row) => row.displayName),
      ...services.db.rows('members').map((row) => row.displayName),
      ...services.db.rows('groups').map((row) => row.name),
    ]
    const rows = services.db.rows('activity')
    expect(rows).toHaveLength(1)
    for (const row of rows) {
      for (const name of names) {
        expect(`${row.summary} ${row.changesJson ?? ''}`).not.toContain(String(name))
      }
    }
  })

  it('joins an archived group', async () => {
    const services = fixture()
    const joined = await ok<Joined>(services, 'POST', '/groups/g2/join')
    expect(joined.group.archivedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(memberRow(services, 'm2')?.status).toBe('active')
    expect(teamUsers(services, 'g2')).toEqual(['uAdmin', 'u1'])
  })

  it('sets left, not active, for someone who moved out before joining', async () => {
    const services = fixture([
      placeholderRow('m1', 'g1', 'pSam', BEFORE, { role: 'viewer', leftOn: '2026-09-30' }),
    ])
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

  it('returns an active row, or a moved-out one still in the team, unchanged without a team call', async () => {
    const services = fixture([
      ...defaultMembers(),
      // Moved out after joining: `left`, still in g4's team.
      placeholderRow('m5', 'g4', 'pSam', BEFORE, {
        status: 'left',
        role: 'viewer',
        leftOn: '2026-09-30',
      }),
    ])
    await services.teams.createMembership({ teamId: 'g4', roles: [], userId: 'u1' })
    const add = vi.spyOn(services.teams, 'createMembership')
    expect((await ok<Joined>(services, 'POST', '/groups/g3/join')).member.status).toBe('active')
    const movedOut = await ok<Joined>(services, 'POST', '/groups/g4/join')
    expect(movedOut).toMatchObject({ group: { $id: 'g4' }, member: { status: 'left' } })
    expect(add).not.toHaveBeenCalled()
    expect(services.db.rows('activity')).toEqual([])
  })

  it('is NOT_A_MEMBER for someone who left on their own, and changes nothing', async () => {
    // Left voluntarily: `left`, `viewer`, and no longer in g4's team.
    const services = fixture([
      placeholderRow('m5', 'g4', 'pSam', BEFORE, {
        status: 'left',
        role: 'viewer',
        leftOn: '2026-09-30',
      }),
    ])
    const add = vi.spyOn(services.teams, 'createMembership')
    expect(await failure(services, 'POST', '/groups/g4/join')).toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    })
    expect(add).not.toHaveBeenCalled()
    expect(teamUsers(services, 'g4')).toEqual(['uAdmin'])
    expect(memberRow(services, 'm5')?.status).toBe('left')
  })

  it('is NOT_A_MEMBER for a group whose team is gone, a group being purged (#322)', async () => {
    // g5 has no team: an account deletion is purging it, its rows last.
    const services = fixture([placeholderRow('m6', 'g5', 'pSam', BEFORE)])
    expect(await failure(services, 'POST', '/groups/g5/join')).toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    })
    expect(memberRow(services, 'm6')?.status).toBe('placeholder')
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

  it("is NOT_A_MEMBER for a deleted account, and doesn't touch the team or the row", async () => {
    const services = fakes(
      { persons: [{ ...SAM, deletedAt: BEFORE }], groups: GROUPS, members: defaultMembers() },
      { teams: { g1: ['uAdmin'] } },
    )
    expect((await failure(services, 'POST', '/groups/g1/join')).code).toBe('NOT_A_MEMBER')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(memberRow(services, 'm1')?.status).toBe('placeholder')
  })

  it('is NOT_A_MEMBER when the deletion passes its point of no return after the lookup', async () => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () => updateRow(services.db, 'persons', 'pSam', { deletedAt: AFTER }),
    )
    // As for a deleted person found at the lookup.
    expect(await failure(services, 'POST', '/groups/g1/join')).toEqual({
      status: 403,
      code: 'NOT_A_MEMBER',
      message: "You're not a member of this group.",
    })
    expect(memberRow(services, 'm1')?.status).toBe('placeholder')
    // The team membership from step 1 is taken back.
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('says CONFLICT when the deletion passes it after the join is staged, and a retry is NOT_A_MEMBER', async () => {
    const services = fixture()
    beforeCommit(services.db, () => updateRow(services.db, 'persons', 'pSam', { deletedAt: AFTER }))
    expect(await failure(services, 'POST', '/groups/g1/join')).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(memberRow(services, 'm1')?.status).toBe('placeholder')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(services.db.rows('activity')).toEqual([])
    expect((await failure(services, 'POST', '/groups/g1/join')).code).toBe('NOT_A_MEMBER')
  })

  it('is NOT_A_MEMBER once deleted, even when a claim joined the row first', async () => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      async () => {
        await updateRow(services.db, 'members', 'm1', { status: 'active' })
        await updateRow(services.db, 'persons', 'pSam', { deletedAt: AFTER })
      },
    )
    expect((await failure(services, 'POST', '/groups/g1/join')).code).toBe('NOT_A_MEMBER')
    // Joined by the claim, so the membership stays, for the deletion to take back.
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
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

  it('is NOT_A_MEMBER without joining when the group row is missing', async () => {
    const services = fixture([placeholderRow('m9', 'gGone', 'pSam', BEFORE)])
    const add = vi.spyOn(services.teams, 'createMembership')
    expect((await failure(services, 'POST', '/groups/gGone/join')).code).toBe('NOT_A_MEMBER')
    expect(add).not.toHaveBeenCalled()
    expect(memberRow(services, 'm9')?.status).toBe('placeholder')
    expect(services.db.rows('activity')).toEqual([])
  })

  it('takes back the team membership when the row moved to another person meanwhile', async () => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () => updateRow(services.db, 'members', 'm1', { personId: 'pElse' }),
    )
    expect((await failure(services, 'POST', '/groups/g1/join')).code).toBe('NOT_A_MEMBER')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('uses the stored leftOn when it changed during the join', async () => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () => updateRow(services.db, 'members', 'm1', { leftOn: '2026-10-05' }),
    )
    expect((await ok<Joined>(services, 'POST', '/groups/g1/join')).member.status).toBe('left')
  })

  it('says CONFLICT, try again, when the row changes after its join is staged, and a retry joins', async () => {
    const services = fixture()
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm1', { displayName: 'S' }))
    expect(await failure(services, 'POST', '/groups/g1/join')).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // Not joined, so the team membership from step 1 is taken back.
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(memberRow(services, 'm1')?.status).toBe('placeholder')
    expect((await ok<Joined>(services, 'POST', '/groups/g1/join')).member.status).toBe('active')
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('takes back the team membership when the join fails for another reason', async () => {
    const services = fixture()
    vi.spyOn(services.db, 'updateTransaction').mockRejectedValueOnce(new Error('network down'))
    expect((await failure(services, 'POST', '/groups/g1/join')).code).toBe('INTERNAL')
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(memberRow(services, 'm1')?.status).toBe('placeholder')
  })

  it("is NOT_A_MEMBER when the row is deleted before the commit (Appwrite's 404)", async () => {
    const services = fixture()
    const commit = services.db.updateTransaction.bind(services.db)
    let done = false
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (done || !params.commit) return commit(params)
      done = true
      await withTransaction(services.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'members', rowId: 'm1' }),
      )
      // What Appwrite answers when a staged row was deleted meanwhile (checked on dev, #105).
      throw new AppwriteException('Row not found', 404, 'row_not_found')
    })
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
