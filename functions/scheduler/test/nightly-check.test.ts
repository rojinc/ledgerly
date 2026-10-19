import { readdirSync, readFileSync } from 'node:fs'
import type { Groups } from '@ledgerly/core/generated/rows'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { nightlyCheck } from '../src/steps/nightly-check'
import { call, type Fakes, fakes, group, member, NOW, person } from './harness'

// scheduling.md#step-6-nightly-check. NOW is 07:00 on Monday 19 October in Sydney.
const TOMORROW_3AM_SYDNEY = '2026-10-19T16:00:00.000Z'
const HOUR = 60 * 60 * 1000

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function transaction(id: string, totalCents: number, extra: object = {}) {
  return {
    $id: id,
    groupId: 'elm',
    kind: 'expense',
    status: 'posted',
    date: '2026-10-10',
    description: 'Groceries',
    category: null,
    totalCents,
    inputJson: '{}',
    dueOn: null,
    scheduleId: null,
    overridden: false,
    statementId: null,
    receiptFileIds: null,
    startedAt: null,
    remindedAt: null,
    voidReason: null,
    createdBy: 'pSam',
    updatedBy: 'pSam',
    ...extra,
  }
}

function share(
  id: string,
  transactionId: string,
  personId: string,
  given: number,
  received: number,
) {
  return {
    $id: id,
    transactionId,
    personId,
    givenCents: given,
    receivedCents: received,
    groupId: 'elm',
    date: '2026-10-10',
    kind: 'expense',
    category: null,
  }
}

// Sam paid $60 of groceries for Sam and Alex.
const GROCERIES = [
  transaction('t1', 6000),
  share('s1', 't1', 'pSam', 6000, 3000),
  share('s2', 't1', 'pAlex', 0, 3000),
]
const ROW = [
  { personId: 'pAlex', netCents: -3000, shares: 1 },
  { personId: 'pSam', netCents: 3000, shares: 1 },
]

const MEMBERS = [
  member('elm', 'pSam'),
  member('elm', 'pAlex', { role: 'member' }),
  member('elm', 'pPat', { status: 'placeholder' }),
  member('elm', 'pLee', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
]

/**
 * Elm St, a Sydney house: Sam (u1) and Alex (u2) live there, Pat is a placeholder, and Lee (u3)
 * moved out. Each of them has a team membership but Pat. `extra` adds rows by table.
 */
function seeded(extra: Record<string, object[]> = {}, teams: Record<string, string[]> = {}) {
  const [transactions, shares] = [GROCERIES.slice(0, 1), GROCERIES.slice(1)]
  return fakes(
    {
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pPat', null),
        person('pLee', 'u3'),
      ],
      groups: [
        group('elm', 'pSam', {
          type: 'house',
          name: 'Elm St',
          settingsJson: '{"type":"house"}',
          rev: 'r0',
        }),
      ],
      members: MEMBERS,
      transactions,
      shares,
      ...extra,
    } as never,
    { teams: { elm: ['u1', 'u2', 'u3'], ...teams } },
  )
}

function stored(services: Fakes, groupId = 'elm') {
  const row = services.db.rows('balances').find((balances) => balances.$id === groupId)
  return row && JSON.parse(String(row.peopleJson))
}

function groupRow(services: Fakes, groupId = 'elm') {
  return services.db.rows('groups').find((row) => row.$id === groupId) as unknown as Groups
}

const logged = () => errors.mock.calls.map(([line]) => String(line))

describe('step 6: nightly check', () => {
  it('backfills a group’s balances row on its first check, then waits until 03:00 tomorrow', async () => {
    const services = seeded()
    expect(await nightlyCheck(services)).toEqual({
      checked: 1,
      busy: 0,
      cutOff: 0,
      skipped: 0,
      findings: 0,
      merging: 0,
      repaired: 1,
      removed: 0,
      failed: 0,
    })
    expect(stored(services)).toEqual(ROW)
    expect(groupRow(services).nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
    // A backfill isn't a finding, and a group that isn't due yet isn't read.
    expect(logged()).toEqual([])
    expect((await nightlyCheck(services)).checked).toBe(0)
  })

  it('checks a due group again, and finds nothing when all is well', async () => {
    const services = seeded({ balances: [{ $id: 'elm', peopleJson: JSON.stringify(ROW) }] })
    vi.setSystemTime(new Date(Date.parse(TOMORROW_3AM_SYDNEY)))
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'groups',
        rowId: 'elm',
        data: { nextCheckAt: NOW.toISOString() },
      }),
    )
    const counts = await nightlyCheck(services)
    expect(counts).toMatchObject({ checked: 1, repaired: 0, findings: 0 })
    expect(logged()).toEqual([])
  })

  it('repairs a balances row that drifted, and logs it with the group ID only', async () => {
    const wrong = [{ personId: 'pSam', netCents: 100, shares: 1 }]
    const services = seeded({ balances: [{ $id: 'elm', peopleJson: JSON.stringify(wrong) }] })
    expect(await nightlyCheck(services)).toMatchObject({ repaired: 1, findings: 1 })
    expect(stored(services)).toEqual(ROW)
    expect(logged()).toEqual(['scheduler: nightly check of group elm: balances row wrong'])
  })

  it('repairs a row that can’t be read', async () => {
    const services = seeded({ balances: [{ $id: 'elm', peopleJson: '{' }] })
    expect(await nightlyCheck(services)).toMatchObject({ repaired: 1, findings: 1 })
    expect(stored(services)).toEqual(ROW)
  })

  it('reports broken shares and transactions, and never changes them', async () => {
    const services = seeded({
      transactions: [
        transaction('t1', 6000),
        // I-1: the shares add up to $50, not $60.
        transaction('t2', 6000),
        // I-6: a void transaction with a share left behind.
        transaction('t3', 1000, { status: 'void' }),
        // I-3: a share for someone with no member row.
        transaction('t4', 1000),
      ],
      shares: [
        ...GROCERIES.slice(1),
        share('s3', 't2', 'pSam', 5000, 2500),
        share('s4', 't2', 'pAlex', 0, 2500),
        share('s5', 't3', 'pSam', 1000, 1000),
        share('s6', 't4', 'pSam', 1000, 0),
        share('s7', 't4', 'pDan', 0, 1000),
      ],
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pPat', null),
        person('pLee', 'u3'),
        person('pDan', 'u4'),
      ],
    })
    const before = structuredClone([services.db.rows('shares'), services.db.rows('transactions')])
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 3, merging: 0 })
    expect(logged()).toEqual([
      'scheduler: nightly check of group elm: transaction t2 breaks I-1',
      'scheduler: nightly check of group elm: transaction t3 breaks I-6',
      'scheduler: nightly check of group elm: transaction t4 breaks I-3',
    ])
    expect([services.db.rows('shares'), services.db.rows('transactions')]).toEqual(before)
  })

  it('counts a share of a person being merged as merging, not as broken', async () => {
    // Pat was merged into Dan, whose merge hasn't moved Pat's share yet; Pat's row went to Dan.
    const services = seeded(
      {
        persons: [
          person('pSam', 'u1'),
          person('pAlex', 'u2'),
          { ...person('pPat', null), mergedInto: 'pDan' },
          person('pLee', 'u3'),
        ],
        members: [member('elm', 'pSam'), member('elm', 'pAlex', { role: 'member' })],
        transactions: [transaction('t1', 6000)],
        shares: [share('s1', 't1', 'pSam', 6000, 3000), share('s2', 't1', 'pPat', 0, 3000)],
        // A merge moves P's identities last, so Pat still having one means it isn't finished.
        identities: [
          {
            $id: 'i1',
            key: 'email:pat@example.com',
            type: 'email',
            personId: 'pPat',
            verified: true,
            verifiedAt: null,
          },
        ],
      },
      { elm: ['u1', 'u2'] },
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 0, merging: 1 })

    // Once the merge is finished (no identity left on Pat), a share left on Pat is broken.
    await withTransaction(services.db, (tx) =>
      tx.write(
        { action: 'delete', tableId: 'identities', rowId: 'i1' },
        { action: 'update', tableId: 'groups', rowId: 'elm', data: { nextCheckAt: null } },
      ),
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 1, merging: 0 })
    expect(logged()).toEqual(['scheduler: nightly check of group elm: transaction t1 breaks I-3'])
  })

  it('counts a share of a person merged into a deleted account as merging, not as broken', async () => {
    // Pat was merged into Dan, then Dan deleted his account before the merge finished. Deletion
    // deletes Pat's identities too (identity-and-invites.md, step 5), so it never will.
    const services = seeded(
      {
        persons: [
          person('pSam', 'u1'),
          person('pAlex', 'u2'),
          { ...person('pPat', null), mergedInto: 'pDan' },
          { ...person('pDan', null), deletedAt: '2026-10-18T00:00:00.000Z' },
        ],
        members: [member('elm', 'pSam'), member('elm', 'pAlex', { role: 'member' })],
        transactions: [transaction('t1', 6000)],
        shares: [share('s1', 't1', 'pSam', 6000, 3000), share('s2', 't1', 'pPat', 0, 3000)],
      },
      { elm: ['u1', 'u2'] },
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 0, merging: 1 })
    expect(logged()).toEqual([])
  })

  it('reads a group again when a write of shares lands while it is read', async () => {
    const services = seeded()
    const list = services.db.listRows.bind(services.db)
    let writes = 0
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      // A ledger write's group guard lands during the first read only.
      if (params.tableId === 'shares' && ++writes === 1) {
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'update', tableId: 'groups', rowId: 'elm', data: { rev: 'r1' } }),
        )
      }
      return list(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, busy: 0 })
    expect(writes).toBeGreaterThan(1)
  })

  it('leaves a group for the next run when writes land during every read', async () => {
    const services = seeded()
    const list = services.db.listRows.bind(services.db)
    let rev = 0
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares') {
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'groups',
            rowId: 'elm',
            data: { rev: `r${++rev}` },
          }),
        )
      }
      return list(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 1 })
    expect(rev).toBe(3)
    // An hour on, so the next run starts with the groups after it.
    expect(groupRow(services).nextCheckAt).toBe(new Date(NOW.getTime() + HOUR).toISOString())
    expect(stored(services)).toBeUndefined()
  })

  it('leaves the row for the next run when a write of shares beats the repair', async () => {
    const services = seeded()
    const commit = services.db.updateTransaction.bind(services.db)
    let first = true
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (first && params.commit) {
        first = false
        // A ledger write's guard commits between the repair's staging and its commit.
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'update', tableId: 'groups', rowId: 'elm', data: { rev: 'r9' } }),
        )
      }
      return commit(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 1, repaired: 0 })
    expect(stored(services)).toBeUndefined()
  })

  it('moves a group the budget cuts off to tomorrow, by ID, and checks it then from the start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const [reads, repaired] of [
      // Out of time once the group is read whole, or once its row is repaired.
      [3, 0],
      [4, 1],
    ] as const) {
      // u9 has no member row: a stale membership.
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
      let calls = 0
      // Two reads let the page in and the group out of it.
      services.outOfTime = () => ++calls > reads - 1
      expect(await nightlyCheck(services)).toMatchObject({ checked: 0, cutOff: 1, repaired })
      expect(groupRow(services).nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
      expect(warn).toHaveBeenLastCalledWith(
        'scheduler: nightly check of group elm cut off by the budget',
      )
      // The team wasn't reached.
      expect(services.teams.members('elm')).toHaveLength(4)
      services.outOfTime = () => false
      services.now = new Date(TOMORROW_3AM_SYDNEY)
      expect(await nightlyCheck(services)).toMatchObject({ checked: 1, removed: 1 })
    }
  })

  it('leaves a group it doesn’t reach due, for the next run', async () => {
    const services = seeded(
      {
        groups: [
          group('elm', 'pSam', { type: 'house', name: 'Elm St', settingsJson: '{"type":"house"}' }),
          group('oak', 'pSam', { type: 'house', name: 'Oak Rd', settingsJson: '{"type":"house"}' }),
        ],
      },
      { oak: ['u1'] },
    )
    let calls = 0
    // Out of time once Elm St is done: the page, Elm St, its two checks, then Oak Rd.
    services.outOfTime = () => ++calls > 4
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, cutOff: 0 })
    expect(groupRow(services, 'oak').nextCheckAt ?? null).toBeNull()
  })

  it('skips a group whose team is gone, as a purge leaves it, and leaves it due', async () => {
    // The purge has deleted the team and some of the group's shares: s2 is gone.
    const services = seeded({ shares: [GROCERIES[1] as object] })
    services.teams = new FakeTeams()
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, skipped: 1, findings: 0 })
    expect(stored(services)).toBeUndefined()
    expect(groupRow(services).nextCheckAt ?? null).toBeNull()
    expect(logged()).toEqual([])
  })

  it('checks archived groups too', async () => {
    const services = seeded({
      groups: [
        group('elm', 'pSam', {
          type: 'house',
          name: 'Elm St',
          settingsJson: '{"type":"house"}',
          archivedAt: '2026-10-01T00:00:00.000Z',
        }),
      ],
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, repaired: 1 })
  })

  it('is due at 03:00 local, across a daylight saving change', async () => {
    // Sydney moves its clocks forward at 02:00 on Sunday 4 October 2026: 03:00 on the 4th is
    // 16:00 UTC on the 3rd, and 03:00 on the 3rd was 17:00 UTC on the 2nd.
    vi.setSystemTime(new Date('2026-10-02T20:00:00.000Z'))
    const services = seeded()
    services.now = new Date('2026-10-02T20:00:00.000Z')
    await nightlyCheck(services)
    expect(groupRow(services).nextCheckAt).toBe('2026-10-03T16:00:00.000Z')
  })

  describe('the team', () => {
    // Pat, the placeholder, has an account now.
    const PAT_SIGNED_UP = [
      person('pSam', 'u1'),
      person('pAlex', 'u2'),
      person('pPat', 'u9'),
      person('pLee', 'u3'),
    ]
    const userIds = (services: Fakes, groupId = 'elm') =>
      services.teams.members(groupId)?.map((membership) => membership.userId)

    it('removes a membership that no joined member row backs, and logs only its ID', async () => {
      // Pat got a membership: a join that stopped halfway.
      const services = seeded({ persons: PAT_SIGNED_UP }, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const stale = services.teams.members('elm')?.find((membership) => membership.userId === 'u9')
      expect(await nightlyCheck(services)).toMatchObject({ removed: 1, findings: 1 })
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3'])
      expect(logged()).toEqual([
        `scheduler: nightly check of group elm: removed team membership ${stale?.$id}`,
      ])
    })

    it('keeps a membership up to an hour old, and removes one older', async () => {
      for (const [minutes, removed] of [
        [59, 0],
        [61, 1],
      ] as const) {
        const services = seeded({ persons: PAT_SIGNED_UP })
        // Joining adds the membership before the member row.
        vi.setSystemTime(new Date(NOW.getTime() - minutes * 60 * 1000))
        await services.teams.createMembership({ teamId: 'elm', userId: 'u9', roles: [] })
        vi.setSystemTime(NOW)
        expect([minutes, (await nightlyCheck(services)).removed]).toEqual([minutes, removed])
      }
    })

    it('never removes one whose join lands after the group is read', async () => {
      const services = seeded({ persons: PAT_SIGNED_UP }, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const remove = vi.spyOn(services.teams, 'deleteMembership')
      const list = services.db.listRows.bind(services.db)
      let joined = false
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        // Pat's join commits as the check looks up the team's persons.
        if (!joined && params.tableId === 'persons') {
          joined = true
          await withTransaction(services.db, (tx) =>
            tx.write({
              action: 'update',
              tableId: 'members',
              rowId: 'elm-pPat',
              data: { status: 'active' },
            }),
          )
        }
        return list(params)
      })
      expect((await nightlyCheck(services)).removed).toBe(0)
      expect(remove).not.toHaveBeenCalled()
      expect(userIds(services)).toContain('u9')
    })

    it('keeps someone who moved out, and removes someone who left on their own', async () => {
      const services = seeded({
        activity: [
          {
            $id: 'a1',
            $createdAt: '2026-10-01T00:00:00.000Z',
            at: '2026-10-01T00:00:00.000Z',
            groupId: 'elm',
            actorPersonId: 'pAlex',
            action: 'member.left',
            transactionId: null,
            summary: 'Member left',
            changesJson: null,
          },
        ],
        members: [
          member('elm', 'pSam'),
          member('elm', 'pAlex', {
            $createdAt: '2026-09-01T00:00:00.000Z',
            role: 'viewer',
            status: 'left',
            leftOn: '2026-10-01',
          }),
          member('elm', 'pPat', { status: 'placeholder' }),
          member('elm', 'pLee', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
        ],
      })
      expect((await nightlyCheck(services)).removed).toBe(1)
      expect(userIds(services)).toEqual(['u1', 'u3'])
    })

    it('leaves alone the membership of someone whose account is being deleted', async () => {
      // Pat's deletion is between its member transaction and its team step.
      const services = seeded(
        {
          persons: [
            person('pSam', 'u1'),
            person('pAlex', 'u2'),
            { ...person('pPat', 'u9'), deletedAt: '2026-10-18T19:00:00.000Z' },
            person('pLee', 'u3'),
          ],
        },
        { elm: ['u1', 'u2', 'u3', 'u9'] },
      )
      expect((await nightlyCheck(services)).removed).toBe(0)
      expect(userIds(services)).toContain('u9')
    })

    it('keeps one that any of the user’s persons keeps', async () => {
      // idx_userId isn't unique: a second person with the same user ID, read after the first.
      for (const [persons, team] of [
        // Alex's other person has no member row here.
        [
          [...PAT_SIGNED_UP, person('pAlex2', 'u2')],
          ['u1', 'u2', 'u3'],
        ],
        // One of Pat's persons is being deleted.
        [
          [{ ...person('pPat0', 'u9'), deletedAt: '2026-10-18T19:00:00.000Z' }, ...PAT_SIGNED_UP],
          ['u1', 'u2', 'u3', 'u9'],
        ],
      ] as const) {
        const services = seeded({ persons: [...persons] }, { elm: [...team] })
        expect((await nightlyCheck(services)).removed).toBe(0)
        expect(userIds(services)).toEqual(team)
      }
    })

    it('counts only the member rows in this group', async () => {
      // Pat joined Oak Rd, and is still a placeholder in Elm St.
      const services = seeded(
        { persons: PAT_SIGNED_UP, members: [...MEMBERS, member('oak', 'pPat')] },
        { elm: ['u1', 'u2', 'u3', 'u9'] },
      )
      expect((await nightlyCheck(services)).removed).toBe(1)
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3'])
    })

    it('puts a membership back when a join or a deletion lands while it is removed', async () => {
      for (const [tableId, rowId, data] of [
        // Pat's join commits just as the membership goes.
        ['members', 'elm-pPat', { status: 'active' }],
        // Or Pat's account deletion starts.
        ['persons', 'pPat', { deletedAt: '2026-10-18T20:00:00.000Z' }],
      ] as const) {
        const services = seeded({ persons: PAT_SIGNED_UP }, { elm: ['u1', 'u2', 'u3', 'u9'] })
        const remove = services.teams.deleteMembership.bind(services.teams)
        vi.spyOn(services.teams, 'deleteMembership').mockImplementation(async (params) => {
          await withTransaction(services.db, (tx) =>
            tx.write({ action: 'update', tableId, rowId, data }),
          )
          return (await remove(params)) as object
        })
        expect(await nightlyCheck(services)).toMatchObject({ removed: 0, findings: 0 })
        expect(userIds(services)).toContain('u9')
      }
    })

    it('reads every page of the team', async () => {
      const services = seeded()
      // 100 joins under way, then a stale membership past the first page.
      for (let index = 0; index < 100; index++) {
        await services.teams.createMembership({ teamId: 'elm', userId: `new${index}`, roles: [] })
      }
      vi.setSystemTime(new Date(NOW.getTime() - 2 * HOUR))
      await services.teams.createMembership({ teamId: 'elm', userId: 'u9', roles: [] })
      vi.setSystemTime(NOW)
      expect((await nightlyCheck(services)).removed).toBe(1)
      expect(userIds(services)).toHaveLength(103)
      expect(userIds(services)).not.toContain('u9')
    })

    it('counts a membership already gone as removed', async () => {
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const remove = services.teams.deleteMembership.bind(services.teams)
      // Another run removed it first, so this delete gets 404.
      vi.spyOn(services.teams, 'deleteMembership').mockImplementation(async (params) => {
        await remove(params)
        return (await remove(params)) as object
      })
      expect((await nightlyCheck(services)).removed).toBe(1)
    })

    it('counts the memberships it removed before a failure', async () => {
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u8', 'u9'] })
      const last = services.teams.members('elm')?.[4]?.$id
      const remove = services.teams.deleteMembership.bind(services.teams)
      vi.spyOn(services.teams, 'deleteMembership').mockImplementation(async (params) => {
        // u8's goes, then Teams fails on u9's.
        if (params.membershipId === last) {
          throw new AppwriteException('Server error', 500, 'general_unknown')
        }
        return (await remove(params)) as object
      })
      expect(await nightlyCheck(services)).toMatchObject({ checked: 0, removed: 1, failed: 1 })
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3', 'u9'])
    })

    it('leaves the stale memberships after the budget runs out for the next check', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u8', 'u9'] })
      const remove = vi.spyOn(services.teams, 'deleteMembership')
      // Out of time once u8's membership is removed.
      services.outOfTime = () => remove.mock.calls.length > 0
      expect(await nightlyCheck(services)).toMatchObject({ checked: 0, cutOff: 1, removed: 1 })
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3', 'u9'])
      expect(groupRow(services).nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
      expect(warn).toHaveBeenLastCalledWith(
        'scheduler: nightly check of group elm cut off by the budget',
      )
    })

    it('is never removed by a route that people call', async () => {
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const remove = vi.spyOn(services.teams, 'deleteMembership')
      const add = vi.spyOn(services.teams, 'createMembership')
      const body = {
        id: 'groceriesElm00000001',
        groupId: 'elm',
        kind: 'expense',
        description: 'Groceries',
        template: { totalCents: 6_000, split: { mode: 'equal', personIds: ['pSam', 'pAlex'] } },
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        startsOn: '2026-10-12',
        skipPublicHolidays: false,
        autoPost: false,
      }
      const { id, ...preview } = body
      const path = `/schedules/${id}`
      for (const [method, url, options] of [
        ['POST', '/schedules/preview', { body: preview }],
        ['POST', '/schedules', { body }],
        ['PATCH', path, { body: { ...body, description: 'Food' } }],
        ['POST', `${path}/end`, { body: { endsOn: '2026-10-31' } }],
        ['DELETE', path, {}],
      ] as const) {
        const { body: sent } = await call(services, method, url, options)
        expect([method, url, sent]).toMatchObject([method, url, { ok: true }])
      }
      expect(remove).not.toHaveBeenCalled()
      expect(add).not.toHaveBeenCalled()
    })
  })
})

describe('the team writes (teams.write)', () => {
  it('are reached by no route that people call', async () => {
    // Only step 6 writes to a team, and only the cron run calls step 6.
    const src = new URL('../src/', import.meta.url)
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) =>
      file.endsWith('.ts'),
    )
    const text = (file: string) => readFileSync(new URL(file, src), 'utf8')
    const writes =
      /\b(createMembership|deleteMembership|updateMembership|addToTeam|removeFromTeam|ensureTeam)\(/
    expect(files.filter((file) => writes.test(text(file)))).toEqual(['steps/nightly-check.ts'])
    expect(files.filter((file) => /from '[./]+(steps\/)?nightly-check'/.test(text(file)))).toEqual([
      'routes/run.ts',
    ])
    // And the cron route refuses a person, whatever the trigger says: u9's stale membership stays.
    const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
    const remove = vi.spyOn(services.teams, 'deleteMembership')
    expect((await call(services, 'POST', '/', { userId: 'u1', scheduled: true })).status).toBe(403)
    expect(remove).not.toHaveBeenCalled()
  })
})
