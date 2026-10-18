import { describe, expect, it, vi } from 'vitest'
import {
  beforeCommit,
  beforeStaging,
  createRow,
  type Fakes,
  failure,
  fakes,
  group,
  member,
  NOW,
  ok,
  person,
  placeholder,
  share,
  TRY_AGAIN,
  updateRow,
} from './harness'

/** House g1: m1 u1 admin, m2 u2 member, m3 a placeholder. m9 is in another group. */
function house(extra: { members?: ReturnType<typeof member>[]; shares?: object[] } = {}) {
  return fakes(
    {
      groups: [group('g1', 'house'), group('g2', 'house')],
      persons: [person(1), person(2), person(9), placeholder('pX')],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active'),
        member('m3', 'g1', 'pX', 'member', 'placeholder'),
        member('m9', 'g2', 'p9', 'admin', 'active'),
        ...(extra.members ?? []),
      ],
      shares: (extra.shares ?? []) as ReturnType<typeof share>[],
    },
    { g1: ['u1', 'u2'], g2: ['u9'] },
  )
}

function remove(services: Fakes, memberId: string, userId = 'u1') {
  return ok(services, 'DELETE', `/groups/g1/members/${memberId}`, undefined, userId)
}

function removeFails(services: Fakes, memberId: string, userId = 'u1', body?: object) {
  return failure(services, 'DELETE', `/groups/g1/members/${memberId}`, body, userId)
}

function teamUsers(services: Fakes) {
  return services.teams.members('g1')?.map((membership) => membership.userId)
}

function memberIds(services: Fakes) {
  return services.db.rows('members').map((row) => row.$id)
}

describe('DELETE /groups/{id}/members/{memberId}', () => {
  it('removes the row and the team membership, and writes member.removed', async () => {
    const services = house()
    expect(await remove(services, 'm2')).toEqual({})
    expect(memberIds(services)).toEqual(['m1', 'm3', 'm9'])
    expect(teamUsers(services)).toEqual(['u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'member.removed',
        summary: 'Member m2 was removed',
        at: NOW.toISOString(),
        $permissions: ['read("team:g1")'],
      }),
    ])
  })

  it('never calls Teams for a placeholder, with or without an account', async () => {
    const services = house({ members: [member('m4', 'g1', 'p9', 'member', 'placeholder')] })
    const list = vi.spyOn(services.teams, 'listMemberships')
    const add = vi.spyOn(services.teams, 'createMembership')
    const drop = vi.spyOn(services.teams, 'deleteMembership')
    await remove(services, 'm3')
    await remove(services, 'm4')
    expect(memberIds(services)).toEqual(['m1', 'm2', 'm9'])
    expect(list).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(drop).not.toHaveBeenCalled()
  })

  it.each([
    ['employer', 'Employer and pair groups always keep both members. Archive the group instead.'],
    ['pair', 'Employer and pair groups always keep both members. Archive the group instead.'],
    ['personal', 'A personal group always keeps its only member.'],
  ])('refuses in %s groups', async (type, message) => {
    const services = fakes(
      {
        groups: [group('g1', type)],
        persons: [person(1), person(2)],
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active'),
          member('m2', 'g1', 'p2', 'member', 'active'),
        ],
      },
      { g1: ['u1', 'u2'] },
    )
    expect(await removeFails(services, 'm2')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message,
    })
    expect(memberIds(services)).toEqual(['m1', 'm2'])
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
  })

  it('refuses someone with shares in the group, and leaves the team alone', async () => {
    const services = house({ shares: [share('s1', 'g1', 'p2', 0, 0)] })
    expect(await removeFails(services, 'm2')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: "Members with transactions can't be removed. Set leftOn instead.",
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
  })

  it('refuses to remove the last joined admin, and lets an admin remove themselves otherwise', async () => {
    const services = house({ members: [member('m6', 'g1', 'p9', 'admin', 'placeholder')] })
    expect(await removeFails(services, 'm1')).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'The group needs at least one admin who has joined.',
    })
    expect(teamUsers(services)).toEqual(['u1', 'u2'])

    await updateRow(services.db, 'members', 'm2', { role: 'admin' })
    expect(await remove(services, 'm1')).toEqual({})
    expect(teamUsers(services)).toEqual(['u2'])
  })

  it('refuses someone whose first share was committed after the first read', async () => {
    const services = house()
    beforeStaging(services.db, 1, () =>
      createRow(services.db, 'shares', share('s1', 'g1', 'p2', 0, 0)),
    )
    expect(await removeFails(services, 'm2')).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: "Members with transactions can't be removed. Set leftOn instead.",
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('answers CONFLICT when the member joined after the first read', async () => {
    const services = house()
    beforeStaging(services.db, 1, () =>
      updateRow(services.db, 'members', 'm3', { status: 'active' }),
    )
    expect(await removeFails(services, 'm3')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(memberIds(services)).toContain('m3')
  })

  it('takes a placeholder who joined meanwhile out of the team on the retry', async () => {
    const services = house({ members: [member('m4', 'g1', 'p9', 'member', 'placeholder')] })
    beforeStaging(services.db, 1, async () => {
      await updateRow(services.db, 'members', 'm4', { status: 'active' })
      await services.teams.createMembership({ teamId: 'g1', userId: 'u9', roles: [] })
    })
    expect(await removeFails(services, 'm4')).toMatchObject({ code: 'CONFLICT' })
    expect(teamUsers(services)).toEqual(['u1', 'u2', 'u9'])
    expect(await remove(services, 'm4')).toEqual({})
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
  })

  it('answers CONFLICT when the other admin is demoted at the same time', async () => {
    const services = house()
    await updateRow(services.db, 'members', 'm2', { role: 'admin' })
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm1', { role: 'member' }))
    expect(await removeFails(services, 'm2')).toMatchObject({
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
  })

  it('guards the other admin with a write that changes nothing on it', async () => {
    const services = house()
    await updateRow(services.db, 'members', 'm2', { role: 'admin' })
    const stage = vi.spyOn(services.db, 'createOperations')
    expect(await remove(services, 'm2')).toEqual({})
    const operations = stage.mock.calls.flatMap(([params]) => params.operations ?? [])
    expect(operations).toContainEqual(
      expect.objectContaining({ action: 'update', rowId: 'm1', data: { personId: 'p1' } }),
    )
    expect(services.db.rows('members')[0]).toMatchObject({ $id: 'm1', role: 'admin' })
  })

  it('refuses anyone but an admin', async () => {
    expect(await removeFails(house(), 'm3', 'u2')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it("answers NOT_FOUND for another group's member", async () => {
    const services = house()
    expect(await removeFails(services, 'm9')).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(services.teams.members('g2')?.map((m) => m.userId)).toEqual(['u9'])
  })

  it('takes no body', async () => {
    expect(await removeFails(house(), 'm3', 'u1', { force: true })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
  })

  it('answers CONFLICT when the row changes at the same time', async () => {
    const services = house()
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm2', { role: 'viewer' }))
    expect(await removeFails(services, 'm2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
  })
})
