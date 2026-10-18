import { describe, expect, it } from 'vitest'
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
  share,
  TODAY,
  TRY_AGAIN,
  updateRow,
} from './harness'

type Row = Record<string, unknown> & { $id: string }

// u1 is the admin, u2 a member who wants to leave, pX a placeholder with an account (u4).
function houseFixture(extra: { m2?: object; members?: Row[]; shares?: Row[] } = {}) {
  return fakes(
    {
      persons: [person(1), person(2), person(4, { $id: 'pX' })],
      groups: [group('g1', 'house')],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active', extra.m2),
        member('mX', 'g1', 'pX', 'member', 'placeholder'),
        ...(extra.members ?? []),
      ],
      shares: extra.shares ?? [],
    },
    { g1: ['u1', 'u2'] },
  )
}

function memberRow(services: Fakes, id: string) {
  return services.db.rows('members').find((row) => row.$id === id)
}

function teamUsers(services: Fakes, groupId: string) {
  return services.teams.members(groupId)?.map((membership) => membership.userId)
}

function leave(services: Fakes, userId: string | null, body?: unknown) {
  return failure(services, 'POST', '/groups/g1/leave', body, userId)
}

// `count` shares of 1 cent each way, plus `extra` cents given on the last one.
function smallShares(count: number, personId: string, extra = 0): Row[] {
  return Array.from({ length: count }, (_, i) =>
    share(
      `s${String(i).padStart(3, '0')}`,
      'g1',
      personId,
      i % 2 === 0 ? 1 : 0,
      i % 2 === 0 ? 0 : 1,
    ),
  ).map((row, i) =>
    i === count - 1 ? { ...row, givenCents: Number(row.givenCents) + extra } : row,
  )
}

describe('POST /groups/{id}/leave', () => {
  it('leaves as a viewer from today, out of the team, and records it', async () => {
    const services = houseFixture({ shares: [share('s1', 'g1', 'p2', 500, 500)] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
    expect(memberRow(services, 'm2')).toMatchObject({
      status: 'left',
      role: 'viewer',
      leftOn: TODAY,
      joinedOn: '2026-09-01',
    })
    expect(teamUsers(services, 'g1')).toEqual(['u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p2',
        action: 'member.left',
        summary: 'Member m2 left',
        at: NOW.toISOString(),
      }),
    ])
  })

  it('keeps a leftOn already set', async () => {
    const services = houseFixture({ m2: { leftOn: '2026-10-31' } })
    await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')
    expect(memberRow(services, 'm2')).toMatchObject({ status: 'left', leftOn: '2026-10-31' })
  })

  it('needs a balance of 0', async () => {
    const services = houseFixture({ shares: [share('s1', 'g1', 'p2', 500, 300)] })
    expect(await leave(services, 'u2')).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: "Settle up first: your balance in this group isn't 0.",
    })
    expect(memberRow(services, 'm2')).toMatchObject({ status: 'active', role: 'member' })
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('reads the balance across every page of shares', async () => {
    // 150 shares: the first page of 100 sums to 0 on its own, the second carries the debt.
    const owing = houseFixture({ shares: smallShares(150, 'p2', 1) })
    expect(await leave(owing, 'u2')).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(memberRow(owing, 'm2')?.status).toBe('active')

    const settled = houseFixture({ shares: smallShares(150, 'p2') })
    expect(await ok(settled, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
    expect(memberRow(settled, 'm2')?.status).toBe('left')
  })

  it("won't let the last joined admin leave", async () => {
    // m3 is an admin too, but hasn't joined, and m4 left.
    const services = houseFixture({
      members: [
        member('m3', 'g1', 'pP', 'admin', 'placeholder'),
        member('m4', 'g1', 'p5', 'admin', 'left'),
      ],
    })
    expect(await leave(services, 'u1')).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(memberRow(services, 'm1')).toMatchObject({ status: 'active', role: 'admin' })
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
  })

  it('lets an admin leave while another admin has joined', async () => {
    const services = houseFixture()
    await updateRow(services.db, 'members', 'm2', { role: 'admin' })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u1')).toEqual({})
    expect(memberRow(services, 'm1')).toMatchObject({ status: 'left', role: 'viewer' })
    expect(teamUsers(services, 'g1')).toEqual(['u2'])
  })

  it('finishes an interrupted leave: already left, still in the team', async () => {
    // The row is left already, so only the team step remains.
    const services = houseFixture({
      m2: { status: 'left', role: 'viewer', leftOn: '2026-10-10' },
      shares: [share('s1', 'g1', 'p2', 200, 200)],
    })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
    expect(teamUsers(services, 'g1')).toEqual(['u1'])
    expect(memberRow(services, 'm2')).toMatchObject({ status: 'left', leftOn: '2026-10-10' })
    expect(services.db.rows('activity')).toEqual([])
    // Once out of the team they're no longer a member (#117), so a later call can't read the
    // group: the app treats this answer to a leave as done.
    expect(await leave(services, 'u2')).toMatchObject({ status: 403, code: 'NOT_A_MEMBER' })
  })

  it('still needs a balance of 0 to finish an interrupted leave', async () => {
    const services = houseFixture({
      m2: { status: 'left', role: 'viewer', leftOn: '2026-10-10' },
      shares: [share('s1', 'g1', 'p2', 0, 200)],
    })
    expect(await leave(services, 'u2')).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: "Settle up first: your balance in this group isn't 0.",
    })
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
  })

  it('leaves no earlier than the day they joined', async () => {
    const services = houseFixture({ m2: { joinedOn: '2026-11-05' } })
    await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')
    expect(memberRow(services, 'm2')).toMatchObject({ status: 'left', leftOn: '2026-11-05' })
  })

  it('finishes an interrupted leave in an archived group', async () => {
    const services = fakes(
      {
        persons: [person(1), person(2)],
        groups: [group('g1', 'house', { archivedAt: '2026-10-01T00:00:00.000Z' })],
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active'),
          member('m2', 'g1', 'p2', 'viewer', 'left', { leftOn: '2026-10-10' }),
        ],
      },
      { g1: ['u1', 'u2'] },
    )
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
    expect(teamUsers(services, 'g1')).toEqual(['u1'])
    // Someone who hasn't left can't start leaving an archived group.
    expect(await leave(services, 'u1')).toMatchObject({ status: 409, code: 'ARCHIVED' })
    expect(teamUsers(services, 'g1')).toEqual(['u1'])
  })

  it('counts a share committed after the first read', async () => {
    const services = houseFixture()
    beforeStaging(services.db, 1, () =>
      createRow(services.db, 'shares', share('s1', 'g1', 'p2', 0, 300)),
    )
    expect(await leave(services, 'u2')).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(memberRow(services, 'm2')).toMatchObject({ status: 'active', role: 'member' })
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
  })

  it('answers CONFLICT when the other admin is demoted before it is staged', async () => {
    const services = houseFixture({ m2: { role: 'admin' } })
    // Staging 1 is the caller's row, 2 the other admin's.
    beforeStaging(services.db, 2, () => updateRow(services.db, 'members', 'm2', { role: 'member' }))
    expect(await leave(services, 'u1')).toMatchObject({ code: 'CONFLICT', message: TRY_AGAIN })
    expect(memberRow(services, 'm1')).toMatchObject({ status: 'active', role: 'admin' })
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
  })

  it('answers CONFLICT when the other admin leaves before the commit', async () => {
    const services = houseFixture({ m2: { role: 'admin' } })
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm2', { status: 'left' }))
    expect(await leave(services, 'u1')).toMatchObject({ code: 'CONFLICT', message: TRY_AGAIN })
    expect(memberRow(services, 'm1')).toMatchObject({ status: 'active', role: 'admin' })
  })

  it("won't leave a personal group", async () => {
    const services = fakes(
      {
        persons: [person(1)],
        groups: [group('gp', 'personal')],
        members: [member('m1', 'gp', 'p1', 'admin', 'active')],
      },
      { gp: ['u1'] },
    )
    expect(await failure(services, 'POST', '/groups/gp/leave')).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(teamUsers(services, 'gp')).toEqual(['u1'])
  })

  it('is only for joined members, signed in, with no body', async () => {
    const services = houseFixture()
    expect(await leave(services, 'u4')).toMatchObject({ status: 403, code: 'NOT_A_MEMBER' })
    expect(await leave(services, 'u9')).toMatchObject({ code: 'NOT_A_MEMBER' })
    expect(await leave(services, null)).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' })
    expect(await leave(services, 'u2', { now: true })).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(memberRow(services, 'mX')?.status).toBe('placeholder')
    expect(memberRow(services, 'm2')?.status).toBe('active')
    expect(services.db.rows('activity')).toEqual([])
  })

  it('answers CONFLICT when the member row changes before the commit', async () => {
    const services = houseFixture()
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm2', { displayName: 'Al' }))
    expect(await leave(services, 'u2')).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(memberRow(services, 'm2')).toMatchObject({ status: 'active', role: 'member' })
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it.each([
    ['joinedOn', { joinedOn: '2026-10-25' }],
    ['leftOn', { leftOn: '2026-10-30' }],
  ])('answers CONFLICT when %s changes before it is staged', async (_, change) => {
    const services = houseFixture()
    beforeStaging(services.db, 1, () => updateRow(services.db, 'members', 'm2', change))
    expect(await leave(services, 'u2')).toMatchObject({ code: 'CONFLICT', message: TRY_AGAIN })
    expect(memberRow(services, 'm2')).toMatchObject({ ...change, status: 'active' })
    expect(services.db.rows('activity')).toEqual([])
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
  })

  it('answers CONFLICT when the row stopped being theirs after it was read', async () => {
    const services = houseFixture()
    // Another leave committed between requireMember's read and this one's staging.
    const createOperations = services.db.createOperations.bind(services.db)
    let first = true
    services.db.createOperations = async (params) => {
      if (first) {
        first = false
        await updateRow(services.db, 'members', 'm2', { status: 'left' })
      }
      return createOperations(params)
    }
    expect(await leave(services, 'u2')).toMatchObject({ code: 'CONFLICT', message: TRY_AGAIN })
    expect(services.db.rows('activity')).toEqual([])
    expect(teamUsers(services, 'g1')).toEqual(['u1', 'u2'])
  })
})
