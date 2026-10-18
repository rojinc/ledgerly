import { describe, expect, it } from 'vitest'
import { FakeDb } from '../appwrite/fake'
import { withTransaction } from '../appwrite/transaction'
import { resolvePerson } from './resolve-person'

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

  it('plans a placeholder with a random ID and unverified identities when nothing is known', async () => {
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
      expect.objectContaining({
        key: 'phone:+61400000000',
        type: 'phone',
        personId,
        verified: false,
        $permissions: [],
      }),
    ])
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
})
