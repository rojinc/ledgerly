import type { Groups } from '@ledgerly/core/generated/rows'
import { describe, expect, it } from 'vitest'
import { failure, fakes, group, member, NOW, ok, person, placeholder } from './harness'

const CLOSE_AT = '2026-10-31T13:00:00.000Z'

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

  it('makes the group read-only for write routes', async () => {
    const services = houseFixture()
    await ok(services, 'POST', '/groups/g1/archive')
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      status: 409,
      code: 'ARCHIVED',
    })
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
