import type { Members } from '@ledgerly/core/generated/rows'
import { describe, expect, it, vi } from 'vitest'
import {
  beforeCommit,
  beforeStaging,
  type Fakes,
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

/** House g1: m1 u1 admin, m2 u2 member, m3 a placeholder. m9 is in another group. */
function house(members: ReturnType<typeof member>[] = []) {
  return fakes(
    {
      groups: [group('g1', 'house'), group('g2', 'house')],
      persons: [person(1), person(2), person(9), placeholder('pX')],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active'),
        member('m3', 'g1', 'pX', 'member', 'placeholder'),
        member('m9', 'g2', 'p9', 'admin', 'active'),
        ...members,
      ],
    },
    { g1: ['u1', 'u2'], g2: ['u9'] },
  )
}

function patch(services: Fakes, memberId: string, body: object, userId = 'u1') {
  return ok<Members>(services, 'PATCH', `/groups/g1/members/${memberId}`, body, userId)
}

function patchFails(services: Fakes, memberId: string, body: object, userId = 'u1') {
  return failure(services, 'PATCH', `/groups/g1/members/${memberId}`, body, userId)
}

function changesOf(services: Fakes) {
  return services.db.rows('activity').map((row) => JSON.parse(String(row.changesJson)))
}

/** Who each activity row is about, and what it says about them. */
function summariesOf(services: Fakes) {
  return services.db.rows('activity').map((row) => [row.subjectPersonId, row.summary])
}

describe('PATCH /groups/{id}/members/{memberId}', () => {
  it('changes the fields given, and records only what changed', async () => {
    const services = house()
    const row = await patch(services, 'm2', {
      displayName: 'Alex',
      role: 'member',
      joinedOn: '2026-08-15',
    })
    expect(row).toMatchObject({
      $id: 'm2',
      displayName: 'Alex',
      role: 'member',
      status: 'active',
      joinedOn: '2026-08-15',
      leftOn: null,
    })
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'member.updated',
        subjectPersonId: 'p2',
        summary: 'was renamed and moved in on 2026-08-15',
        at: NOW.toISOString(),
      }),
    ])
    // Never the name, old or new: the summary says they were renamed.
    expect(changesOf(services)).toEqual([
      { before: { joinedOn: '2026-09-01' }, after: { joinedOn: '2026-08-15' } },
    ])
  })

  it.each([
    [{ displayName: 'Alex' }, 'was renamed'],
    [{ role: 'admin' }, 'was made an admin'],
    [{ joinedOn: '2026-08-15' }, 'moved in on 2026-08-15'],
    // Moving out makes them a viewer, which the summary doesn't repeat.
    [{ leftOn: '2026-10-19' }, 'moved out on 2026-10-19'],
    [
      { displayName: 'Alex', joinedOn: '2026-08-15', role: 'viewer' },
      'was renamed, moved in on 2026-08-15 and was made a viewer',
    ],
  ])('says what %j changed, about their person, with no name', async (body, summary) => {
    const services = house()
    await patch(services, 'm2', body)
    expect(summariesOf(services)).toEqual([['p2', summary]])
  })

  it('writes nothing when nothing changes', async () => {
    const services = house()
    const update = vi.spyOn(services.db, 'createOperations')
    const row = await patch(services, 'm2', { role: 'member', joinedOn: '2026-09-01' })
    expect(row).toMatchObject({ $id: 'm2', role: 'member' })
    expect(update).not.toHaveBeenCalled()
    expect(services.db.rows('activity')).toEqual([])
  })

  it('moves a joined member out: left, viewer, still in the team', async () => {
    const services = house()
    const row = await patch(services, 'm2', { leftOn: '2026-10-19' })
    expect(row).toMatchObject({ status: 'left', role: 'viewer', leftOn: '2026-10-19' })
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
    expect(changesOf(services)).toEqual([
      {
        before: { role: 'member', status: 'active', leftOn: null },
        after: { role: 'viewer', status: 'left', leftOn: '2026-10-19' },
      },
    ])
  })

  it('moves out someone who never joined: still a placeholder, now a viewer', async () => {
    const services = house()
    expect(await patch(services, 'm3', { leftOn: '2026-10-19' })).toMatchObject({
      status: 'placeholder',
      role: 'viewer',
      leftOn: '2026-10-19',
    })
    expect(await patchFails(services, 'm3', { role: 'member' })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'A member who left can only be a viewer.',
    })
  })

  it('moves out an admin placeholder as a viewer, with no joined-admin check', async () => {
    // m1 is the only joined admin; a placeholder admin moving out takes no joined admin away.
    const services = house([member('m6', 'g1', 'p9', 'admin', 'placeholder')])
    expect(await patch(services, 'm6', { leftOn: '2026-10-19' })).toMatchObject({
      status: 'placeholder',
      role: 'viewer',
      leftOn: '2026-10-19',
    })
    expect(changesOf(services)).toEqual([
      { before: { role: 'admin', leftOn: null }, after: { role: 'viewer', leftOn: '2026-10-19' } },
    ])
    expect(summariesOf(services)).toEqual([['p9', 'moved out on 2026-10-19']])
  })

  it('refuses any role but viewer when moving someone out', async () => {
    const services = house([member('m6', 'g1', 'p9', 'admin', 'placeholder')])
    for (const [memberId, role] of [
      ['m2', 'member'],
      ['m6', 'admin'],
    ] as const) {
      expect(await patchFails(services, memberId, { leftOn: '2026-10-19', role })).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'A member who left can only be a viewer.',
      })
    }
    expect(await patch(services, 'm6', { leftOn: '2026-10-19', role: 'viewer' })).toMatchObject({
      role: 'viewer',
    })
  })

  it('checks the date order against the stored dates too', async () => {
    const services = house([
      member('m5', 'g1', 'p9', 'viewer', 'left', { joinedOn: '2026-09-01', leftOn: '2026-09-30' }),
    ])
    for (const [memberId, body] of [
      ['m2', { leftOn: '2026-08-31' }],
      ['m5', { joinedOn: '2026-10-01' }],
      ['m2', { joinedOn: '2026-10-02', leftOn: '2026-10-01' }],
    ] as const) {
      expect(await patchFails(services, memberId, body)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      })
    }
    // The same day is fine.
    expect(await patch(services, 'm2', { leftOn: '2026-09-01' })).toMatchObject({
      leftOn: '2026-09-01',
    })
  })

  it('refuses to demote or move out the last joined admin', async () => {
    const services = house([member('m6', 'g1', 'p9', 'admin', 'placeholder')])
    for (const body of [{ role: 'member' }, { leftOn: '2026-10-19' }]) {
      expect(await patchFails(services, 'm1', body)).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'The group needs at least one admin who has joined.',
      })
    }
    expect(services.db.rows('members')[0]).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('demotes an admin while another joined admin remains', async () => {
    const services = house()
    await patch(services, 'm2', { role: 'admin' })
    expect(await patch(services, 'm1', { role: 'viewer' })).toMatchObject({ role: 'viewer' })
  })

  it('keeps someone who left a viewer', async () => {
    const services = house([member('m5', 'g1', 'p9', 'viewer', 'left', { leftOn: '2026-09-30' })])
    for (const role of ['member', 'admin']) {
      expect(await patchFails(services, 'm5', { role })).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'A member who left can only be a viewer.',
      })
    }
    expect(await patch(services, 'm5', { role: 'viewer', displayName: 'Sam' })).toMatchObject({
      role: 'viewer',
      displayName: 'Sam',
    })
  })

  it.each([
    ['demoted', { role: 'member' }],
    ['moved out', { status: 'left', role: 'viewer' }],
  ])('answers CONFLICT when the other admin is %s before it is staged', async (_, change) => {
    const services = house()
    await patch(services, 'm2', { role: 'admin' })
    // Staging 1 is the target's row, 2 the other admin's.
    beforeStaging(services.db, 2, () => updateRow(services.db, 'members', 'm2', change))
    expect(await patchFails(services, 'm1', { role: 'member' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('members')[0]).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('answers CONFLICT when the other admin is demoted before the commit', async () => {
    const services = house()
    await patch(services, 'm2', { role: 'admin' })
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm2', { role: 'member' }))
    expect(await patchFails(services, 'm1', { leftOn: '2026-10-19' })).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('members')[0]).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('refuses anyone but an admin', async () => {
    expect(await patchFails(house(), 'm3', { displayName: 'Sam' }, 'u2')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it("answers NOT_FOUND for another group's member", async () => {
    expect(await patchFails(house(), 'm9', { displayName: 'Sam' })).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    })
  })

  it('answers CONFLICT when the row changes before it is staged', async () => {
    const services = house()
    const stage = services.db.createOperations.bind(services.db)
    vi.spyOn(services.db, 'createOperations').mockImplementationOnce(async (params) => {
      await updateRow(services.db, 'members', 'm3', { status: 'active' })
      return stage(params)
    })
    expect(await patchFails(services, 'm3', { displayName: 'Sam' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('members')[2]).toMatchObject({ displayName: 'Member m3' })
  })

  it.each([
    ['joinedOn', { joinedOn: '2026-10-05' }, { leftOn: '2026-10-01' }],
    ['leftOn', { leftOn: '2026-10-10' }, { displayName: 'Sam' }],
  ])('answers CONFLICT when %s changes before it is staged', async (_, change, body) => {
    const services = house()
    beforeStaging(services.db, 1, () => updateRow(services.db, 'members', 'm2', change))
    expect(await patchFails(services, 'm2', body)).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('members')[1]).toMatchObject({ ...change, displayName: 'Member m2' })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('answers CONFLICT when the row changes after it is staged', async () => {
    const services = house()
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm2', { role: 'admin' }))
    expect(await patchFails(services, 'm2', { leftOn: '2026-10-19' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('activity')).toEqual([])
  })
})

const MEMBER_CREATED = '2026-09-01T00:00:00.000Z'

/** Their own member.left or member.joined row in g1, at `at`. */
function own(action: 'member.left' | 'member.joined', at: string, personId = 'p4') {
  return {
    $id: `a-${action}-${at}`,
    $createdAt: at,
    at,
    groupId: 'g1',
    actorPersonId: personId,
    action,
    transactionId: null,
    summary: 'Member m4',
    changesJson: null,
  }
}

/** House g1: m1 u1 admin; m4 u4 moved out on 10-10, still in the team; m3 a placeholder who moved out. */
function movedOut({ team = ['u1', 'u4'], activity = [] as ReturnType<typeof own>[] } = {}) {
  return fakes(
    {
      groups: [group('g1', 'house')],
      persons: [person(1), person(4), placeholder('pX')],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m4', 'g1', 'p4', 'viewer', 'left', {
          leftOn: '2026-10-10',
          $createdAt: MEMBER_CREATED,
        }),
        member('m3', 'g1', 'pX', 'viewer', 'placeholder', { leftOn: '2026-10-10' }),
      ],
      activity,
    },
    { g1: team },
  )
}

const LEFT_ON_THEIR_OWN = {
  status: 400,
  code: 'VALIDATION_FAILED',
  message: "They left this group on their own, so they can't be moved back in.",
}

describe('PATCH /groups/{id}/members/{memberId} with leftOn: null (moving back in)', () => {
  it('makes someone who moved out active again, still a viewer, with one activity row', async () => {
    const services = movedOut()
    expect(await patch(services, 'm4', { leftOn: null })).toMatchObject({
      status: 'active',
      role: 'viewer',
      leftOn: null,
    })
    expect(changesOf(services)).toEqual([
      {
        before: { status: 'left', leftOn: '2026-10-10' },
        after: { status: 'active', leftOn: null },
      },
    ])
    expect(summariesOf(services)).toEqual([['p4', 'moved back in']])
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u4'])
  })

  it('takes a role in the same request', async () => {
    const services = movedOut()
    expect(await patch(services, 'm4', { leftOn: null, role: 'member' })).toMatchObject({
      status: 'active',
      role: 'member',
    })
    expect(summariesOf(services)).toEqual([['p4', 'moved back in and was made a member']])
  })

  it('counts a member.joined after an earlier member.left as a fresh membership', async () => {
    const services = movedOut({
      activity: [
        own('member.left', '2026-09-10T00:00:00.000Z'),
        own('member.joined', '2026-09-20T00:00:00.000Z'),
      ],
    })
    expect(await patch(services, 'm4', { leftOn: null })).toMatchObject({ status: 'active' })
  })

  it.each([
    [
      'out of the team after their own leave',
      ['u1'],
      [own('member.left', '2026-10-12T00:00:00.000Z')],
    ],
    ['out of the team with no member.left row', ['u1'], []],
    [
      'still in the team, their own leave cut off before the team step',
      ['u1', 'u4'],
      [own('member.left', '2026-10-12T00:00:00.000Z')],
    ],
  ])('refuses someone %s, and writes nothing', async (_, team, activity) => {
    const services = movedOut({ team, activity })
    expect(await patchFails(services, 'm4', { leftOn: null })).toEqual(LEFT_ON_THEIR_OWN)
    expect(services.db.rows('members')[1]).toMatchObject({ status: 'left', leftOn: '2026-10-10' })
    expect(services.db.rows('activity')).toHaveLength(activity.length)
  })

  it('refuses a person with no account', async () => {
    const services = movedOut()
    await updateRow(services.db, 'persons', 'p4', { userId: null })
    expect(await patchFails(services, 'm4', { leftOn: null })).toEqual(LEFT_ON_THEIR_OWN)
  })

  it("clears a placeholder's leftOn and keeps it a placeholder", async () => {
    const services = movedOut()
    expect(await patch(services, 'm3', { leftOn: null })).toMatchObject({
      status: 'placeholder',
      role: 'viewer',
      leftOn: null,
    })
    expect(changesOf(services)).toEqual([
      { before: { leftOn: '2026-10-10' }, after: { leftOn: null } },
    ])
  })

  it('changes nothing for someone with no leftOn, so a retry is safe', async () => {
    const services = house()
    expect(await patch(services, 'm2', { leftOn: null })).toMatchObject({
      status: 'active',
      leftOn: null,
    })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('refuses anyone but an admin, and answers NOT_A_MEMBER to an outsider', async () => {
    const services = movedOut()
    expect(await patchFails(services, 'm4', { leftOn: null }, 'u4')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(await patchFails(services, 'm4', { leftOn: null }, 'u9')).toMatchObject({
      code: 'NOT_A_MEMBER',
    })
  })

  it.each([
    [
      'before it is staged',
      (services: Fakes, leave: () => Promise<unknown>) => beforeStaging(services.db, 1, leave),
    ],
    [
      'after it is staged',
      (services: Fakes, leave: () => Promise<unknown>) => beforeCommit(services.db, leave),
    ],
  ])('answers CONFLICT when they leave on their own %s, then refuses', async (_, when) => {
    const services = movedOut()
    when(services, () => ok(services, 'POST', '/groups/g1/leave', undefined, 'u4'))
    expect(await patchFails(services, 'm4', { leftOn: null })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('members')[1]).toMatchObject({ status: 'left', leftOn: '2026-10-10' })
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1'])
    vi.restoreAllMocks()
    expect(await patchFails(services, 'm4', { leftOn: null })).toEqual(LEFT_ON_THEIR_OWN)
  })
})
