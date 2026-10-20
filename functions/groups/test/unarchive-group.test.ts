import type { Groups, Shares } from '@ledgerly/core/generated/rows'
import { balancesFromShares } from '@ledgerly/core/settle/balances'
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
  share,
  TRY_AGAIN,
  updateRow,
} from './harness'

const ARCHIVED_AT = '2026-09-30T02:00:00.000Z'
// 06:00 in Sydney on 1 November, the day after October, the period today (19 October) is in.
const OCTOBER_CLOSE = '2026-10-31T19:00:00.000Z'

/** p1's archived house g1, where p2 is a member, p3 a viewer and pX a placeholder. */
function houseFixture(extra: Parameters<typeof fakes>[0] = {}) {
  return fakes(
    {
      persons: [person(1), person(2), person(3), placeholder('pX')],
      groups: [
        group('g1', 'house', { statementCycle: 'monthly', archivedAt: ARCHIVED_AT }),
        group('g2', 'house', { archivedAt: ARCHIVED_AT }),
      ],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active'),
        member('m3', 'g1', 'p3', 'viewer', 'active'),
        member('mX', 'g1', 'pX', 'member', 'placeholder'),
      ],
      ...extra,
    },
    { g1: ['u1', 'u2', 'u3'] },
  )
}

/** An archived group of `type` with `extra` columns, where p1 (u1) is a joined admin. */
function groupFixture(
  type: string,
  extra: object = {},
  other = member('m2', 'g1', 'p2', 'admin', 'placeholder'),
) {
  return fakes(
    {
      persons: [person(1), person(2)],
      groups: [group('g1', type, { archivedAt: ARCHIVED_AT, ...extra })],
      members: [member('m1', 'g1', 'p1', 'admin', 'active'), other],
    },
    { g1: other.status === 'active' ? ['u1', 'u2'] : ['u1'] },
  )
}

function unarchive(services: Fakes, userId = 'u1') {
  return ok<Groups>(services, 'POST', '/groups/g1/unarchive', undefined, userId)
}

function stored(services: Fakes) {
  return services.db.rows('groups').find((row) => row.$id === 'g1')
}

describe('POST /groups/{id}/unarchive', () => {
  it('unarchives the group, works out its next close from today, and records it', async () => {
    const services = houseFixture()
    const unarchived = await unarchive(services)
    expect(unarchived).toMatchObject({
      $id: 'g1',
      archivedAt: null,
      nextCloseAt: OCTOBER_CLOSE,
      statementCycle: 'monthly',
    })
    expect(stored(services)).toMatchObject({ archivedAt: null, nextCloseAt: OCTOBER_CLOSE })
    // Naming no one, as group.archived doesn't: no subject, no changes.
    const columns = services.db
      .rows('activity')
      .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('$'))))
    expect(columns).toEqual([
      {
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'group.unarchived',
        summary: 'Unarchived the group',
        at: NOW.toISOString(),
      },
    ])
    // The other archived group stays archived.
    expect(services.db.rows('groups')[1]).toMatchObject({ archivedAt: ARCHIVED_AT })
  })

  it.each([
    ['no cycle', { statementCycle: 'none' }, null],
    ['a monthly cycle', { statementCycle: 'monthly' }, OCTOBER_CLOSE],
    // The week of 19 October, from a Monday anchor: closes 06:00 on Monday 26 October.
    [
      'a weekly cycle',
      { statementCycle: 'weekly', cycleAnchor: '2026-10-05' },
      '2026-10-25T19:00:00.000Z',
    ],
    // #405: a later anchor's first period, 2–8 November, not a stub before it.
    [
      'a future anchor',
      { statementCycle: 'weekly', cycleAnchor: '2026-11-02' },
      '2026-11-08T19:00:00.000Z',
    ],
    [
      'a future fortnightly anchor',
      { statementCycle: 'fortnightly', cycleAnchor: '2026-11-02' },
      '2026-11-15T19:00:00.000Z',
    ],
  ])('sets nextCloseAt for %s', async (_case, cycle, nextCloseAt) => {
    const services = groupFixture('employer', cycle)
    expect(await unarchive(services)).toMatchObject({ archivedAt: null, nextCloseAt })
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('returns a group that isn’t archived unchanged on a repeat, and records nothing more', async () => {
    const services = houseFixture()
    const first = await unarchive(services)
    const write = vi.spyOn(services.db, 'createOperations')
    const again = await unarchive(services)
    expect(again).toEqual(first)
    expect(write).not.toHaveBeenCalled()
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('answers CONFLICT when another unarchive lands before staging, then returns the stored group', async () => {
    const services = houseFixture()
    // The other unarchive, whole, between this one's read and its staging.
    beforeStaging(services.db, 1, () => unarchive(services))
    expect(await failure(services, 'POST', '/groups/g1/unarchive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('activity')).toHaveLength(1)
    expect(await unarchive(services)).toMatchObject({
      archivedAt: null,
      nextCloseAt: OCTOBER_CLOSE,
    })
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('fails its commit when another unarchive commits after its check, with one row in all', async () => {
    const services = houseFixture()
    beforeCommit(services.db, () => unarchive(services))
    expect(await failure(services, 'POST', '/groups/g1/unarchive')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(stored(services)).toMatchObject({ archivedAt: null })
    expect(services.db.rows('activity')).toHaveLength(1)
    expect(await unarchive(services)).toMatchObject({ archivedAt: null })
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('answers CONFLICT once the group’s delete has started, writing nothing', async () => {
    const services = houseFixture()
    await updateRow(services.db, 'groups', 'g1', {
      deletingAt: NOW.toISOString(),
      deletingBy: 'p1',
    })
    const write = vi.spyOn(services.db, 'createOperations')
    expect(await failure(services, 'POST', '/groups/g1/unarchive')).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
    expect(write).not.toHaveBeenCalled()
    expect(stored(services)).toMatchObject({ archivedAt: ARCHIVED_AT, nextCloseAt: null })
    expect(services.db.rows('activity')).toEqual([])
  })

  it.each([
    ['between its read and its staging', 'staging'],
    ['between its staging and its commit', 'commit'],
  ])('answers CONFLICT, writing nothing, when a delete starts %s', async (_, when) => {
    const services = houseFixture()
    const startDelete = () =>
      updateRow(services.db, 'groups', 'g1', { deletingAt: NOW.toISOString(), deletingBy: 'p1' })
    if (when === 'staging') beforeStaging(services.db, 1, startDelete)
    else beforeCommit(services.db, startDelete)
    expect(await failure(services, 'POST', '/groups/g1/unarchive')).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
    expect(stored(services)).toMatchObject({ archivedAt: ARCHIVED_AT, deletingBy: 'p1' })
    expect(services.db.rows('activity')).toEqual([])
    vi.restoreAllMocks()
    // Still refused: the delete only goes on from here.
    expect((await failure(services, 'POST', '/groups/g1/unarchive')).code).toBe('CONFLICT')
  })

  it('makes the group writable again for the writes the archive refused', async () => {
    const services = houseFixture()
    const rename = { name: 'Flat 4' }
    const demote = { role: 'viewer' }
    expect(await failure(services, 'PATCH', '/groups/g1', rename)).toMatchObject({
      code: 'ARCHIVED',
    })
    expect(await failure(services, 'PATCH', '/groups/g1/members/m2', demote)).toMatchObject({
      code: 'ARCHIVED',
    })
    await unarchive(services)
    expect(await ok(services, 'PATCH', '/groups/g1', rename)).toMatchObject({ name: 'Flat 4' })
    expect(await ok(services, 'PATCH', '/groups/g1/members/m2', demote)).toMatchObject({
      role: 'viewer',
    })
  })

  it('unarchives with a timer still running, and leaves the timer as it was', async () => {
    const running = {
      $id: 't1',
      groupId: 'g1',
      kind: 'shift',
      status: 'running',
      date: '2026-09-29',
      description: 'Shift',
      totalCents: 0,
      startedAt: '2026-09-28T23:00:00.000Z',
      createdBy: 'p1',
      updatedBy: 'p1',
    }
    const services = fakes(
      {
        persons: [person(1), placeholder('pA', 'Acme')],
        groups: [group('g1', 'employer', { archivedAt: ARCHIVED_AT })],
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active'),
          member('mA', 'g1', 'pA', 'viewer', 'placeholder'),
        ],
        transactions: [running],
      },
      { g1: ['u1'] },
    )
    expect(await unarchive(services)).toMatchObject({ archivedAt: null })
    expect(services.db.rows('transactions')).toEqual([expect.objectContaining(running)])
  })

  it('writes no transaction, share or balances row, and the balances still fit the shares', async () => {
    const shares = [share('s1', 'g1', 'p1', 9000, 3000), share('s2', 'g1', 'p2', 0, 6000)]
    const balances = balancesFromShares(shares as unknown as Shares[])
    const services = houseFixture({
      shares,
      balances: [{ $id: 'g1', peopleJson: JSON.stringify(balances) }],
    })
    const before = ['transactions', 'shares', 'balances'].map((table) => services.db.rows(table))
    const staged = vi.spyOn(services.db, 'createOperations')
    await unarchive(services)
    const tables = staged.mock.calls.flatMap(([params]) =>
      (params.operations as { tableId: string }[]).map((operation) => operation.tableId),
    )
    expect(new Set(tables)).toEqual(new Set(['groups', 'activity']))
    expect(['transactions', 'shares', 'balances'].map((table) => services.db.rows(table))).toEqual(
      before,
    )
    // ledger.md#balances: the stored row is still a fresh sum of the shares.
    const row = services.db.rows('balances')[0]
    expect(JSON.parse(String(row?.peopleJson))).toEqual(
      balancesFromShares(services.db.rows('shares') as unknown as Shares[]),
    )
  })

  it('rejects a body', async () => {
    const services = houseFixture()
    expect(
      await failure(services, 'POST', '/groups/g1/unarchive', { archived: false }),
    ).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(stored(services)?.archivedAt).toBe(ARCHIVED_AT)
  })

  it.each(['house', 'employer', 'pair'])('lets an admin of a %s unarchive it', async (type) => {
    const services = groupFixture(type)
    expect(await unarchive(services)).toMatchObject({ archivedAt: null })
  })

  it('lets either admin of a pair unarchive it', async () => {
    const services = groupFixture('pair', {}, member('m2', 'g1', 'p2', 'admin', 'active'))
    expect(await unarchive(services, 'u2')).toMatchObject({ archivedAt: null })
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({ actorPersonId: 'p2', action: 'group.unarchived' }),
    ])
  })

  it.each([
    ['house', 'member', 'active', 'FORBIDDEN'],
    ['house', 'viewer', 'active', 'FORBIDDEN'],
    ['house', 'admin', 'placeholder', 'NOT_A_MEMBER'],
    // Left on their own, so out of the team (permissions.md#leaving-a-group).
    ['house', 'admin', 'left', 'NOT_A_MEMBER'],
    // The employer, once they've joined.
    ['employer', 'viewer', 'active', 'FORBIDDEN'],
    ['employer', 'viewer', 'placeholder', 'NOT_A_MEMBER'],
    ['pair', 'member', 'active', 'FORBIDDEN'],
    ['pair', 'admin', 'placeholder', 'NOT_A_MEMBER'],
    ['pair', 'viewer', 'left', 'NOT_A_MEMBER'],
  ] as const)('refuses a %s %s who is %s', async (type, role, status, code) => {
    const services = groupFixture(type, {}, member('m2', 'g1', 'p2', role, status))
    expect(await failure(services, 'POST', '/groups/g1/unarchive', undefined, 'u2')).toMatchObject({
      status: 403,
      code,
    })
    expect(stored(services)?.archivedAt).toBe(ARCHIVED_AT)
    expect(services.db.rows('activity')).toEqual([])
  })

  it('refuses someone who isn’t in the group, or isn’t signed in', async () => {
    const services = houseFixture()
    expect(await failure(services, 'POST', '/groups/g1/unarchive', undefined, 'u9')).toMatchObject({
      code: 'NOT_A_MEMBER',
    })
    expect(await failure(services, 'POST', '/groups/g1/unarchive', undefined, null)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
    expect(stored(services)?.archivedAt).toBe(ARCHIVED_AT)
  })

  it('answers a member of an unarchived group FORBIDDEN too, and changes nothing', async () => {
    const services = houseFixture()
    await updateRow(services.db, 'groups', 'g1', { archivedAt: null })
    expect(await failure(services, 'POST', '/groups/g1/unarchive', undefined, 'u2')).toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(services.db.rows('activity')).toEqual([])
  })
})
