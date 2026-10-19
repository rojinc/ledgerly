import type { BootstrapResult } from '@ledgerly/core/schemas/identity'
import { resolvePerson } from '@ledgerly/server/identity/resolve-person'
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

const BODY = { timezone: 'Australia/Sydney' }
const ID = /^[a-z0-9]{20}$/

function placeholder(id: string, displayName = 'Sam') {
  return { $id: id, userId: null, displayName, claimedAt: null, mergedInto: null, deletedAt: null }
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: key.split(':')[0], personId, verified: false, verifiedAt: null }
}

// Sam was added to g1 before signing up, and to g2 after.
function addedBeforeSignUp(typed: ReturnType<typeof identity>[] = []) {
  return fakes(
    {
      persons: [placeholder('pSam')],
      identities: [identity('iSam', 'email:sam@example.com', 'pSam'), ...typed],
      members: [
        placeholderRow('m1', 'g1', 'pSam', BEFORE),
        placeholderRow('m2', 'g2', 'pSam', AFTER),
      ],
    },
    { teams: { g1: ['uAdmin'], g2: ['uAdmin'] } },
  )
}

let warn: ReturnType<typeof vi.spyOn>
let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  // No personal data in logs: no email, phone number or name.
  for (const args of warn.mock.calls) expect(String(args)).not.toMatch(/@|\+?\d{6,}|Sam/)
  // An adoption logs IDs and counts only, never a key.
  for (const args of log.mock.calls) expect(String(args)).not.toMatch(/@|\+?\d{6,}/)
  warn.mockRestore()
  log.mockRestore()
})

describe('POST /bootstrap', () => {
  it('sets up the person, profile, personal group, its team and an admin membership', async () => {
    const services = fakes()
    const result = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    const { db, teams } = services
    const { personId, personalGroupId } = result
    expect(personId).toMatch(ID)
    expect(personalGroupId).toMatch(ID)
    expect(result.linkedGroupIds).toEqual([])
    expect(result.profile).toMatchObject({
      $id: 'u1',
      personId,
      timezone: 'Australia/Sydney',
      region: 'AU-NSW',
      currency: 'AUD',
      $permissions: ['read("user:u1")'],
    })
    expect(db.rows('persons')).toEqual([
      expect.objectContaining({
        $id: personId,
        userId: 'u1',
        displayName: 'Sam Lee',
        claimedAt: NOW.toISOString(),
        $permissions: ['read("user:u1")'],
      }),
    ])
    const team = [`read("team:${personalGroupId}")`]
    expect(db.rows('groups')).toEqual([
      expect.objectContaining({
        $id: personalGroupId,
        type: 'personal',
        name: 'Personal',
        ownerPersonId: personId,
        currency: 'AUD',
        timezone: 'Australia/Sydney',
        region: 'AU-NSW',
        statementCycle: 'none',
        settingsJson: '{"type":"personal"}',
        $permissions: team,
      }),
    ])
    expect(db.rows('members')).toEqual([
      expect.objectContaining({
        groupId: personalGroupId,
        personId,
        displayName: 'Sam Lee',
        role: 'admin',
        status: 'active',
        joinedOn: '2026-10-19', // today in Sydney, not in UTC
        $permissions: team,
      }),
    ])
    expect(teams.members(personalGroupId)).toEqual([
      { $id: expect.any(String), userId: 'u1', roles: [] },
    ])
    // Claim ran: the verified email now belongs to the person.
    expect(db.rows('identities')).toEqual([
      expect.objectContaining({
        key: 'email:sam@example.com',
        type: 'email',
        personId,
        verified: true,
        verifiedAt: NOW.toISOString(),
        $permissions: [],
      }),
    ])
  })

  it.each([
    ['Australia/Perth', 'AU-WA'],
    ['Pacific/Auckland', 'AU-NSW'],
  ])('takes the region from the time zone (%s → %s)', async (timezone, region) => {
    const services = fakes()
    const { profile } = await ok<BootstrapResult>(services, 'POST', '/bootstrap', { timezone })
    expect(profile).toMatchObject({ timezone, region, currency: 'AUD' })
    expect(services.db.rows('groups')[0]).toMatchObject({ timezone, region, currency: 'AUD' })
  })

  it('creates nothing new when repeated, and returns the same IDs', async () => {
    const services = addedBeforeSignUp()
    const first = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    const tables = ['persons', 'identities', 'profiles', 'groups', 'members', 'activity']
    const before = tables.map((table) => services.db.rows(table))
    const second = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    expect(second).toEqual({ ...first, linkedGroupIds: [] })
    expect(tables.map((table) => services.db.rows(table))).toEqual(before)
    expect(services.teams.teamIds()).toHaveLength(3)
  })

  it('adopts the placeholder a verified identity points at, and joins the groups it was added to before', async () => {
    const services = addedBeforeSignUp()
    const result = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    const { db, teams } = services
    expect(result.personId).toBe('pSam')
    expect(result.linkedGroupIds).toEqual(['g1'])
    expect(db.rows('persons')).toEqual([
      expect.objectContaining({
        $id: 'pSam',
        userId: 'u1',
        displayName: 'Sam Lee', // their own name, now they're registered
        claimedAt: NOW.toISOString(),
        $permissions: ['read("user:u1")'],
      }),
    ])
    expect(db.rows('identities')).toEqual([
      expect.objectContaining({ $id: 'iSam', personId: 'pSam', verified: true }),
    ])
    expect(teams.members('g1')?.map((membership) => membership.userId)).toEqual(['uAdmin', 'u1'])
    expect(db.rows('members').find((row) => row.$id === 'm1')?.status).toBe('active')
    expect(db.rows('activity')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        actorPersonId: 'pSam',
        action: 'member.joined',
        subjectPersonId: 'pSam',
        summary: 'joined',
        at: NOW.toISOString(),
        $permissions: ['read("team:g1")'],
      }),
    ])
    // Added after claimedAt: left for Sam to join themselves (D-016).
    expect(db.rows('members').find((row) => row.$id === 'm2')?.status).toBe('placeholder')
    expect(teams.members('g2')?.map((membership) => membership.userId)).toEqual(['uAdmin'])
  })

  describe('only the keys the user verified stay theirs (#252)', () => {
    // Whoever added Sam typed a phone too, one Sam hasn't verified.
    const typedPhone = () => identity('iTyped', 'phone:+61400000000', 'pSam')

    it('deletes a typed key when it adopts, in the same transaction, and logs a count', async () => {
      // Another placeholder's typed key is nothing to do with this adoption.
      const services = addedBeforeSignUp([
        typedPhone(),
        identity('iOther', 'phone:+61400000999', 'pOther'),
      ])
      expect((await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)).personId).toBe(
        'pSam',
      )
      expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iSam', 'iOther'])
      expect(log).toHaveBeenCalledWith('bootstrap adopted pSam; typed keys deleted: 1')
    })

    it('keeps a key the user verified too, and logs nothing', async () => {
      const services = addedBeforeSignUp([typedPhone()])
      services.users.get = async () => account({ phone: '+61400000000', phoneVerification: true })
      await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
      expect(services.db.rows('identities')).toEqual([
        expect.objectContaining({ $id: 'iSam', personId: 'pSam', verified: true }),
        expect.objectContaining({ $id: 'iTyped', personId: 'pSam', verified: true }),
      ])
      expect(log).not.toHaveBeenCalled()
    })

    it("drops the victim's typed email when someone adopts by their own phone (#247)", async () => {
      // Someone added P as the victim's email beside their own phone, then signed up and
      // verified only the phone.
      const services = fakes({
        persons: [placeholder('pP')],
        identities: [
          identity('iVictim', 'email:victim@example.com', 'pP'),
          identity('iPhone', 'phone:+61412345678', 'pP'),
        ],
      })
      services.users.get = async () =>
        account({
          email: '',
          emailVerification: false,
          phone: '+61412345678',
          phoneVerification: true,
        })
      expect((await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)).personId).toBe('pP')
      expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iPhone'])
      // So a group that adds the victim later gets a new placeholder, not the account.
      const added = await resolvePerson(
        services.db,
        { displayName: 'Vic', email: 'victim@example.com' },
        'AU-NSW',
      )
      expect(added.personId).not.toBe('pP')
      expect(added.writes).toContainEqual(
        expect.objectContaining({ action: 'create', tableId: 'persons' }),
      )
    })
  })

  it('ignores an unverified email, even one that matches a placeholder', async () => {
    const services = addedBeforeSignUp()
    services.users.get = async () => account({ emailVerification: false })
    const result = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    expect(result.personId).not.toBe('pSam')
    expect(result.linkedGroupIds).toEqual([])
    expect(services.db.rows('persons').find((row) => row.$id === 'pSam')?.userId).toBeNull()
    expect(services.db.rows('identities')).toEqual([
      expect.objectContaining({ $id: 'iSam', personId: 'pSam', verified: false }),
    ])
    expect(services.teams.members('g1')).toHaveLength(1)
  })

  it("adopts the email's placeholder over the phone's, and leaves the phone's for a merge", async () => {
    const services = fakes({
      persons: [placeholder('pEmail'), placeholder('pPhone')],
      identities: [
        identity('i1', 'phone:+61412345678', 'pPhone'),
        identity('i2', 'email:sam@example.com', 'pEmail'),
      ],
    })
    services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
    const result = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    expect(result.personId).toBe('pEmail')
    expect(services.db.rows('identities')).toEqual([
      expect.objectContaining({ $id: 'i1', personId: 'pPhone', verified: false }),
      expect.objectContaining({ $id: 'i2', personId: 'pEmail', verified: true }),
    ])
    expect(services.db.rows('persons').find((row) => row.$id === 'pPhone')?.userId).toBeNull()
    expect(warn).toHaveBeenCalledWith('claim needs a merge; skipped')
  })

  it('names a new person "Me" when the account has no name, and keeps the name an adopted one had', async () => {
    const services = fakes()
    services.users.get = async () => account({ name: '  ', emailVerification: false })
    await ok(services, 'POST', '/bootstrap', BODY)
    expect(services.db.rows('persons')[0]?.displayName).toBe('Me')
    expect(services.db.rows('members')[0]?.displayName).toBe('Me')

    const adopting = addedBeforeSignUp()
    adopting.users.get = async () => account({ name: '' })
    await ok(adopting, 'POST', '/bootstrap', BODY)
    expect(adopting.db.rows('persons')[0]?.displayName).toBe('Sam')
  })

  it('cuts a long account name to fit', async () => {
    const services = fakes()
    services.users.get = async () => account({ name: `${'é'.repeat(99)}👍👍` })
    await ok(services, 'POST', '/bootstrap', BODY)
    expect(services.db.rows('persons')[0]?.displayName).toBe(`${'é'.repeat(99)}👍`)
  })

  it('skips a verified email or phone it cannot use, without failing or logging the value', async () => {
    const services = fakes()
    services.users.get = async () =>
      account({ email: '"quoted"@example.com', phone: '+999123456', phoneVerification: true })
    const result = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    expect(result.personId).toMatch(ID)
    expect(services.db.rows('identities')).toEqual([])
    expect(warn.mock.calls).toEqual([
      ['skipped an unusable verified email'],
      ['skipped an unusable verified phone'],
    ])
  })

  it('finishes an interrupted claim on the next bootstrap', async () => {
    const services = addedBeforeSignUp()
    const stage = services.db.createOperations.bind(services.db)
    const failing = vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      if (JSON.stringify(params.operations).includes('member.joined')) {
        throw new AppwriteException('Connection lost', 503)
      }
      return stage(params)
    })
    const interrupted = await call(services, 'POST', '/bootstrap', BODY)
    expect(interrupted.status).toBe(500)
    // The account is set up; the join was not, so its team add was taken back.
    expect(services.teams.members('g1')?.map((membership) => membership.userId)).not.toContain('u1')
    expect(services.db.rows('profiles')).toHaveLength(1)
    expect(services.db.rows('members').find((row) => row.$id === 'm1')?.status).toBe('placeholder')
    failing.mockRestore()

    const retried = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    expect(retried.linkedGroupIds).toEqual(['g1'])
    expect(services.db.rows('members').find((row) => row.$id === 'm1')?.status).toBe('active')
    expect(services.db.rows('activity')).toHaveLength(1)
    expect(services.teams.members('g1')).toHaveLength(2)
  })

  it('uses the profile a bootstrap running at the same time created first', async () => {
    const services = fakes()
    const createTransaction = services.db.createTransaction.bind(services.db)
    let other: BootstrapResult | undefined
    vi.spyOn(services.db, 'createTransaction').mockImplementationOnce(async () => {
      other = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
      return createTransaction()
    })
    const result = await ok<BootstrapResult>(services, 'POST', '/bootstrap', BODY)
    expect(other).toBeDefined()
    expect(result).toEqual({ ...other, profile: expect.objectContaining({ $id: 'u1' }) })
    for (const table of ['persons', 'profiles', 'groups', 'members', 'identities']) {
      expect(services.db.rows(table)).toHaveLength(1)
    }
    // The losing attempt's team has no group row, so it grants nothing.
    expect(services.teams.teamIds()).toHaveLength(2)
  })

  it.each([
    [
      'before its writes are staged',
      (services: Fakes, claimFirst: () => Promise<unknown>) =>
        beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"profiles"'),
          claimFirst,
        ),
    ],
    [
      'after its writes are staged',
      (services: Fakes, claimFirst: () => Promise<unknown>) =>
        beforeCommit(services.db, claimFirst),
    ],
  ])(
    'says CONFLICT, try again, when another user claims the placeholder first, %s',
    async (_, race) => {
      const services = addedBeforeSignUp([identity('iTyped', 'phone:+61400000000', 'pSam')])
      race(services, () => updateRow(services.db, 'persons', 'pSam', { userId: 'uOther' }))
      expect(await failure(services, 'POST', '/bootstrap', BODY)).toEqual({
        status: 409,
        code: 'CONFLICT',
        message: TRY_AGAIN,
      })
      expect(services.db.rows('profiles')).toEqual([])
      expect(services.db.rows('persons')[0]?.userId).toBe('uOther')
      // Its typed-key delete went with the rest: the placeholder is the other user's to claim.
      expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iSam', 'iTyped'])
      // And nothing claims it was adopted.
      expect(log).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['no body', undefined],
    ['no time zone', {}],
    ['an offset instead of a time zone', { timezone: '+10:00' }],
    ['an unknown field', { ...BODY, region: 'AU-VIC' }],
  ])('is VALIDATION_FAILED with %s, and writes nothing', async (_, body) => {
    const services = fakes()
    expect(await failure(services, 'POST', '/bootstrap', body)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('persons')).toEqual([])
    expect(services.teams.teamIds()).toEqual([])
  })

  it('is UNAUTHENTICATED without a JWT', async () => {
    const services = fakes()
    expect(await failure(services, 'POST', '/bootstrap', BODY, null)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
  })
})

describe('GET /health', () => {
  it('is public and says nothing about the caller', async () => {
    const response = await call(fakes(), 'GET', '/health', undefined, null)
    expect(response.body).toEqual({ ok: true, data: { fn: 'identity', version: 'dev' } })
  })
})
