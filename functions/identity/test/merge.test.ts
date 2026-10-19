import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MERGE_BATCH, markMerged, moveIdentities } from '../src/merge'
import { beforeCommit, beforeStaging, updateRow } from './harness'

// P (a placeholder) is merged into U (the caller's person).
const U = { $id: 'pU', displayName: 'Sam Lee', userId: 'u1', mergedInto: null, deletedAt: null }
const P = { $id: 'pP', displayName: 'Sammy', userId: null, mergedInto: null, deletedAt: null }

function identity(n: number, personId = 'pP') {
  return { $id: `i${n}`, key: `email:p${n}@example.com`, type: 'email', personId, verified: true }
}

function db(persons: object[] = [U, P], identities: object[] = []) {
  return new FakeDb({ persons, identities } as ConstructorParameters<typeof FakeDb>[0])
}

/** Commits one identity update outside the merge, as another request would. */
function identityUpdate(store: FakeDb, rowId: string, data: object) {
  return withTransaction(store, (tx) =>
    tx.write({ action: 'update', tableId: 'identities', rowId, data: { ...data } }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('markMerged (step 1)', () => {
  it('marks a placeholder as merged into U', async () => {
    const store = db()
    expect(await markMerged(store, 'pP', 'pU')).toBe(true)
    expect(store.rows('persons').find((row) => row.$id === 'pP')?.mergedInto).toBe('pU')
  })

  it('counts a placeholder already marked for U as U’s, so a cut-off merge carries on', async () => {
    const store = db([U, { ...P, mergedInto: 'pU' }])
    expect(await markMerged(store, 'pP', 'pU')).toBe(true)
  })

  it('leaves alone a person with an account, a deleted one, one merged elsewhere, or none', async () => {
    expect(await markMerged(db([U, { ...P, userId: 'u2' }]), 'pP', 'pU')).toBe(false)
    expect(
      await markMerged(db([U, { ...P, deletedAt: '2026-10-01T00:00:00.000Z' }]), 'pP', 'pU'),
    ).toBe(false)
    expect(await markMerged(db([U, { ...P, mergedInto: 'pX' }]), 'pP', 'pU')).toBe(false)
    expect(await markMerged(db([U]), 'pP', 'pU')).toBe(false)
  })

  it('loses to another merge or adoption that lands before its staging', async () => {
    const store = db()
    beforeStaging(
      store,
      (operations) => operations.includes('mergedInto'),
      () => updateRow(store, 'persons', 'pP', { mergedInto: 'pX' }),
    )
    expect(await markMerged(store, 'pP', 'pU')).toBe(false)
    expect(store.rows('persons').find((row) => row.$id === 'pP')?.mergedInto).toBe('pX')
  })

  it('reads the stored row after a failed commit to see who won', async () => {
    const lost = db()
    beforeCommit(lost, () => updateRow(lost, 'persons', 'pP', { userId: 'u2' }))
    expect(await markMerged(lost, 'pP', 'pU')).toBe(false)

    // The same merge running twice at once: the other call marked P for U, so P is U's.
    const twice = db()
    beforeCommit(twice, () => updateRow(twice, 'persons', 'pP', { mergedInto: 'pU' }))
    expect(await markMerged(twice, 'pP', 'pU')).toBe(true)
  })
})

describe('moveIdentities (step 3)', () => {
  it('repoints every identity of P to U, a batch at a time', async () => {
    const count = MERGE_BATCH + 5
    const store = db(
      [U, P],
      [...Array.from({ length: count }, (_, n) => identity(n)), identity(999, 'pU')],
    )
    expect(await moveIdentities(store, 'pP', 'pU')).toBe(count)
    expect(store.rows('identities').every((row) => row.personId === 'pU')).toBe(true)
    // Nothing left to move: a second run is a no-op.
    expect(await moveIdentities(store, 'pP', 'pU')).toBe(0)
  })

  it('never overwrites an identity that changed after it was listed', async () => {
    const store = db([U, P, { ...P, $id: 'pX' }], [identity(1), identity(2)])
    // Another merge takes i1 for pX between the list and the staging.
    beforeStaging(
      store,
      (operations) => operations.includes('i1'),
      () => identityUpdate(store, 'i1', { personId: 'pX' }),
    )
    expect(await moveIdentities(store, 'pP', 'pU')).toBe(1)
    const owners = Object.fromEntries(
      store.rows('identities').map((row) => [row.$id, row.personId]),
    )
    expect(owners).toEqual({ i1: 'pX', i2: 'pU' })
  })

  it('runs a batch again after a commit conflict', async () => {
    const store = db([U, P], [identity(1)])
    // A claim verifies i1 after the batch staged it, so the batch's commit fails.
    beforeCommit(store, () =>
      identityUpdate(store, 'i1', { verifiedAt: '2026-10-18T00:00:00.000Z' }),
    )
    expect(await moveIdentities(store, 'pP', 'pU')).toBe(1)
    expect(store.rows('identities')[0]?.personId).toBe('pU')
  })
})
