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
        summary: "Alex's membership was changed",
        at: NOW.toISOString(),
      }),
    ])
    expect(changesOf(services)).toEqual([
      {
        before: { displayName: 'Member m2', joinedOn: '2026-09-01' },
        after: { displayName: 'Alex', joinedOn: '2026-08-15' },
      },
    ])
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

  it('keeps someone who never joined a placeholder, with the role given', async () => {
    const services = house()
    expect(await patch(services, 'm3', { leftOn: '2026-10-19' })).toMatchObject({
      status: 'placeholder',
      role: 'member',
      leftOn: '2026-10-19',
    })
    expect(await patch(services, 'm3', { role: 'viewer' })).toMatchObject({
      status: 'placeholder',
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
