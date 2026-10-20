import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { cleanUpPlaceholders } from '../src/steps/placeholder-cleanup'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  fakes,
  member,
  NOW,
  person,
} from './harness'

// scheduling.md#step-5c-placeholder-clean-up
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const REV = /^[a-z0-9]{20}$/

/** A placeholder named after its ID, whose last member row went `orphanedAt`. */
function placeholder($id: string, orphanedAt: string | null, extra: object = {}) {
  return { ...person($id, null), displayName: `Name of ${$id}`, orphanedAt, ...extra }
}

function identity($id: string, personId: string) {
  return { $id, key: `email:${$id}@example.com`, type: 'email', personId, verified: false }
}

// pLone and pOld have no member row; pOld also has a phone. pOther is someone else's.
function seeded(
  extra: { persons?: object[]; members?: object[]; identities?: object[]; invites?: object[] } = {},
): Fakes {
  return fakes({
    persons: [
      placeholder('pLone', ago(30 * DAY)),
      placeholder('pOld', ago(400 * DAY)),
      person('pOther', 'u1'),
      ...((extra.persons ?? []) as ReturnType<typeof placeholder>[]),
    ],
    identities: [
      identity('iLone', 'pLone'),
      identity('iOld', 'pOld'),
      { ...identity('iOldPhone', 'pOld'), key: 'phone:+61412345678', type: 'phone' },
      identity('iOther', 'pOther'),
      ...((extra.identities ?? []) as ReturnType<typeof identity>[]),
    ],
    members: [member('g1', 'pOther'), ...((extra.members ?? []) as ReturnType<typeof member>[])],
    ...(extra.invites ? { invites: extra.invites as ReturnType<typeof invite>[] } : {}),
  })
}

/** An invite sent 40 days ago to `key`, for a member row long gone. */
function invite($id: string, key: string) {
  return {
    $id,
    groupId: 'g9',
    memberId: 'mGone',
    identityKey: key,
    tokenHash: `hash-${$id}`,
    channel: 'email',
    invitedBy: 'pOther',
    sentAt: ago(40 * DAY),
    expiresAt: ago(26 * DAY),
    acceptedAt: null,
  }
}

const personOf = (services: Fakes, id: string) =>
  services.db.rows('persons').find((row) => row.$id === id)
const identityIds = (services: Fakes) => services.db.rows('identities').map((row) => row.$id)

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('step 5c: placeholder clean-up', () => {
  it("deletes the invites to a cleared placeholder's keys, and no others", async () => {
    const services = seeded({
      invites: [
        invite('vLone', 'email:iLone@example.com'),
        invite('vPhone', 'phone:+61412345678'),
        invite('vOther', 'email:iOther@example.com'),
      ],
    })
    expect((await cleanUpPlaceholders(services)).cleared).toBe(2)
    expect(services.db.rows('invites').map((row) => row.$id)).toEqual(['vOther'])
  })

  it('clears a lone placeholder 30 days after its last member row went, and keeps its row', async () => {
    const services = seeded()
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 2,
      kept: 0,
      skipped: 0,
      failed: 0,
    })
    expect(identityIds(services)).toEqual(['iOther'])
    for (const id of ['pLone', 'pOld']) {
      expect(personOf(services, id)).toMatchObject({
        displayName: 'Former member',
        orphanedAt: null,
        rev: expect.stringMatching(REV),
        userId: null,
      })
    }
    expect(personOf(services, 'pLone')?.rev).not.toBe(personOf(services, 'pOld')?.rev)
    expect(personOf(services, 'pOther')).toMatchObject({ displayName: 'pOther' })
    expect(errors).not.toHaveBeenCalled()
    // Nothing matches any more.
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 0,
      kept: 0,
      skipped: 0,
      failed: 0,
    })
  })

  it.each([
    ['re-added', {}, true],
    ['claimed', { userId: 'u2', claimedAt: ago(2 * DAY) }, false],
    ['merged', { mergedInto: 'pOther' }, false],
    ['a deleted account', { userId: 'u2', deletedAt: ago(DAY) }, false],
  ])('keeps a placeholder %s since as it is, and clears its orphanedAt', async (_, change, row) => {
    const services = seeded({
      persons: [placeholder('pBack', ago(31 * DAY), change)],
      members: row ? [member('g1', 'pBack', { status: 'placeholder', role: 'member' })] : [],
      identities: [identity('iBack', 'pBack')],
    })
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 2,
      kept: 1,
      skipped: 0,
      failed: 0,
    })
    expect(personOf(services, 'pBack')).toMatchObject({
      ...change,
      displayName: 'Name of pBack',
      orphanedAt: null,
      rev: expect.stringMatching(REV),
    })
    expect(identityIds(services)).toEqual(['iOther', 'iBack'])
  })

  it('leaves alone a person whose orphanedAt is newer than the cutoff, or has none', async () => {
    const services = seeded({
      persons: [
        placeholder('pRecent', ago(30 * DAY - 1)),
        placeholder('pNever', null),
        { ...person('pAccount', 'u2'), orphanedAt: ago(DAY) },
      ],
    })
    const before = ['pRecent', 'pNever', 'pAccount'].map((id) => personOf(services, id))
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 2,
      kept: 0,
      skipped: 0,
      failed: 0,
    })
    expect(['pRecent', 'pNever', 'pAccount'].map((id) => personOf(services, id))).toEqual(before)
  })

  it('skips a person whose orphanedAt a removal set again after it was listed, writing nothing', async () => {
    const services = seeded()
    const read = services.db.getRow.bind(services.db)
    let done = false
    // Re-added, then removed again, between the query and the first read.
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      if (!done && params.rowId === 'pLone') {
        done = true
        await setPerson(services, 'pLone', { orphanedAt: ago(DAY), rev: 'removal' })
      }
      return read(params)
    })
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 1,
      kept: 0,
      skipped: 1,
      failed: 0,
    })
    expect(personOf(services, 'pLone')).toMatchObject({
      displayName: 'Name of pLone',
      orphanedAt: ago(DAY),
      rev: 'removal',
    })
    expect(identityIds(services)).toEqual(['iLone', 'iOther'])
  })

  it('rolls back when orphanedAt changes between the decision and the re-check, and the next run decides again', async () => {
    const services = seeded()
    // A removal's write lands after the decision, before this run stages its own.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rowId":"pLone"'),
      () => setPerson(services, 'pLone', { orphanedAt: ago(35 * DAY), rev: 'removal' }),
    )
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 1,
      kept: 0,
      skipped: 1,
      failed: 0,
    })
    expect(personOf(services, 'pLone')).toMatchObject({
      displayName: 'Name of pLone',
      orphanedAt: ago(35 * DAY),
    })
    expect(identityIds(services)).toEqual(['iLone', 'iOther'])
    vi.restoreAllMocks()
    expect(await cleanUpPlaceholders(services)).toMatchObject({ cleared: 1, skipped: 0 })
    expect(identityIds(services)).toEqual(['iOther'])
  })

  // groups POST /groups/{id}/members finding pLone by its email: a guard on the person, and a row.
  const add = (services: Fakes) => () =>
    withTransaction(services.db, (tx) => {
      const { $id, ...row } = member('g2', 'pLone', { status: 'placeholder', role: 'member' })
      return tx.write(
        { action: 'update', tableId: 'persons', rowId: 'pLone', data: { rev: 'add' } },
        {
          action: 'create',
          tableId: 'members',
          rowId: 'g2-pLone',
          data: row,
        },
      )
    })

  it.each([
    ['after it staged its writes, failing its commit', 'commit'],
    ['after it decided, before it staged', 'staging'],
  ])('skips a person an add gives a member row %s, and the next run keeps it', async (_, when) => {
    const services = seeded()
    if (when === 'commit') {
      beforeCommit(services.db, add(services))
    } else {
      beforeStaging(services.db, (operations) => operations.includes('"pLone"'), add(services))
    }
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 1,
      kept: 0,
      skipped: 1,
      failed: 0,
    })
    expect(personOf(services, 'pLone')).toMatchObject({
      displayName: 'Name of pLone',
      orphanedAt: ago(30 * DAY),
      rev: 'add',
    })
    expect(identityIds(services)).toEqual(['iLone', 'iOther'])
    expect(errors).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 0,
      kept: 1,
      skipped: 0,
      failed: 0,
    })
    expect(personOf(services, 'pLone')).toMatchObject({
      displayName: 'Name of pLone',
      orphanedAt: null,
    })
    expect(identityIds(services)).toEqual(['iLone', 'iOther'])
  })

  it('ends the step when a commit fails for another reason, with one error line of counts and the error', async () => {
    const services = seeded()
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    // pLone commits; pOld's commit fails.
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (params.commit && ++commits === 2) {
        throw new AppwriteException('Server error', 500, 'general_unknown')
      }
      return commit(params)
    })
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 1,
      kept: 0,
      skipped: 0,
      failed: 1,
    })
    expect(personOf(services, 'pOld')).toMatchObject({ displayName: 'Name of pOld' })
    expect(identityIds(services)).toEqual(['iOld', 'iOldPhone', 'iOther'])
    expect(errors).toHaveBeenCalledTimes(1)
    const line = String(errors.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      fn: 'unknown',
      event: 'placeholder_cleanup_failed',
      counts: { cleared: 1, kept: 0, skipped: 0, failed: 1 },
      cause: 'AppwriteException 500 general_unknown',
    })
    expect(line).not.toMatch(/Name of|@|\+61|pOld|pLone/)
  })

  it('ends the step at the first failure, leaving the people after it to the next run', async () => {
    const services = seeded({ persons: [placeholder('pThird', ago(31 * DAY))] })
    vi.spyOn(services.db, 'updateTransaction').mockRejectedValueOnce(
      new AppwriteException('Server error', 500, 'general_unknown'),
    )
    expect(await cleanUpPlaceholders(services)).toEqual({
      cleared: 0,
      kept: 0,
      skipped: 0,
      failed: 1,
    })
    expect(personOf(services, 'pThird')?.orphanedAt).toBe(ago(31 * DAY))
    vi.restoreAllMocks()
    expect(await cleanUpPlaceholders(services)).toMatchObject({ cleared: 3, failed: 0 })
  })

  it('stops when the run is out of time, and the next run clears the rest', async () => {
    const services = many(150)
    let read = 0
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'persons') read += 1
      return list(params)
    })
    // Out of time once the second page is read, before any of its rows.
    services.outOfTime = () => read >= 2
    expect(await cleanUpPlaceholders(services)).toMatchObject({ cleared: 100 })
    services.outOfTime = () => false
    expect(await cleanUpPlaceholders(services)).toMatchObject({ cleared: 50 })
  })

  it.each([
    [59_999, 150],
    [60_000, 100],
  ])(
    'stops a minute after it starts, though the run has time left (page 2 read at %i ms: %i cleared)',
    async (at, cleared) => {
      const services = many(150)
      let clock = 0
      let read = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const list = services.db.listRows.bind(services.db)
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        if (params.tableId === 'persons') read += 1
        if (read === 2) clock = at
        return list(params)
      })
      expect(await cleanUpPlaceholders(services)).toEqual({
        cleared,
        kept: 0,
        skipped: 0,
        failed: 0,
      })
    },
  )

  it('runs in the hourly run after step 5b, which returns its counts, and step 6 still runs when its query fails', async () => {
    const services = seeded()
    const { body } = await call(services, 'POST', '/', { userId: null, scheduled: true })
    expect(body).toMatchObject({
      ok: true,
      data: { placeholders: { cleared: 2, kept: 0, skipped: 0, failed: 0 } },
    })
    const failing = seeded()
    const list = failing.db.listRows.bind(failing.db)
    const order: string[] = []
    vi.spyOn(failing.db, 'listRows').mockImplementation(async (params) => {
      const ours = JSON.stringify(params.queries).includes('orphanedAt')
      order.push(ours ? 'step 5c' : params.tableId)
      if (ours) throw new AppwriteException('Server error', 500, 'general_unknown')
      return list(params)
    })
    const run = await call(failing, 'POST', '/', { userId: null, scheduled: true })
    expect(run.body).toMatchObject({
      ok: true,
      data: {
        placeholders: { cleared: 0, kept: 0, skipped: 0, failed: 0 },
        nightly: expect.any(Object),
      },
    })
    // Once, after step 5b's invites and before step 6's groups.
    expect(order.filter((table) => table === 'step 5c')).toHaveLength(1)
    expect(order.lastIndexOf('invites')).toBeLessThan(order.indexOf('step 5c'))
    expect(order.indexOf('step 5c')).toBeLessThan(order.lastIndexOf('groups'))
    const events = errors.mock.calls.map(([text]) => JSON.parse(String(text)).event)
    expect(events.filter((event) => event === 'placeholder_cleanup_failed')).toHaveLength(1)
  })
})

/** `count` lone placeholders orphaned 31 days ago, with no identities. */
function many(count: number): Fakes {
  return fakes({
    persons: Array.from({ length: count }, (_, index) =>
      placeholder(`p${String(index).padStart(3, '0')}`, ago(31 * DAY)),
    ),
  })
}

function setPerson(services: Fakes, rowId: string, data: object) {
  return withTransaction(services.db, (tx) =>
    tx.write({ action: 'update', tableId: 'persons', rowId, data: { ...data } }),
  )
}
