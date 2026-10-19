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
type Row = Record<string, unknown> & { $id: string }

function house(
  extra: {
    members?: ReturnType<typeof member>[]
    shares?: object[]
    transactions?: Row[]
    items?: Row[]
    schedules?: Row[]
  } = {},
) {
  return fakes(
    {
      transactions: extra.transactions ?? [],
      items: extra.items ?? [],
      schedules: extra.schedules ?? [],
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

/** A transaction row; `input` is what inputJson holds. */
function transaction(id: string, status: string, input: object, groupId = 'g1'): Row {
  return {
    $id: id,
    groupId,
    kind: 'bill',
    status,
    date: '2026-10-01',
    description: 'Power',
    totalCents: 9000,
    inputJson: JSON.stringify(input),
    createdBy: 'p1',
    updatedBy: 'p1',
  }
}

/** A bill paid by p1, split equally between `personIds`. */
function bill(id: string, status: string, personIds: string[], groupId = 'g1'): Row {
  return transaction(
    id,
    status,
    { payers: [{ personId: 'p1', cents: 9000 }], split: { mode: 'equal', personIds } },
    groupId,
  )
}

function item(id: string, transactionId: string, personIds: string[]): Row {
  return {
    $id: id,
    transactionId,
    position: 0,
    name: 'Milk',
    amountCents: 400,
    splitJson: JSON.stringify({ mode: 'equal', personIds }),
  }
}

function schedule(
  id: string,
  template: object,
  { kind = 'bill', createdBy = 'p1' }: { kind?: string; createdBy?: string } = {},
): Row {
  return {
    $id: id,
    groupId: 'g1',
    kind,
    description: 'Rent',
    templateJson: JSON.stringify(template),
    rrule: 'FREQ=WEEKLY;BYDAY=TH',
    startsOn: '2026-10-01',
    skipPublicHolidays: false,
    autoPost: false,
    createdBy,
  }
}

/** A template with no payers: the schedule's creator pays each occurrence (#155 O4). */
const NO_PAYERS = { totalCents: 9000, bill: { status: 'due' } }

const IS_NAMED =
  "This person is named in a transaction that isn't posted yet, or in a schedule. Set leftOn instead."

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
  it('removes the row and the team membership, and writes member.removed about them', async () => {
    const services = house()
    expect(await remove(services, 'm2')).toEqual({})
    expect(memberIds(services)).toEqual(['m1', 'm3', 'm9'])
    expect(teamUsers(services)).toEqual(['u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'p1',
        action: 'member.removed',
        subjectPersonId: 'p2',
        summary: 'was removed',
        at: NOW.toISOString(),
        $permissions: ['read("team:g1")'],
      }),
    ])
  })

  it("leaves someone else's membership alone if Teams answers with it (#121)", async () => {
    const services = house()
    const admin = services.teams.members('g1')?.find((membership) => membership.userId === 'u1')
    vi.spyOn(services.teams, 'listMemberships').mockResolvedValue({
      total: 1,
      memberships: [admin as never],
    })
    const add = vi.spyOn(services.teams, 'createMembership')
    expect(await remove(services, 'm2')).toEqual({})
    expect(teamUsers(services)).toContain('u1')
    expect(add).not.toHaveBeenCalled()
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

  it.each([
    ['a due bill', { transactions: [bill('t1', 'due', ['p1', 'p2'])] }],
    ['a scheduled occurrence', { transactions: [bill('t1', 'scheduled', ['p1', 'p2'])] }],
    [
      'a running payment',
      {
        transactions: [
          transaction('t1', 'running', { payment: { fromPersonId: 'p2', toPersonId: 'p1' } }),
        ],
      },
    ],
    [
      "an unposted transaction's item",
      {
        transactions: [bill('t1', 'scheduled', ['p1'])],
        items: [item('i1', 't1', ['p1']), item('i2', 't1', ['p1', 'p2'])],
      },
    ],
    [
      "a schedule's template",
      {
        schedules: [
          schedule('sc1', {
            payers: [{ personId: 'p1', cents: 9000 }],
            items: [
              {
                name: 'Rent',
                amountCents: 9000,
                split: { mode: 'equal', personIds: ['p1', 'p2'] },
              },
            ],
          }),
        ],
      },
    ],
  ])('refuses someone named in %s, and leaves the team alone', async (_, extra) => {
    const services = house(extra)
    expect(await removeFails(services, 'm2')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: IS_NAMED,
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
  })

  it.each([
    ['a bill', 'bill', NO_PAYERS],
    ['an expense', 'expense', { totalCents: 9000 }],
  ])(
    'refuses the creator of %s schedule whose template names no payers (#155 O4)',
    async (_, kind, template) => {
      const services = house({ schedules: [schedule('sc1', template, { kind, createdBy: 'p2' })] })
      expect(await removeFails(services, 'm2')).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: IS_NAMED,
      })
      expect(memberIds(services)).toContain('m2')
      expect(teamUsers(services)).toEqual(['u1', 'u2'])
    },
  )

  it('removes the creator of a schedule whose template names who pays', async () => {
    const services = house({
      schedules: [
        schedule(
          'sc1',
          { ...NO_PAYERS, payers: [{ personId: 'p1', cents: 9000 }] },
          { createdBy: 'p2' },
        ),
      ],
    })
    expect(await remove(services, 'm2')).toEqual({})
    expect(memberIds(services)).not.toContain('m2')
  })

  it('removes someone when a payer-less schedule was created by someone else', async () => {
    const services = house({ schedules: [schedule('sc1', NO_PAYERS, { createdBy: 'p1' })] })
    expect(await remove(services, 'm2')).toEqual({})
    expect(memberIds(services)).not.toContain('m2')
  })

  it('refuses the creator of a payer-less schedule committed after the first read', async () => {
    const services = house()
    beforeStaging(services.db, 1, () =>
      createRow(services.db, 'schedules', schedule('sc1', NO_PAYERS, { createdBy: 'p2' })),
    )
    expect(await removeFails(services, 'm2')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: IS_NAMED,
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('reads every page of unposted transactions', async () => {
    const others = Array.from({ length: 100 }, (_, n) =>
      bill(`t${String(n).padStart(3, '0')}`, 'due', ['p1']),
    )
    const services = house({ transactions: [...others, bill('t100', 'due', ['p2'])] })
    expect(await removeFails(services, 'm2')).toMatchObject({ message: IS_NAMED })
  })

  it('removes someone named only in posted or void transactions, or in another group', async () => {
    const services = house({
      transactions: [
        bill('t1', 'posted', ['p1', 'p2']),
        bill('t2', 'void', ['p1', 'p2']),
        bill('t3', 'due', ['p1']),
        bill('t4', 'due', ['p9', 'p2'], 'g2'),
      ],
      items: [item('i1', 't1', ['p2']), item('i3', 't3', ['p1'])],
      schedules: [schedule('sc1', { payers: [{ personId: 'p1', cents: 100 }] })],
    })
    expect(await remove(services, 'm2')).toEqual({})
    expect(memberIds(services)).not.toContain('m2')
  })

  it('refuses someone named in a transaction committed after the first read', async () => {
    const services = house()
    beforeStaging(services.db, 1, () =>
      createRow(services.db, 'transactions', bill('t1', 'due', ['p1', 'p2'])),
    )
    expect(await removeFails(services, 'm2')).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: IS_NAMED,
    })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1', 'u2'])
    expect(services.db.rows('activity')).toEqual([])
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

  it("doesn't give team access back to someone who left at the same time", async () => {
    const services = house()
    beforeCommit(services.db, () =>
      updateRow(services.db, 'members', 'm2', { status: 'left', role: 'viewer' }),
    )
    expect(await removeFails(services, 'm2')).toMatchObject({ code: 'CONFLICT' })
    expect(memberIds(services)).toContain('m2')
    expect(teamUsers(services)).toEqual(['u1'])
  })

  it('gives team access back to someone moved out earlier when the removal fails', async () => {
    const services = house({
      members: [member('m5', 'g1', 'p9', 'viewer', 'left', { leftOn: '2026-09-30' })],
    })
    await services.teams.createMembership({ teamId: 'g1', userId: 'u9', roles: [] })
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm5', { displayName: 'X' }))
    expect(await removeFails(services, 'm5')).toMatchObject({ code: 'CONFLICT' })
    expect(teamUsers(services)).toEqual(['u1', 'u2', 'u9'])
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

  it('guards the other admin with a fresh rev, a real change that leaves everything else', async () => {
    const services = house()
    await updateRow(services.db, 'members', 'm2', { role: 'admin' })
    const stage = vi.spyOn(services.db, 'createOperations')
    expect(await remove(services, 'm2')).toEqual({})
    const operations = stage.mock.calls.flatMap(([params]) => params.operations ?? [])
    expect(operations).toContainEqual(
      expect.objectContaining({
        action: 'update',
        rowId: 'm1',
        data: { rev: expect.stringMatching(/^[a-z0-9]{20}$/) },
      }),
    )
    expect(services.db.rows('members')[0]).toMatchObject({ $id: 'm1', role: 'admin' })
  })

  it('fails a demotion of the other admin that was staged before it commits', async () => {
    const services = house()
    await updateRow(services.db, 'members', 'm2', { role: 'admin' })
    const { $id } = await services.db.createTransaction()
    await services.db.createOperations({
      transactionId: $id,
      operations: [
        {
          action: 'update',
          databaseId: 'main',
          tableId: 'members',
          rowId: 'm1',
          data: { role: 'member' },
        },
      ],
    })
    expect(await remove(services, 'm2')).toEqual({})
    await expect(
      services.db.updateTransaction({ transactionId: $id, commit: true }),
    ).rejects.toMatchObject({ code: 409 })
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
