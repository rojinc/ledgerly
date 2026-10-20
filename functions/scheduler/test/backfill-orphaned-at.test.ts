import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundleBackfill } from '../../../scripts/backfill-bundle.mjs'
import { backfillOrphanedAt } from '../src/backfill-orphaned-at'
import { beforeCommit, beforeStaging, type Fakes, fakes, member, NOW, person } from './harness'

// data-model.md#persons: the one-off for placeholders removed before orphanedAt existed.
const REV = /^[a-z0-9]{20}$/
const MARKED = '2026-09-01T00:00:00.000Z'

// pLone has no member row; pHere has one; pMarked was marked by a removal already.
function seeded(extra: { persons?: object[] } = {}): Fakes {
  return fakes({
    persons: [
      person('pLone', null),
      person('pHere', null),
      { ...person('pMarked', null), orphanedAt: MARKED, rev: 'kept' },
      person('pSam', 'u1'),
      { ...person('pMerged', null), mergedInto: 'pSam' },
      { ...person('pDeleted', null), deletedAt: '2026-10-01T00:00:00.000Z' },
      ...((extra.persons ?? []) as ReturnType<typeof person>[]),
    ],
    members: [member('g1', 'pSam'), member('g1', 'pHere', { status: 'placeholder' })],
  })
}

const personOf = (services: Fakes, id: string) =>
  services.db.rows('persons').find((row) => row.$id === id)

// groups POST /groups/{id}/members finding pLone by its email: a guard on the person, and a row.
const add = (services: Fakes) => () =>
  withTransaction(services.db, (tx) => {
    const { $id, ...row } = member('g2', 'pLone', { status: 'placeholder', role: 'member' })
    return tx.write(
      { action: 'update', tableId: 'persons', rowId: 'pLone', data: { rev: 'add' } },
      { action: 'create', tableId: 'members', rowId: $id, data: row },
    )
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backfillOrphanedAt', () => {
  it('marks a placeholder no member row names, with a fresh rev, and leaves everyone else', async () => {
    const services = seeded()
    expect(await backfillOrphanedAt(services.db, NOW)).toEqual({ marked: 1, unchanged: 1 })
    expect(personOf(services, 'pLone')).toMatchObject({
      orphanedAt: NOW.toISOString(),
      rev: expect.stringMatching(REV),
    })
    expect(personOf(services, 'pMarked')).toMatchObject({ orphanedAt: MARKED, rev: 'kept' })
    for (const id of ['pHere', 'pSam', 'pMerged', 'pDeleted']) {
      expect(personOf(services, id)?.orphanedAt, id).toBeUndefined()
    }
  })

  it('goes through every page, and a second run changes nothing', async () => {
    const many = Array.from({ length: 150 }, (_, index) => person(`pMany${1000 + index}`, null))
    const services = seeded({ persons: many })
    expect(await backfillOrphanedAt(services.db, NOW)).toEqual({ marked: 151, unchanged: 1 })
    const rows = JSON.stringify(services.db.rows('persons'))
    expect(await backfillOrphanedAt(services.db, new Date('2026-10-19T00:00:00.000Z'))).toEqual({
      marked: 0,
      unchanged: 1,
    })
    expect(JSON.stringify(services.db.rows('persons'))).toBe(rows)
  })

  it.each([
    ['after it staged its write, failing its commit', 'commit'],
    ['after it decided, before it staged', 'staging'],
  ])('leaves a placeholder an add gives a member row %s', async (_, when) => {
    const services = seeded()
    if (when === 'commit') {
      beforeCommit(services.db, add(services))
    } else {
      beforeStaging(services.db, (operations) => operations.includes('"pLone"'), add(services))
    }
    expect(await backfillOrphanedAt(services.db, NOW)).toEqual({ marked: 0, unchanged: 2 })
    expect(personOf(services, 'pLone')).toMatchObject({ rev: 'add' })
    expect(personOf(services, 'pLone')?.orphanedAt).toBeUndefined()
  })

  it('marks a placeholder whose row another write changed before its commit, on its next try', async () => {
    const services = seeded()
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'update', tableId: 'persons', rowId: 'pLone', data: { rev: 'other' } }),
      ),
    )
    expect(await backfillOrphanedAt(services.db, NOW)).toEqual({ marked: 1, unchanged: 1 })
    expect(personOf(services, 'pLone')).toMatchObject({
      orphanedAt: NOW.toISOString(),
      rev: expect.stringMatching(REV),
    })
  })

  it('throws for a person that keeps changing, and marks nothing more', async () => {
    const services = seeded({ persons: [person('pZed', null)] })
    const commit = services.db.updateTransaction.bind(services.db)
    let changing = false
    let changes = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // Before every commit of the backfill's, but not this change's own. A new value each time:
      // a write that leaves the row as it was fails no commit.
      if (params.commit && !changing) {
        changing = true
        changes += 1
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'persons',
            rowId: 'pLone',
            data: { rev: `change${changes}` },
          }),
        )
        changing = false
      }
      return commit(params)
    })
    await expect(backfillOrphanedAt(services.db, NOW)).rejects.toMatchObject({ code: 409 })
    expect(changes).toBe(3)
    expect(personOf(services, 'pLone')?.orphanedAt).toBeUndefined()
    expect(personOf(services, 'pZed')?.orphanedAt).toBeUndefined()
  })

  // scripts/backfill-orphaned-at.mjs runs this bundle, with the client from the same bundle.
  it('takes a 409 from its bundle’s own node-appwrite as a conflict', async () => {
    const bundle = await bundleBackfill()
    const services = seeded()
    const stage = services.db.createOperations.bind(services.db)
    let first = true
    services.db.createOperations = async (params) => {
      if (first) {
        first = false
        throw new bundle.AppwriteException('Row changed', 409, 'transaction_conflict')
      }
      return stage(params)
    }
    expect(await bundle.backfillOrphanedAt(services.db, NOW)).toEqual({ marked: 1, unchanged: 1 })
    expect(personOf(services, 'pLone')).toMatchObject({ orphanedAt: NOW.toISOString() })
  }, 60_000)
})
