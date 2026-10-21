import { AppwriteException } from 'node-appwrite'
import { describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { withTransaction } from '../appwrite/transaction'
import {
  bothKeysFindOne,
  findPerson,
  isLonePlaceholder,
  isPlaceholder,
  resolvePerson,
} from './resolve-person'

function db() {
  return new FakeDb({
    persons: [
      { $id: 'pEmail', displayName: 'Sam', userId: null },
      { $id: 'pPhone', displayName: 'Sammy', userId: 'uSam' },
    ],
    identities: [
      { $id: 'i1', key: 'email:sam@example.com', type: 'email', personId: 'pEmail' },
      { $id: 'i2', key: 'phone:+61412345678', type: 'phone', personId: 'pPhone', verified: true },
    ],
  })
}

describe('resolvePerson', () => {
  it("uses the email's person when the email and phone belong to two persons, and merges nothing", async () => {
    const store = db()
    const resolved = await resolvePerson(
      store,
      { displayName: 'Sam', email: ' Sam@Example.com ', phone: '0412 345 678' },
      'AU-NSW',
    )
    expect(resolved).toEqual({ personId: 'pEmail', writes: [] })
    expect(store.rows('persons')).toHaveLength(2)
  })

  it('finds a phone typed without a country code, using the region', async () => {
    const resolved = await resolvePerson(
      db(),
      { displayName: 'S', phone: '0412 345 678' },
      'AU-VIC',
    )
    expect(resolved).toEqual({ personId: 'pPhone', writes: [] })
  })

  it('uses the found person and stores nothing for the other, unknown key', async () => {
    const byPhone = await resolvePerson(
      db(),
      { displayName: 'Sam', email: 'stranger@example.com', phone: '+61412345678' },
      'AU-NSW',
    )
    expect(byPhone).toEqual({ personId: 'pPhone', writes: [] })
    const byEmail = await resolvePerson(
      db(),
      { displayName: 'Sam', email: 'sam@example.com', phone: '+61400000000' },
      'AU-NSW',
    )
    expect(byEmail).toEqual({ personId: 'pEmail', writes: [] })
  })

  it('plans a placeholder with a random ID and one unverified identity when nothing is known', async () => {
    const store = db()
    const { personId, writes } = await resolvePerson(
      store,
      { displayName: 'Alex', email: 'Alex@Example.com', phone: '0400 000 000' },
      'AU-NSW',
    )
    expect(personId).toMatch(/^[a-z0-9]{20}$/)
    expect(store.rows('persons')).toHaveLength(2) // it only plans
    await withTransaction(store, (tx) => tx.write(...writes))
    expect(store.rows('persons').at(-1)).toMatchObject({
      $id: personId,
      displayName: 'Alex',
      $permissions: [],
    })
    expect(store.rows('persons').at(-1)?.userId).toBeUndefined()
    expect(store.rows('identities').slice(2)).toEqual([
      expect.objectContaining({
        key: 'email:alex@example.com',
        type: 'email',
        personId,
        verified: false,
        $permissions: [],
      }),
    ])
  })

  it('keeps one key, the email if there is one, so only one key can claim the placeholder', async () => {
    const both = await resolvePerson(
      db(),
      { displayName: 'Jo', email: 'jo@example.com', phone: '+61400000001' },
      'AU',
    )
    expect(both.writes).toEqual([
      expect.objectContaining({ tableId: 'persons' }),
      expect.objectContaining({
        tableId: 'identities',
        data: expect.objectContaining({ key: 'email:jo@example.com' }),
      }),
    ])
    // The phone is still checked.
    await expect(
      resolvePerson(db(), { displayName: 'Jo', email: 'jo@example.com', phone: '12' }, 'AU'),
    ).rejects.toThrow(RangeError)
  })

  it('creates only the identity it was given', async () => {
    const { writes } = await resolvePerson(db(), { displayName: 'Jo', phone: '+61400000001' }, 'AU')
    expect(writes.map((write) => write.tableId)).toEqual(['persons', 'identities'])
    const { writes: none } = await resolvePerson(db(), { displayName: 'Jo' }, 'AU')
    expect(none.map((write) => write.tableId)).toEqual(['persons'])
  })

  it("sees identities staged in the caller's transaction", async () => {
    const store = db()
    await withTransaction(store, async (tx) => {
      const first = await resolvePerson(
        store,
        { displayName: 'Kim', email: 'kim@example.com' },
        'AU',
      )
      await tx.write(...first.writes)
      const again = await resolvePerson(
        store,
        { displayName: 'Kim', email: 'kim@example.com' },
        'AU',
        tx.id,
      )
      expect(again).toEqual({ personId: first.personId, writes: [] })
    })
  })

  it('throws a RangeError that never repeats an invalid email or phone', async () => {
    await expect(
      resolvePerson(db(), { displayName: 'X', email: 'not-an-email' }, 'AU'),
    ).rejects.toThrow(new RangeError('Not an email address'))
    await expect(resolvePerson(db(), { displayName: 'X', phone: '12' }, 'AU')).rejects.toThrow(
      new RangeError('Not a valid phone number'),
    )
  })

  it('follows mergedInto to the end of the chain, so an email added mid-merge adds U', async () => {
    const store = new FakeDb({
      persons: [
        { $id: 'pOld', displayName: 'Sam', userId: null, mergedInto: 'pMid' },
        { $id: 'pMid', displayName: 'Sam', userId: null, mergedInto: 'pSam' },
        { $id: 'pSam', displayName: 'Sam Lee', userId: 'uSam', mergedInto: null },
      ],
      identities: [{ $id: 'i1', key: 'email:sam@example.com', type: 'email', personId: 'pOld' }],
    })
    expect(
      await resolvePerson(store, { displayName: 'Sam', email: 'sam@example.com' }, 'AU-NSW'),
    ).toEqual({ personId: 'pSam', writes: [] })
  })

  it('reads the chain in the caller’s transaction, and refuses a broken loop', async () => {
    const store = new FakeDb({
      persons: [
        { $id: 'pA', displayName: 'A', userId: null, mergedInto: 'pB' },
        { $id: 'pB', displayName: 'B', userId: null, mergedInto: 'pA' },
      ],
      identities: [{ $id: 'i1', key: 'email:a@example.com', type: 'email', personId: 'pA' }],
    })
    await expect(
      withTransaction(store, (tx) =>
        resolvePerson(store, { displayName: 'A', email: 'a@example.com' }, 'AU-NSW', tx.id),
      ),
    ).rejects.toThrow('A person was merged too many times in a row')
  })
})

// #378: the only add with both keys whose address check takes its count back.
describe('bothKeysFindOne', () => {
  // pEmail's phone too, and a placeholder merged into pEmail holding another email.
  function known() {
    return new FakeDb({
      persons: [
        { $id: 'pEmail', displayName: 'Sam', userId: null, mergedInto: null },
        { $id: 'pPhone', displayName: 'Sammy', userId: 'uSam', mergedInto: null },
        { $id: 'pOld', displayName: 'S', userId: null, mergedInto: 'pEmail' },
      ],
      identities: [
        { $id: 'i1', key: 'email:sam@example.com', type: 'email', personId: 'pEmail' },
        { $id: 'i2', key: 'phone:+61412345678', type: 'phone', personId: 'pPhone' },
        { $id: 'i3', key: 'phone:+61498765432', type: 'phone', personId: 'pEmail' },
        { $id: 'i4', key: 'email:old@example.com', type: 'email', personId: 'pOld' },
      ],
    })
  }
  it.each([
    ['both keys find one person', 'sam@example.com', '0498 765 432', true],
    ['one key is on a person merged into the other’s', 'old@example.com', '0498 765 432', true],
    ['they find two persons', 'sam@example.com', '0412 345 678', false],
    ['only the email finds someone', 'sam@example.com', '0400 000 001', false],
    ['only the phone finds someone', 'new@example.com', '0498 765 432', false],
    ['both find nobody', 'new@example.com', '0400 000 001', false],
  ])('says %s: %s', async (_case, email, phone, expected) => {
    expect(await bothKeysFindOne(known(), { displayName: 'X', email, phone }, 'AU-NSW')).toBe(
      expected,
    )
  })

  it('is false for one key', async () => {
    const input = { displayName: 'X', email: 'sam@example.com' }
    expect(await bothKeysFindOne(known(), input, 'AU-NSW')).toBe(false)
  })
})

describe('isPlaceholder', () => {
  const person = (extra: object) =>
    ({ $id: 'p1', userId: null, mergedInto: null, deletedAt: null, ...extra }) as never

  it('is a person with no account, not merged and not deleted', () => {
    expect(isPlaceholder(person({}))).toBe(true)
  })

  it.each([
    ['an account', { userId: 'u1' }],
    ['a merge', { mergedInto: 'p2' }],
    ['a deletion', { deletedAt: '2026-10-19T00:00:00.000Z' }],
  ])('is not a person with %s', (_, extra) => expect(isPlaceholder(person(extra))).toBe(false))
})

describe('isLonePlaceholder', () => {
  // pLone has only m1; pTwo has m2 and m3; pNone has none. pUser has an account.
  function lonely() {
    const person = ($id: string, extra: object = {}) => ({
      $id,
      displayName: $id,
      userId: null,
      mergedInto: null,
      deletedAt: null,
      ...extra,
    })
    const member = ($id: string, groupId: string, personId: string) => ({
      $id,
      groupId,
      personId,
      displayName: personId,
      role: 'member',
      status: 'placeholder',
      joinedOn: '2026-10-01',
    })
    return new FakeDb({
      persons: [
        person('pLone'),
        person('pTwo'),
        person('pNone'),
        person('pUser', { userId: 'u1' }),
        person('pMerged', { mergedInto: 'pUser' }),
        person('pDeleted', { deletedAt: '2026-10-19T00:00:00.000Z' }),
      ],
      members: [
        member('m1', 'g1', 'pLone'),
        member('m2', 'g1', 'pTwo'),
        member('m3', 'g2', 'pTwo'),
        member('m4', 'g1', 'pUser'),
        member('m5', 'g1', 'pMerged'),
        member('m6', 'g1', 'pDeleted'),
      ],
    })
  }

  it('is a placeholder whose only member row is the one being deleted', async () => {
    expect(await isLonePlaceholder(lonely(), 'pLone', 'm1')).toBe(true)
  })

  it('is a placeholder no member row names, with no row given', async () => {
    expect(await isLonePlaceholder(lonely(), 'pNone')).toBe(true)
  })

  it.each([
    ['another row in another group', 'pTwo', 'm2'],
    ['a row, with none given', 'pLone', undefined],
    ['a row other than the one given', 'pLone', 'm9'],
  ])('is not a placeholder with %s', async (_, personId, exceptMemberId) => {
    expect(await isLonePlaceholder(lonely(), personId, exceptMemberId)).toBe(false)
  })

  it.each([
    ['an account', 'pUser', 'm4'],
    ['a merge', 'pMerged', 'm5'],
    ['a deletion', 'pDeleted', 'm6'],
    ['no row', 'pGone', undefined],
  ])('is not a person with %s', async (_, personId, exceptMemberId) => {
    expect(await isLonePlaceholder(lonely(), personId, exceptMemberId)).toBe(false)
  })
})

describe('findPerson', () => {
  it('reads the person as stored, or undefined when there is none', async () => {
    const store = db()
    expect(await findPerson(store, 'pEmail')).toMatchObject({ $id: 'pEmail', displayName: 'Sam' })
    expect(await findPerson(store, 'pGone')).toBeUndefined()
  })

  it('throws any other failure', async () => {
    const store = db()
    vi.spyOn(store, 'getRow').mockRejectedValue(new AppwriteException('Server error', 500))
    await expect(findPerson(store, 'pEmail')).rejects.toThrow('Server error')
  })
})
