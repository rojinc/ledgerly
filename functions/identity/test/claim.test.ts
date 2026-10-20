import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AFTER,
  account,
  BEFORE,
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  NOW,
  ok,
  placeholderRow,
  TRY_AGAIN,
  updateRow,
} from './harness'

// Sam signed up on 10 October.
const CLAIMED_AT = '2026-10-10T00:00:00.000Z'
const SAM = {
  $id: 'pSam',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: CLAIMED_AT,
  mergedInto: null,
  deletedAt: null,
}
const VERIFIED_EMAIL = {
  $id: 'iEmail',
  key: 'email:sam@example.com',
  type: 'email',
  personId: 'pSam',
  verified: true,
  verifiedAt: CLAIMED_AT,
}

type Row = Record<string, unknown> & { $id: string }

function claimFixture(members: Row[], extra: { persons?: Row[]; identities?: Row[] } = {}) {
  return fakes(
    {
      persons: [SAM, ...(extra.persons ?? [])],
      identities: [VERIFIED_EMAIL, ...(extra.identities ?? [])],
      // Their rows, for the guard a merge writes on each group.
      groups: ['g1', 'g2', 'g3'].map((id) => ({
        $id: id,
        type: 'house',
        name: 'Flat',
        rev: 'r0',
        settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"equal"}',
      })),
      members,
    },
    { teams: { g1: ['uAdmin'], g2: ['uAdmin'], g3: ['uAdmin'] } },
  )
}

function statusOf(services: Fakes, memberId: string) {
  return services.db.rows('members').find((row) => row.$id === memberId)?.status
}

function teamUsers(services: Fakes, groupId: string) {
  return services.teams.members(groupId)?.map((membership) => membership.userId)
}

async function claimed(services: Fakes) {
  return (await ok<{ linkedGroupIds: string[] }>(services, 'POST', '/claim')).linkedGroupIds
}

// Every line written, with its level (log.ts LEVELS): a claim warns, a finished merge logs.
let logged: Array<{ level: string; line: string }>
beforeEach(() => {
  logged = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      logged.push({ level, line: String(line) })
    })
  }
})
afterEach(() => {
  // No personal data in logs: no email, phone number or name.
  for (const { line } of logged) expect(line).not.toMatch(/@|\d{6,}|Sam Lee/)
  vi.restoreAllMocks()
})
// The logProblem lines written at a level, without `fn`.
const lines = (level: string) =>
  logged
    .filter((written) => written.level === level)
    .map(({ line }) => {
      const { fn: _fn, ...event } = JSON.parse(line) as Record<string, unknown>
      return event
    })

describe('POST /claim', () => {
  it('joins only placeholder rows added strictly before claimedAt', async () => {
    const services = claimFixture([
      placeholderRow('m1', 'g1', 'pSam', BEFORE),
      placeholderRow('m2', 'g2', 'pSam', CLAIMED_AT),
      placeholderRow('m3', 'g3', 'pSam', AFTER),
    ])
    expect(await claimed(services)).toEqual(['g1'])
    expect(['m1', 'm2', 'm3'].map((id) => statusOf(services, id))).toEqual([
      'active',
      'placeholder',
      'placeholder',
    ])
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
    expect(teamUsers(services, 'g2')).toEqual(['uAdmin'])
    expect(teamUsers(services, 'g3')).toEqual(['uAdmin'])
    // A repeated claim finds nothing more to do.
    expect(await claimed(services)).toEqual([])
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('sets left, not active, for someone who moved out before joining, and leaves joined rows alone', async () => {
    const services = claimFixture([
      placeholderRow('m1', 'g1', 'pSam', BEFORE, { leftOn: '2026-09-30' }),
      placeholderRow('m2', 'g2', 'pSam', BEFORE, { status: 'left', leftOn: '2026-09-30' }),
      placeholderRow('m3', 'g3', 'pSam', BEFORE, { status: 'active' }),
    ])
    expect(await claimed(services)).toEqual(['g1'])
    expect(['m1', 'm2', 'm3'].map((id) => statusOf(services, id))).toEqual([
      'left',
      'left',
      'active',
    ])
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('creates an identity row for a newly verified phone, and verifies its own unverified rows', async () => {
    const services = claimFixture([], {
      identities: [
        {
          $id: 'iOld',
          key: 'phone:+61400000000',
          type: 'phone',
          personId: 'pSam',
          verified: false,
          verifiedAt: null,
        },
      ],
    })
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    await claimed(services)
    expect(services.db.rows('identities')).toEqual([
      expect.objectContaining({ $id: 'iEmail', verified: true, verifiedAt: CLAIMED_AT }),
      expect.objectContaining({ $id: 'iOld', verified: false }), // not verified in Appwrite
      expect.objectContaining({
        key: 'phone:+61412345678',
        type: 'phone',
        personId: 'pSam',
        verified: true,
        verifiedAt: NOW.toISOString(),
        $permissions: [],
      }),
    ])

    services.users.get = async () => account({ phone: '+61400000000', phoneVerification: true })
    await claimed(services)
    expect(services.db.rows('identities')[1]).toMatchObject({
      $id: 'iOld',
      verified: true,
      verifiedAt: NOW.toISOString(),
    })
  })

  it('merges a placeholder whose identity the caller verified, logging IDs and counts only', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pOther', BEFORE)], {
      persons: [{ $id: 'pOther', userId: null, displayName: 'Sam', claimedAt: null }],
      identities: [
        {
          $id: 'iPhone',
          key: 'phone:+61412345678',
          type: 'phone',
          personId: 'pOther',
          verified: false,
        },
      ],
    })
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    expect(await claimed(services)).toEqual(['g1'])
    const other = services.db.rows('persons').find((row) => row.$id === 'pOther')
    expect(other).toMatchObject({ userId: null, mergedInto: 'pSam' })
    // The merge moved the identity, and the claim then verified it for Sam.
    expect(services.db.rows('identities')[1]).toMatchObject({ personId: 'pSam', verified: true })
    expect(services.db.rows('members')).toEqual([
      expect.objectContaining({ $id: 'm1', personId: 'pSam', status: 'active' }),
    ])
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
    expect(lines('warn')).toEqual([])
    expect(lines('log')).toHaveLength(1)
    // Finished: the next claim leaves P alone.
    expect(await claimed(services)).toEqual([])
    expect(lines('log')).toHaveLength(1)
  })

  it('silently leaves an identity that belongs to another registered person', async () => {
    const services = claimFixture([], {
      persons: [{ $id: 'pOther', userId: 'u2', displayName: 'Alex', claimedAt: BEFORE }],
      identities: [{ $id: 'iPhone', key: 'phone:+61412345678', type: 'phone', personId: 'pOther' }],
    })
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    await claimed(services)
    expect(logged).toEqual([])
    expect(services.db.rows('identities')[1]).toMatchObject({ personId: 'pOther' })
  })

  it('finishes when another claim creates the same identity key first', async () => {
    const services = claimFixture([])
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    beforeStaging(
      services.db,
      (operations) => operations.includes('phone:+61412345678'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({
            action: 'create',
            tableId: 'identities',
            rowId: 'iRace',
            data: { key: 'phone:+61412345678', type: 'phone', personId: 'pSam', verified: false },
          }),
        ),
    )
    await claimed(services)
    expect(services.db.rows('identities')).toEqual([
      expect.objectContaining({ $id: 'iEmail' }),
      expect.objectContaining({ $id: 'iRace', verified: true, verifiedAt: NOW.toISOString() }),
    ])
  })

  it('says CONFLICT, try again, when an identity write still conflicts after looking again', async () => {
    const services = claimFixture([])
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    const commit = services.db.updateTransaction.bind(services.db)
    const commits = vi
      .spyOn(services.db, 'updateTransaction')
      .mockImplementation(async (params) => {
        if (params.commit) throw new AppwriteException('Conflict', 409, 'transaction_conflict')
        return commit(params)
      })
    expect(await failure(services, 'POST', '/claim')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(2)
    expect(services.db.rows('identities')).toHaveLength(1)
  })

  it('says CONFLICT, try again, when the row changes after its join is staged, and a retry joins', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    beforeCommit(services.db, () =>
      updateRow(services.db, 'members', 'm1', { displayName: 'Sam L' }),
    )
    expect(await failure(services, 'POST', '/claim')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(statusOf(services, 'm1')).toBe('placeholder')
    expect(services.db.rows('activity')).toEqual([])
    // Not joined, so the team membership from step 1 is taken back, even with no retry.
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(await claimed(services)).toEqual(['g1'])
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({ subjectPersonId: 'pSam', summary: 'joined' }),
    ])
  })

  // #322: an account deletion purging a group deletes its team first and its rows last.
  it('skips a row whose team is gone, a group being purged, and joins the others', async () => {
    const services = claimFixture([
      placeholderRow('m1', 'g1', 'pSam', BEFORE),
      // Listed first, so the claim must go on past it.
      placeholderRow('m9', 'g9', 'pSam', '2026-09-01T00:00:00.000Z'),
    ])
    expect(await claimed(services)).toEqual(['g1'])
    expect(statusOf(services, 'm9')).toBe('placeholder')
    expect(services.db.rows('activity').map((row) => row.groupId)).toEqual(['g1'])
  })

  it('leaves out a group whose team goes just after its row joined', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    const add = services.teams.createMembership.bind(services.teams)
    let calls = 0
    vi.spyOn(services.teams, 'createMembership').mockImplementation(async (params) => {
      calls += 1
      if (calls === 2) throw new AppwriteException('Team not found', 404, 'team_not_found')
      return (await add(params)) as never
    })
    expect(await claimed(services)).toEqual([])
    expect(calls).toBe(2)
    // Joined already: the purge deletes the row with the others.
    expect(statusOf(services, 'm1')).toBe('active')
  })

  // #429: a group delete's step 2 sets `deletingAt`, its point of no return, before the team goes.
  describe('a group being deleted', () => {
    const deleting = (services: Fakes, groupId: string) =>
      updateRow(services.db, 'groups', groupId, {
        deletingAt: NOW.toISOString(),
        deletingBy: 'pAdmin',
      })
    const groupRow = (services: Fakes, groupId: string) =>
      services.db.rows('groups').find((row) => row.$id === groupId)

    it('is skipped as for a team that’s gone, writing nothing there, and the others join', async () => {
      const services = claimFixture([
        placeholderRow('m1', 'g1', 'pSam', BEFORE),
        // Listed first, so the claim must go on past it.
        placeholderRow('m2', 'g2', 'pSam', '2026-09-01T00:00:00.000Z'),
      ])
      await deleting(services, 'g2')
      const before = groupRow(services, 'g2')
      expect(await claimed(services)).toEqual(['g1'])
      expect(statusOf(services, 'm2')).toBe('placeholder')
      // Step 1's team add is taken back.
      expect(teamUsers(services, 'g2')).toEqual(['uAdmin'])
      expect(services.db.rows('activity').map((row) => row.groupId)).toEqual(['g1'])
      expect(groupRow(services, 'g2')).toEqual(before)
    })

    it('is skipped when the delete passes its point of no return after the team add', async () => {
      const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
      let team: string[] | undefined
      beforeStaging(
        services.db,
        (operations) => operations.includes('"tableId":"groups"'),
        async () => {
          team = teamUsers(services, 'g1')
          await deleting(services, 'g1')
        },
      )
      expect(await claimed(services)).toEqual([])
      expect(team).toEqual(['uAdmin', 'u1'])
      expect(statusOf(services, 'm1')).toBe('placeholder')
      expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
      expect(services.db.rows('activity')).toEqual([])
    })

    it('counts a group row gone by the check as being deleted: a purge deletes it last', async () => {
      const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
      const stage = services.db.createOperations.bind(services.db)
      let done = false
      vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
        const staged = await stage(params)
        // Just after the join staged its guard.
        if (!done && JSON.stringify(params.operations).includes('"tableId":"groups"')) {
          done = true
          await withTransaction(services.db, (tx) =>
            tx.write({ action: 'delete', tableId: 'groups', rowId: 'g1' }),
          )
        }
        return staged
      })
      expect(await claimed(services)).toEqual([])
      expect(statusOf(services, 'm1')).toBe('placeholder')
      expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    })

    it('fails its commit when the delete lands after the check, and a retry skips it', async () => {
      const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
      beforeCommit(services.db, () => deleting(services, 'g1'))
      expect(await failure(services, 'POST', '/claim')).toEqual({
        status: 409,
        code: 'CONFLICT',
        message: TRY_AGAIN,
      })
      expect(statusOf(services, 'm1')).toBe('placeholder')
      expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
      expect(services.db.rows('activity')).toEqual([])
      expect(await claimed(services)).toEqual([])
      expect(statusOf(services, 'm1')).toBe('placeholder')
      expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    })

    it('fails the commit of a delete staged before the join, since the join writes the group’s rev', async () => {
      const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
      let linked: string[] | undefined
      await expect(
        withTransaction(services.db, async (tx) => {
          // A delete's step 2, staged and checked, while the join runs and commits.
          await tx.write({
            action: 'update',
            tableId: 'groups',
            rowId: 'g1',
            data: { deletingAt: NOW.toISOString(), deletingBy: 'pAdmin', rev: 'rDelete' },
          })
          linked = await claimed(services)
        }),
      ).rejects.toMatchObject({ code: 409 })
      expect(linked).toEqual(['g1'])
      expect(statusOf(services, 'm1')).toBe('active')
      expect(groupRow(services, 'g1')?.rev).not.toBe('r0')
      expect(groupRow(services, 'g1')?.deletingAt ?? null).toBeNull()
    })

    it('gives the group a fresh rev on every join, so each is a real change (AI E on #449)', async () => {
      const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
      expect(await claimed(services)).toEqual(['g1'])
      const first = groupRow(services, 'g1')?.rev
      // A second join in the same group: the row pending again (the team add counts as done).
      await updateRow(services.db, 'members', 'm1', { status: 'placeholder' })
      expect(await claimed(services)).toEqual(['g1'])
      expect(new Set(['r0', first, groupRow(services, 'g1')?.rev]).size).toBe(3)
    })
  })

  it('still fails the claim for any other team error', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    vi.spyOn(services.teams, 'createMembership').mockRejectedValue(
      // Another 404, so only `team_not_found` counts as a purge.
      new AppwriteException('User not found', 404, 'user_not_found'),
    )
    expect((await call(services, 'POST', '/claim')).status).toBe(500)
    expect(statusOf(services, 'm1')).toBe('placeholder')
  })

  it('takes back the team membership when an admin removed the row meanwhile', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () =>
        withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'members', rowId: 'm1' }),
        ),
    )
    expect(await claimed(services)).toEqual([])
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(services.db.rows('activity')).toEqual([])
  })

  it('takes back the team membership when the row moved to another person meanwhile', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () => updateRow(services.db, 'members', 'm1', { personId: 'pElse' }),
    )
    expect(await claimed(services)).toEqual([])
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
    expect(services.db.rows('members')[0]).toMatchObject({
      personId: 'pElse',
      status: 'placeholder',
    })
    expect(services.db.rows('activity')).toEqual([])
  })

  it('writes one member.joined when a claim running at the same time joined first', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    let other: string[] | undefined
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      async () => {
        other = await claimed(services)
      },
    )
    expect(await claimed(services)).toEqual([])
    expect(other).toEqual(['g1'])
    expect(statusOf(services, 'm1')).toBe('active')
    expect(services.db.rows('activity')).toHaveLength(1)
    expect(teamUsers(services, 'g1')).toEqual(['uAdmin', 'u1'])
  })

  it('uses the stored leftOn when it changed after the row was listed', async () => {
    const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"members"'),
      () => updateRow(services.db, 'members', 'm1', { leftOn: '2026-10-05' }),
    )
    expect(await claimed(services)).toEqual(['g1'])
    expect(statusOf(services, 'm1')).toBe('left')
  })

  it('pages through more than one page of pending rows', async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      placeholderRow(`m${index}`, `g${index}`, 'pSam', BEFORE),
    )
    const teams = Object.fromEntries(rows.map((row) => [row.groupId, []]))
    const groups = rows.map((row) => ({ $id: row.groupId, type: 'house', name: 'Flat', rev: 'r0' }))
    const services = fakes({ persons: [SAM], groups, members: rows }, { teams })
    const linked = await claimed(services)
    expect(linked).toHaveLength(101)
    expect(new Set(linked).size).toBe(101)
  })

  it('is NOT_FOUND for a deleted account, whose person is never resolved from its userId', async () => {
    const deleted = {
      $id: 'p1',
      userId: 'u1',
      displayName: 'Former member',
      claimedAt: BEFORE,
      mergedInto: null,
      deletedAt: BEFORE,
    }
    expect((await failure(fakes({ persons: [deleted] }), 'POST', '/claim')).code).toBe('NOT_FOUND')
  })

  describe('when the deletion passes its point of no return after the lookup', () => {
    const setUpFirst = { status: 404, code: 'NOT_FOUND', message: 'Set up your account first.' }
    const deletion = (services: Fakes) => () =>
      updateRow(services.db, 'persons', 'pSam', { deletedAt: AFTER })

    function withNewPhone() {
      const services = claimFixture([])
      services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
      return services
    }

    it('creates no identity row, before it is staged', async () => {
      const services = withNewPhone()
      beforeStaging(
        services.db,
        (operations) => operations.includes('phone:+61412345678'),
        deletion(services),
      )
      expect(await failure(services, 'POST', '/claim')).toEqual(setUpFirst)
      expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iEmail'])
    })

    it('creates no identity row, after it is staged', async () => {
      const services = withNewPhone()
      beforeCommit(services.db, deletion(services))
      expect(await failure(services, 'POST', '/claim')).toEqual(setUpFirst)
      expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iEmail'])
    })

    it('leaves an identity row unverified', async () => {
      const services = claimFixture([], {
        identities: [
          {
            $id: 'iPhone',
            key: 'phone:+61412345678',
            type: 'phone',
            personId: 'pSam',
            verified: false,
            verifiedAt: null,
          },
        ],
      })
      services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
      beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"iPhone"'),
        deletion(services),
      )
      expect(await failure(services, 'POST', '/claim')).toEqual(setUpFirst)
      expect(services.db.rows('identities')[1]).toMatchObject({ verified: false, verifiedAt: null })
    })

    it('joins nothing, and takes back the team membership', async () => {
      const services = claimFixture([placeholderRow('m1', 'g1', 'pSam', BEFORE)])
      beforeStaging(
        services.db,
        (operations) => operations.includes('"tableId":"members"'),
        deletion(services),
      )
      expect(await failure(services, 'POST', '/claim')).toEqual(setUpFirst)
      expect(statusOf(services, 'm1')).toBe('placeholder')
      expect(teamUsers(services, 'g1')).toEqual(['uAdmin'])
      expect(services.db.rows('activity')).toEqual([])
    })
  })

  it('is NOT_FOUND before bootstrap', async () => {
    expect(await failure(fakes(), 'POST', '/claim')).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Set up your account first.',
    })
  })

  it('is VALIDATION_FAILED with a body, and UNAUTHENTICATED without a JWT', async () => {
    const services = claimFixture([])
    expect(await failure(services, 'POST', '/claim', { email: 'x@example.com' })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect((await call(services, 'POST', '/claim', {})).status).toBe(200)
    expect(await failure(services, 'POST', '/claim', undefined, null)).toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })
})
