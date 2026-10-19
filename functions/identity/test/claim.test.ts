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

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

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

  it("skips a placeholder's identity, which would need a merge, and logs only that", async () => {
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
    expect(await claimed(services)).toEqual([])
    expect(warn.mock.calls).toEqual([['claim needs a merge; skipped']])
    expect(services.db.rows('identities')[1]).toMatchObject({
      personId: 'pOther',
      verified: false,
    })
    expect(statusOf(services, 'm1')).toBe('placeholder')
  })

  it('silently leaves an identity that belongs to another registered person', async () => {
    const services = claimFixture([], {
      persons: [{ $id: 'pOther', userId: 'u2', displayName: 'Alex', claimedAt: BEFORE }],
      identities: [{ $id: 'iPhone', key: 'phone:+61412345678', type: 'phone', personId: 'pOther' }],
    })
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    await claimed(services)
    expect(warn).not.toHaveBeenCalled()
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
    const services = fakes({ persons: [SAM], members: rows }, { teams })
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
