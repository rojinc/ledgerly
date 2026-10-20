import type { Members } from '@ledgerly/core/generated/rows'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
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
  TODAY,
  TRY_AGAIN,
  updateRow,
} from './harness'

// A registered person (user u9) who is in no group yet, known by email and phone.
const REGISTERED_EMAIL = {
  $id: 'iEmail9',
  key: 'email:reg@example.com',
  type: 'email',
  personId: 'p9',
  verified: true,
  verifiedAt: NOW.toISOString(),
}

/** House g1: u1 admin, u2 member, u3 viewer (all joined), u4 added but not joined. */
function house(extra: object = {}) {
  return fakes(
    {
      groups: [group('g1', 'house', extra)],
      persons: [person(1), person(2), person(3), person(4), person(9)],
      identities: [REGISTERED_EMAIL],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active'),
        member('m3', 'g1', 'p3', 'viewer', 'active'),
        member('m4', 'g1', 'p4', 'member', 'placeholder'),
      ],
    },
    { g1: ['u1', 'u2', 'u3'] },
  )
}

/** Houses g1 (u1 admin) and g2 (u2 admin), with nobody else. */
function houses() {
  return fakes(
    {
      groups: [group('g1', 'house'), group('g2', 'house')],
      persons: [person(1), person(2)],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g2', 'p2', 'admin', 'active'),
      ],
    },
    { g1: ['u1'], g2: ['u2'] },
  )
}

function add(services: Fakes, body: object, userId = 'u1') {
  return ok<Members>(services, 'POST', '/groups/g1/members', body, userId)
}

function addFails(services: Fakes, body: object, userId: string | null = 'u1') {
  return failure(services, 'POST', '/groups/g1/members', body, userId)
}

// What a caller sees of a new row, apart from the IDs and timestamps every row has.
function visible(row: Members) {
  const { $id, personId, $createdAt, $updatedAt, $sequence, ...rest } = row
  return { keys: Object.keys(row).sort(), rest }
}

describe('POST /groups/{id}/members', () => {
  it('adds someone unknown as a placeholder, with a new person and one unverified identity', async () => {
    const services = house()
    const row = await add(services, {
      displayName: ' Sam ',
      email: 'Sam@Example.com',
      phone: '0412 345 678',
    })
    expect(row).toMatchObject({
      groupId: 'g1',
      displayName: 'Sam',
      role: 'member',
      status: 'placeholder',
      joinedOn: TODAY,
      leftOn: null,
      $permissions: ['read("team:g1")'],
    })
    expect(services.db.rows('persons').at(-1)).toMatchObject({
      $id: row.personId,
      displayName: 'Sam',
      $permissions: [],
    })
    // One key: the email, as it was given. The phone isn't stored (#252).
    expect(services.db.rows('identities').slice(1)).toEqual([
      expect.objectContaining({
        key: 'email:sam@example.com',
        personId: row.personId,
        verified: false,
        $permissions: [],
      }),
    ])
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2', 'u3'])
  })

  it('writes member.added about the person, never naming them or their email or phone', async () => {
    const services = house()
    const row = await add(services, {
      displayName: 'Sam',
      email: 'sam@example.com',
      phone: '0412345678',
    })
    const [activity] = services.db.rows('activity')
    expect(activity).toMatchObject({
      groupId: 'g1',
      actorPersonId: 'p1',
      action: 'member.added',
      subjectPersonId: row.personId,
      summary: 'was added as a member',
      at: NOW.toISOString(),
      $permissions: ['read("team:g1")'],
    })
    // Only the text fields can carry them; $id and $createdAt are random, so leave them out.
    const text = `${activity?.summary} ${activity?.changesJson ?? ''}`
    expect(text).not.toMatch(/Sam|example\.com|412\s?345\s?678/)
  })

  it('adds a registered person as a placeholder, outside the team, looking like anyone else', async () => {
    const services = house()
    const registered = await add(services, { displayName: 'Robin', email: 'reg@example.com' })
    expect(registered).toMatchObject({ personId: 'p9', status: 'placeholder' })
    expect(services.teams.members('g1')?.map((m) => m.userId)).not.toContain('u9')
    // The row is about the person found, not the one adding them (data-model.md#activity).
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({ action: 'member.added', subjectPersonId: 'p9' }),
    ])

    const unknown = await add(services, { displayName: 'Robin', email: 'new@example.com' })
    expect(unknown.personId).not.toBe('p9')
    expect(visible(registered)).toEqual(visible(unknown))
  })

  it('uses the found person and never attaches the other, unverified key to them', async () => {
    const services = house()
    const row = await add(services, {
      displayName: 'Robin',
      email: 'reg@example.com',
      phone: '0412345678',
    })
    expect(row.personId).toBe('p9')
    expect(services.db.rows('identities')).toHaveLength(1)
    expect(services.db.rows('persons')).toHaveLength(5)
  })

  it('keeps one key for a new placeholder, so the other key can’t claim what’s added later', async () => {
    const services = houses()
    // A types an email they control beside someone else's phone (#252, H1).
    const typed = await ok<Members>(
      services,
      'POST',
      '/groups/g1/members',
      { displayName: 'Vic', email: 'a2@example.com', phone: '0412345678' },
      'u1',
    )
    // Another group adds the phone's owner: a new placeholder, which only they can claim.
    const owner = await ok<Members>(
      services,
      'POST',
      '/groups/g2/members',
      { displayName: 'Vic', phone: '0412 345 678' },
      'u2',
    )
    expect(owner.personId).not.toBe(typed.personId)
    expect(services.db.rows('identities')).toEqual([
      expect.objectContaining({ key: 'email:a2@example.com', personId: typed.personId }),
      expect.objectContaining({ key: 'phone:+61412345678', personId: owner.personId }),
    ])
  })

  it('answers CONFLICT when a claim of the person found commits while the add commits', async () => {
    const services = houses()
    const sam = await ok<Members>(
      services,
      'POST',
      '/groups/g1/members',
      { displayName: 'Sam', email: 'sam@example.com' },
      'u1',
    )
    // Adopting a placeholder writes its row (identity-and-invites.md#claim).
    beforeCommit(services.db, () =>
      updateRow(services.db, 'persons', sam.personId, { userId: 'u7' }),
    )
    const body = { displayName: 'Sam', email: 'sam@example.com' }
    expect(await failure(services, 'POST', '/groups/g2/members', body, 'u2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('members')).toHaveLength(3)
  })

  it('answers CONFLICT when a merge moved the key just before the add guarded the person', async () => {
    const services = houses()
    const sam = await ok<Members>(
      services,
      'POST',
      '/groups/g1/members',
      { displayName: 'Sam', email: 'sam@example.com' },
      'u1',
    )
    const key = services.db.rows('identities')[0]
    // Person p1 verified sam@example.com and merged Sam's placeholder into themselves.
    beforeStaging(services.db, 1, () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'persons', rowId: sam.personId, data: { mergedInto: 'p1' } },
          {
            action: 'update',
            tableId: 'identities',
            rowId: key?.$id as string,
            data: { personId: 'p1', verified: true },
          },
        ),
      ),
    )
    const body = { displayName: 'Sam', email: 'sam@example.com' }
    expect(await failure(services, 'POST', '/groups/g2/members', body, 'u2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // Tried again, the key belongs to p1 now.
    expect((await ok<Members>(services, 'POST', '/groups/g2/members', body, 'u2')).personId).toBe(
      'p1',
    )
  })

  it('answers CONFLICT when merge step 1 marked the person just before the add guarded them', async () => {
    const services = houses()
    const sam = await ok<Members>(
      services,
      'POST',
      '/groups/g1/members',
      { displayName: 'Sam', email: 'sam@example.com' },
      'u1',
    )
    // Person p1 verified sam@example.com and marked Sam's placeholder as merged into themselves
    // (step 1). The key is still Sam's: identities move last.
    beforeStaging(services.db, 1, () =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'persons',
          rowId: sam.personId,
          data: { mergedInto: 'p1' },
        }),
      ),
    )
    const body = { displayName: 'Sam', email: 'sam@example.com' }
    expect(await failure(services, 'POST', '/groups/g2/members', body, 'u2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // Tried again, resolving follows mergedInto: the add lands on p1, not on Sam's placeholder.
    expect((await ok<Members>(services, 'POST', '/groups/g2/members', body, 'u2')).personId).toBe(
      'p1',
    )
  })

  it('answers CONFLICT when a claim took the key just before the add guarded the person', async () => {
    const services = houses()
    const sam = await ok<Members>(
      services,
      'POST',
      '/groups/g1/members',
      { displayName: 'Sam', email: 'sam@example.com' },
      'u1',
    )
    const key = services.db.rows('identities')[0]
    // Someone who never verified sam@example.com adopts Sam's placeholder, so the key goes
    // (#252); it commits after g2's add read the key, before it staged its guard.
    beforeStaging(services.db, 1, () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'persons', rowId: sam.personId, data: { userId: 'u7' } },
          { action: 'delete', tableId: 'identities', rowId: key?.$id as string },
        ),
      ),
    )
    const body = { displayName: 'Sam', email: 'sam@example.com' }
    expect(await failure(services, 'POST', '/groups/g2/members', body, 'u2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // Tried again, the key belongs to nobody now: a new placeholder, not the claimer.
    const again = await ok<Members>(services, 'POST', '/groups/g2/members', body, 'u2')
    expect(again.personId).not.toBe(sam.personId)
  })

  it('takes the role and joinedOn given', async () => {
    const services = house()
    const row = await add(services, { displayName: 'Sam', role: 'viewer', joinedOn: '2026-08-01' })
    expect(row).toMatchObject({ role: 'viewer', joinedOn: '2026-08-01' })
    expect(services.db.rows('activity')[0]?.summary).toBe('was added as a viewer')
  })

  it('joinedOn defaults to today in the group time zone', async () => {
    const services = house({ timezone: 'UTC' })
    const row = await add(services, { displayName: 'Sam' })
    expect(row.joinedOn).toBe('2026-10-18')
  })

  it('refuses someone already in the group, joined or not', async () => {
    const services = house()
    await add(services, { displayName: 'Robin', email: 'reg@example.com' })
    expect(await addFails(services, { displayName: 'Robin', email: 'REG@example.com' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'This person is already in the group.',
    })
    expect(services.db.rows('members')).toHaveLength(5)
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('answers CONFLICT when another request adds the same person first', async () => {
    const services = house()
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'create',
          tableId: 'members',
          rowId: 'mRace',
          data: {
            groupId: 'g1',
            personId: 'p9',
            displayName: 'R',
            role: 'member',
            status: 'placeholder',
            joinedOn: TODAY,
          },
        }),
      ),
    )
    expect(await addFails(services, { displayName: 'Robin', email: 'reg@example.com' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(services.db.rows('activity')).toHaveLength(0)
  })

  it('lets a house member add a member, but not choose another role', async () => {
    const services = house()
    expect(await add(services, { displayName: 'Sam' }, 'u2')).toMatchObject({ role: 'member' })
    expect(await add(services, { displayName: 'Alex', role: 'member' }, 'u2')).toMatchObject({
      role: 'member',
    })
    for (const role of ['admin', 'viewer']) {
      expect(await addFails(services, { displayName: 'Kim', role }, 'u2')).toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      })
    }
  })

  it('refuses a viewer', async () => {
    expect(await addFails(house(), { displayName: 'Sam' }, 'u3')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it('refuses a third member in employer and pair groups, and anyone in a personal group', async () => {
    for (const type of ['employer', 'pair', 'personal']) {
      const services = fakes({
        groups: [group('g1', type)],
        persons: [person(1), person(2)],
        members: [
          member('m1', 'g1', 'p1', 'admin', 'active'),
          member('m2', 'g1', 'p2', 'member', 'active'),
        ],
      })
      expect(await addFails(services, { displayName: 'Sam' })).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      })
      // A member there isn't allowed to add anyone at all.
      expect(await addFails(services, { displayName: 'Sam' }, 'u2')).toMatchObject({
        code: 'FORBIDDEN',
      })
      expect(services.db.rows('members')).toHaveLength(2)
    }
  })

  it('refuses someone who is not a member, or has not joined', async () => {
    const services = house()
    for (const userId of ['u9', 'u4', 'uNobody']) {
      expect(await addFails(services, { displayName: 'Sam' }, userId)).toMatchObject({
        status: 403,
        code: 'NOT_A_MEMBER',
      })
    }
  })

  it('refuses a request without a login', async () => {
    expect(await addFails(house(), { displayName: 'Sam' }, null)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
  })

  it('refuses an archived group', async () => {
    const services = house({ archivedAt: NOW.toISOString() })
    expect(await addFails(services, { displayName: 'Sam' })).toMatchObject({
      status: 409,
      code: 'ARCHIVED',
    })
  })

  it('refuses an invalid email or phone, and a userId in the body, writing nothing', async () => {
    const services = fakes({
      groups: [group('g1', 'house')],
      persons: [person(1), placeholder('pX')],
      members: [member('m1', 'g1', 'p1', 'admin', 'active')],
    })
    const bodies = [
      { displayName: 'Sam', email: 'not-an-email' },
      { displayName: 'Sam', phone: '123' },
      { displayName: 'Sam', userId: 'u9' },
      { displayName: '' },
    ]
    for (const body of bodies) {
      expect(await addFails(services, body)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      })
    }
    expect(await addFails(services, { displayName: 'Sam', phone: '123' })).toMatchObject({
      message: 'Not a valid phone number',
    })
    expect(services.db.rows('members')).toHaveLength(1)
    expect(services.db.rows('persons')).toHaveLength(2)
    expect(services.db.rows('identities')).toHaveLength(0)
  })
})

// #378 (identity-and-invites.md#adding-someone-to-a-group, step 2): an add with both an email and
// a phone is counted on the caller's own persons row before either key is looked up, with invites'
// and reminders' address checks (ADDRESS_MISS_LIMIT, 10 in 24 hours), and the count comes back
// only when both keys find the same existing person.
describe('POST /groups/{id}/members with both an email and a phone (#378)', () => {
  const HOUR = 60 * 60 * 1000
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
  // p9's phone, beside REGISTERED_EMAIL.
  const REGISTERED_PHONE = {
    $id: 'iPhone9',
    key: 'phone:+61412345678',
    type: 'phone',
    personId: 'p9',
    verified: true,
    verifiedAt: NOW.toISOString(),
  }
  // Another registered person's phone (p8).
  const OTHER_PHONE = {
    ...REGISTERED_PHONE,
    $id: 'iPhone8',
    key: 'phone:+61498765432',
    personId: 'p8',
  }

  /** House g1 with u1 as admin, whose row holds `counted` checks in a window from an hour ago. */
  function counted(counted = 0) {
    const misses = counted > 0 ? { addressMisses: counted, addressMissesFrom: ago(HOUR) } : {}
    return fakes(
      {
        groups: [group('g1', 'house')],
        persons: [person(1, misses), person(8), person(9)],
        identities: [REGISTERED_EMAIL, REGISTERED_PHONE, OTHER_PHONE],
        members: [member('m1', 'g1', 'p1', 'admin', 'active')],
      },
      { g1: ['u1'] },
    )
  }
  const caller = (services: Fakes) => services.db.rows('persons').find((row) => row.$id === 'p1')
  const misses = (services: Fakes) => caller(services)?.addressMisses ?? 0

  it('counts the check before looking either key up', async () => {
    const services = counted()
    await add(services, { displayName: 'New', email: 'new@example.com', phone: '0400 000 001' })
    expect(caller(services)).toMatchObject({
      addressMisses: 1,
      addressMissesFrom: NOW.toISOString(),
    })
  })

  it.each([
    ['an email alone', { email: 'new@example.com' }],
    ['a phone alone', { phone: '0400 000 001' }],
    ['a name alone', {}],
  ])('doesn’t count %s', async (_case, keys) => {
    const services = counted()
    await add(services, { displayName: 'New', ...keys })
    expect(misses(services)).toBe(0)
  })

  it('takes the count back when both keys find the same existing person', async () => {
    const services = counted(3)
    const row = await add(services, {
      displayName: 'Reg',
      email: 'reg@example.com',
      phone: '0412 345 678',
    })
    expect(row).toMatchObject({ status: 'placeholder' })
    expect(caller(services)).toMatchObject({ addressMisses: 3, addressMissesFrom: ago(HOUR) })
  })

  it.each([
    ['both keys find nobody', { email: 'new@example.com', phone: '0400 000 001' }],
    [
      'the email finds someone and the phone nobody',
      { email: 'reg@example.com', phone: '0400 000 001' },
    ],
    [
      'the phone finds someone and the email nobody',
      { email: 'new@example.com', phone: '0412 345 678' },
    ],
    ['they find two different persons', { email: 'reg@example.com', phone: '0498 765 432' }],
  ])('keeps the count when %s', async (_case, keys) => {
    const services = counted(3)
    await add(services, { displayName: 'Someone', ...keys })
    expect(misses(services)).toBe(4)
  })

  it('keeps the count when the add is refused after it, even for the same existing person', async () => {
    const services = counted(3)
    const keys = { email: 'reg@example.com', phone: '0412 345 678' }
    await add(services, { displayName: 'Reg', ...keys })
    // p9 is in the group now: CONFLICT, after the count.
    expect(await addFails(services, { displayName: 'Reg again', ...keys })).toMatchObject({
      code: 'CONFLICT',
    })
    expect(misses(services)).toBe(4)
  })

  it.each([
    ['a known email', 'reg@example.com'],
    ['an unknown one', 'new@example.com'],
  ])(
    'answers RATE_LIMITED at the limit for %s, before any lookup, writing nothing',
    async (_case, email) => {
      const services = counted(10)
      const list = vi.spyOn(services.db, 'listRows')
      const before = structuredClone([
        services.db.rows('members'),
        services.db.rows('persons'),
        services.db.rows('identities'),
      ])
      expect(
        await addFails(services, { displayName: 'Guess', email, phone: '0412 345 678' }),
      ).toMatchObject({ code: 'RATE_LIMITED' })
      // Neither key was looked up.
      expect(list.mock.calls.map(([params]) => params.tableId)).not.toContain('identities')
      expect([
        services.db.rows('members'),
        services.db.rows('persons'),
        services.db.rows('identities'),
      ]).toEqual(before)
    },
  )

  it('still adds with one key at the limit', async () => {
    const services = counted(10)
    await add(services, { displayName: 'New', email: 'new@example.com' })
    expect(misses(services)).toBe(10)
  })

  it('fails, keeping the count, when another check commits after its guard', async () => {
    const services = counted(3)
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // The first commit is the count's; the second is the add's.
      if (params.commit && ++commits === 2) {
        await updateRow(services.db, 'persons', 'p1', { addressMisses: 5 })
      }
      return commit(params)
    })
    const keys = { email: 'reg@example.com', phone: '0412 345 678' }
    expect(await addFails(services, { displayName: 'Reg', ...keys })).toMatchObject({
      code: 'CONFLICT',
    })
    expect(misses(services)).toBe(5)
  })

  it('answers CONFLICT after the count clashes twice, with no key looked up', async () => {
    const services = counted(3)
    const commit = services.db.updateTransaction.bind(services.db)
    const list = vi.spyOn(services.db, 'listRows')
    let clashes = 0
    let busy = false
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // Another write to the caller's row lands before each of the count's two tries commits.
      if (params.commit && !busy && clashes < 2) {
        clashes += 1
        busy = true
        await updateRow(services.db, 'persons', 'p1', { displayName: `Renamed ${clashes}` })
        busy = false
      }
      return commit(params)
    })
    const keys = { email: 'reg@example.com', phone: '0412 345 678' }
    expect(await addFails(services, { displayName: 'Reg', ...keys })).toMatchObject({
      code: 'CONFLICT',
    })
    expect(list.mock.calls.map(([params]) => params.tableId)).not.toContain('identities')
    expect(misses(services)).toBe(3)
  })

  it('refuses an invalid phone beside a valid email, without counting it', async () => {
    const services = counted(3)
    expect(
      await addFails(services, { displayName: 'Typo', email: 'reg@example.com', phone: '12' }),
    ).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(misses(services)).toBe(3)
  })

  it('takes back from the count as stored after its guard, not one read before', async () => {
    const services = counted(3)
    // Another check commits just before the add's guard on the caller's row: stagings 1–2 are
    // the count's, 3 is p9's guard, 4 the caller's.
    beforeStaging(services.db, 4, () =>
      updateRow(services.db, 'persons', 'p1', { addressMisses: 5 }),
    )
    await add(services, { displayName: 'Reg', email: 'reg@example.com', phone: '0412 345 678' })
    expect(misses(services)).toBe(4)
  })

  it('gives nothing back once a new window has started since the count', async () => {
    const services = counted(3)
    // A check that starts a new window commits after this add's count (two stagings), before
    // its transaction stages anything.
    beforeStaging(services.db, 3, () =>
      updateRow(services.db, 'persons', 'p1', { addressMisses: 1, addressMissesFrom: AFTER_COUNT }),
    )
    await add(services, { displayName: 'Reg', email: 'reg@example.com', phone: '0412 345 678' })
    expect(caller(services)).toMatchObject({ addressMisses: 1, addressMissesFrom: AFTER_COUNT })
  })
})

const AFTER_COUNT = '2026-10-18T20:00:01.000Z'
