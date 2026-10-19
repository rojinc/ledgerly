import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MERGE_BATCH, markMerged, moveIdentities, moveShares } from '../src/merge'
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

describe('moveShares (step 3)', () => {
  const FAR = Number.MAX_SAFE_INTEGER

  function share(
    id: string,
    transactionId: string,
    personId: string,
    given: number,
    received: number,
    groupId = 'g1',
  ) {
    return {
      $id: id,
      transactionId,
      personId,
      givenCents: given,
      receivedCents: received,
      groupId,
      date: '2026-10-01',
      kind: 'expense',
      category: null,
    }
  }

  function seed(shares: object[], statements: object[] = []) {
    return new FakeDb({
      persons: [U, P],
      groups: [
        { $id: 'g1', type: 'house', name: 'Flat', rev: 'r0' },
        { $id: 'g2', type: 'house', name: 'Old flat', rev: 'r0' },
      ],
      shares,
      statements,
    } as ConstructorParameters<typeof FakeDb>[0])
  }

  /** Each person's net in a group: Σ (given − received). */
  function nets(store: FakeDb, groupId: string) {
    const result: Record<string, number> = {}
    for (const row of store.rows('shares').filter((row) => row.groupId === groupId)) {
      const id = row.personId as string
      result[id] = (result[id] ?? 0) + (row.givenCents as number) - (row.receivedCents as number)
    }
    return result
  }

  it('repoints P’s shares, combines them with U’s in the same transaction, and keeps every net', async () => {
    const store = seed([
      // t1: P paid 90 for P, U and X.
      share('s1', 't1', 'pP', 9000, 3000),
      share('s2', 't1', 'pU', 0, 3000),
      share('s3', 't1', 'pX', 0, 3000),
      // t2: X paid 40 for P alone.
      share('s4', 't2', 'pP', 0, 4000),
      share('s5', 't2', 'pX', 4000, 0),
    ])
    const before = nets(store, 'g1')
    expect(await moveShares(store, 'pP', 'pU', new Set(), FAR)).toEqual({ moved: 2, putOff: [] })
    const after = nets(store, 'g1')
    expect(after).toEqual({ pU: (before.pP ?? 0) + (before.pU ?? 0), pX: before.pX })
    // One share per person per transaction (I-5), and every transaction still sums to 0 (I-1).
    const t1 = store.rows('shares').filter((row) => row.transactionId === 't1')
    expect(t1.map((row) => [row.personId, row.givenCents, row.receivedCents])).toEqual([
      ['pU', 9000, 6000],
      ['pX', 0, 3000],
    ])
    expect(store.rows('shares').find((row) => row.$id === 's4')?.personId).toBe('pU')
    // The group's guard was written.
    expect(store.rows('groups').find((row) => row.$id === 'g1')?.rev).not.toBe('r0')
  })

  it('leaves P’s shares in kept groups and puts off a group that is finalizing', async () => {
    const store = seed(
      [
        share('s1', 't1', 'pP', 100, 0, 'g1'),
        share('s2', 't1', 'pX', 0, 100, 'g1'),
        share('s3', 't2', 'pP', 100, 0, 'g2'),
        share('s4', 't2', 'pX', 0, 100, 'g2'),
      ],
      [{ $id: 'st1', groupId: 'g2', status: 'finalizing', periodStart: '2026-09-01' }],
    )
    expect(await moveShares(store, 'pP', 'pU', new Set(['g1']), FAR)).toEqual({
      moved: 0,
      putOff: ['g2'],
    })
    expect(store.rows('shares').filter((row) => row.personId === 'pP')).toHaveLength(2)
    // The put-off group's guard rolled back with its batch.
    expect(store.rows('groups').find((row) => row.$id === 'g2')?.rev).toBe('r0')
  })

  it('moves 250 shares in batches of at most 90 writes, each with the group’s guard', async () => {
    const shares = Array.from({ length: 250 }, (_, n) => share(`s${n}`, `t${n}`, 'pP', 0, 100))
    const store = seed(shares)
    const commits = vi.spyOn(store, 'createOperations')
    expect((await moveShares(store, 'pP', 'pU', new Set(), FAR)).moved).toBe(250)
    expect(store.rows('shares').every((row) => row.personId === 'pU')).toBe(true)
    // Every transaction's writes, by its ID: at most 90, and one of them the group's guard.
    const perTransaction = new Map<string, unknown[]>()
    for (const [params] of commits.mock.calls) {
      perTransaction.set(params.transactionId, [
        ...(perTransaction.get(params.transactionId) ?? []),
        ...(params.operations ?? []),
      ])
    }
    expect(perTransaction.size).toBeGreaterThanOrEqual(3)
    for (const operations of perTransaction.values()) {
      expect(operations.length).toBeLessThanOrEqual(MERGE_BATCH)
      expect(JSON.stringify(operations)).toContain('"rev"')
    }
  })

  it('starts no batch once the deadline has passed', async () => {
    const store = seed([share('s1', 't1', 'pP', 0, 100)])
    expect(await moveShares(store, 'pP', 'pU', new Set(), 0)).toEqual({ moved: 0, putOff: [] })
    expect(store.rows('shares')[0]?.personId).toBe('pP')
  })

  it('runs a batch again when U’s share changes after it was read, so nothing is added twice', async () => {
    const store = seed([share('s1', 't1', 'pP', 0, 3000), share('s2', 't1', 'pU', 6000, 3000)])
    // A ledger edit lands between the read and the staging: U's share is now 0 / 3000.
    beforeStaging(
      store,
      (operations) => operations.includes('"shares"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'shares',
            rowId: 's2',
            data: { givenCents: 3000, receivedCents: 0 },
          }),
        ),
    )
    await moveShares(store, 'pP', 'pU', new Set(), FAR)
    expect(
      store.rows('shares').map((row) => [row.personId, row.givenCents, row.receivedCents]),
    ).toEqual([['pU', 3000, 3000]])
  })
})
