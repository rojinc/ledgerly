import { MAX_OPS_PER_DB_TRANSACTION as MERGE_BATCH } from '@ledgerly/core/constants/limits'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { removeFromTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  markMerged,
  moveIdentities,
  moveMembers,
  moveReminders,
  moveShares,
  moveSubjects,
} from '../src/merge'
import {
  beforeCommit,
  beforeStaging,
  fakes,
  NOW,
  placeholderRow,
  TRY_AGAIN,
  updateRow,
} from './harness'

// P (a placeholder) is merged into U (the caller's person).
const FAR = Number.MAX_SAFE_INTEGER
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
  it('marks a placeholder as merged into U, with the groups of every row of P’s', async () => {
    const store = new FakeDb({
      persons: [U, P],
      members: [
        placeholderRow('m1', 'g2', 'pP', NOW.toISOString()),
        placeholderRow('m2', 'g1', 'pP', NOW.toISOString(), {
          status: 'left',
          joinedOn: '2026-02-01',
          leftOn: '2026-06-30',
        }),
        placeholderRow('m3', 'g3', 'pU', NOW.toISOString(), { status: 'active' }),
        placeholderRow('m4', 'g1', 'pU', NOW.toISOString(), {
          status: 'active',
          joinedOn: '2026-05-01',
        }),
      ],
    } as ConstructorParameters<typeof FakeDb>[0])
    expect(await markMerged(store, 'pP', 'pU', [])).toBe(true)
    const marked = store.rows('persons').find((row) => row.$id === 'pP')
    expect(marked).toMatchObject({ mergedInto: 'pU', mergeGroupIds: ['g1', 'g2'] })
    // And the member dates as they were, P's and U's, so step 3 can plan items as before (B2).
    expect(JSON.parse(marked?.mergeMembersJson as string)).toEqual([
      {
        groupId: 'g1',
        from: { joinedOn: '2026-02-01', leftOn: '2026-06-30' },
        into: { joinedOn: '2026-05-01', leftOn: null },
      },
      { groupId: 'g2', from: { joinedOn: '2026-09-01', leftOn: null }, into: null },
    ])
  })

  it('lists P’s rows once P’s row is staged, so a row added before then is on the list', async () => {
    const store = new FakeDb({
      persons: [U, P],
      members: [placeholderRow('m1', 'g1', 'pP', NOW.toISOString())],
    } as ConstructorParameters<typeof FakeDb>[0])
    // An add that resolved P commits just before the merge stages P's row.
    const { $id, $createdAt, ...added } = placeholderRow('m2', 'g2', 'pP', NOW.toISOString())
    beforeStaging(
      store,
      (operations) => operations.includes('"mergedInto"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'create',
            tableId: 'members',
            rowId: 'm2',
            data: added,
          }),
        ),
    )
    expect(await markMerged(store, 'pP', 'pU', [])).toBe(true)
    expect(store.rows('persons').find((row) => row.$id === 'pP')?.mergeGroupIds).toEqual([
      'g1',
      'g2',
    ])
  })

  it('deletes the keys of P that U hasn’t verified, as it marks P, and keeps the ones U has', async () => {
    const typed = { ...identity(1), verified: false }
    const claimedThrough = { ...identity(2), verified: false }
    const store = db([U, P], [typed, claimedThrough, identity(3, 'pX')])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await markMerged(store, 'pP', 'pU', [claimedThrough.key])).toBe(true)
    expect(store.rows('identities').map((row) => row.$id)).toEqual(['i2', 'i3'])
    // IDs and counts only.
    expect(log).toHaveBeenCalledWith('merge pP into pU: 1 typed keys deleted')
  })

  it('counts P as merged when another claim for U deleted the typed key first', async () => {
    const store = db(
      [U, P],
      [
        { ...identity(1), verified: false },
        { ...identity(2), verified: false },
      ],
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // The other claim marks P and deletes the typed key just before this one stages its delete,
    // which then finds no row: a 404 that withTransaction reports as the race (409) it is.
    beforeStaging(
      store,
      (operations) => operations.includes('"action":"delete"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write(
            { action: 'update', tableId: 'persons', rowId: 'pP', data: { mergedInto: 'pU' } },
            { action: 'delete', tableId: 'identities', rowId: 'i1' },
          ),
        ),
    )
    expect(await markMerged(store, 'pP', 'pU', ['email:p2@example.com'])).toBe(true)
    expect(store.rows('identities').map((row) => row.$id)).toEqual(['i2'])
    // This claim's own step 1 rolled back: it deleted nothing.
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps every key of P that U verified', async () => {
    const keys = [identity(1), identity(2), { ...identity(3), verified: false }]
    const store = db([U, P], keys)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      await markMerged(store, 'pP', 'pU', ['email:p1@example.com', 'email:p2@example.com']),
    ).toBe(true)
    expect(store.rows('identities').map((row) => row.$id)).toEqual(['i1', 'i2'])
  })

  it('logs no deletes when its commit loses to another claim for U', async () => {
    const store = db([U, P], [{ ...identity(1), verified: false }])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    beforeCommit(store, () => updateRow(store, 'persons', 'pP', { mergedInto: 'pU' }))
    expect(await markMerged(store, 'pP', 'pU', [])).toBe(true)
    // That claim's own step 1 decides the keys: this one's deletes rolled back.
    expect(store.rows('identities')).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('deletes nothing when P turns out not to be U’s', async () => {
    const store = db([U, { ...P, userId: 'u2' }], [{ ...identity(1), verified: false }])
    expect(await markMerged(store, 'pP', 'pU', [])).toBe(false)
    expect(store.rows('identities')).toHaveLength(1)
    // Another merge that marks P first, between the read and the staging, rolls this one back.
    const raced = db([U, P], [{ ...identity(1), verified: false }])
    beforeStaging(
      raced,
      (operations) => operations.includes('"mergedInto"'),
      () => updateRow(raced, 'persons', 'pP', { mergedInto: 'pX' }),
    )
    expect(await markMerged(raced, 'pP', 'pU', [])).toBe(false)
    expect(raced.rows('identities')).toHaveLength(1)
  })

  it('counts a placeholder already marked for U as U’s, so a cut-off merge carries on', async () => {
    const store = db([U, { ...P, mergedInto: 'pU' }])
    expect(await markMerged(store, 'pP', 'pU', [])).toBe(true)
  })

  it('leaves alone a person with an account, a deleted one, one merged elsewhere, or none', async () => {
    expect(await markMerged(db([U, { ...P, userId: 'u2' }]), 'pP', 'pU', [])).toBe(false)
    expect(
      await markMerged(db([U, { ...P, deletedAt: '2026-10-01T00:00:00.000Z' }]), 'pP', 'pU', []),
    ).toBe(false)
    expect(await markMerged(db([U, { ...P, mergedInto: 'pX' }]), 'pP', 'pU', [])).toBe(false)
    expect(await markMerged(db([U]), 'pP', 'pU', [])).toBe(false)
  })

  it('loses to another merge or adoption that lands before its staging', async () => {
    const store = db()
    beforeStaging(
      store,
      (operations) => operations.includes('mergedInto'),
      () => updateRow(store, 'persons', 'pP', { mergedInto: 'pX' }),
    )
    expect(await markMerged(store, 'pP', 'pU', [])).toBe(false)
    expect(store.rows('persons').find((row) => row.$id === 'pP')?.mergedInto).toBe('pX')
  })

  it('refuses a P adopted or deleted just before its staging, checked after staging', async () => {
    for (const change of [{ userId: 'u2' }, { deletedAt: '2026-10-18T00:00:00.000Z' }]) {
      const store = db()
      beforeStaging(
        store,
        (operations) => operations.includes('mergedInto'),
        () => updateRow(store, 'persons', 'pP', change),
      )
      expect(await markMerged(store, 'pP', 'pU', [])).toBe(false)
      expect(store.rows('persons').find((row) => row.$id === 'pP')?.mergedInto).toBeNull()
    }
  })

  it('counts P as U’s when a claim for U marked it first, and refuses a P deleted meanwhile', async () => {
    // Its step 2 has moved P's row in g1 already, so this claim mustn't list P's groups again or
    // delete keys that claim kept.
    const first = db([U, P], [{ ...identity(1), verified: false }])
    beforeStaging(
      first,
      (operations) => operations.includes('mergedInto'),
      () => updateRow(first, 'persons', 'pP', { mergedInto: 'pU', mergeGroupIds: ['g1', 'g2'] }),
    )
    expect(await markMerged(first, 'pP', 'pU', [])).toBe(true)
    expect(first.rows('persons').find((row) => row.$id === 'pP')?.mergeGroupIds).toEqual([
      'g1',
      'g2',
    ])
    expect(first.rows('identities')).toHaveLength(1)
    const deleted = db()
    beforeStaging(
      deleted,
      (operations) => operations.includes('mergedInto'),
      () => updateRow(deleted, 'persons', 'pP', { deletedAt: '2026-10-18T00:00:00.000Z' }),
    )
    expect(await markMerged(deleted, 'pP', 'pU', [])).toBe(false)
  })

  it('reads the stored row after a failed commit to see who won', async () => {
    const lost = db()
    beforeCommit(lost, () => updateRow(lost, 'persons', 'pP', { userId: 'u2' }))
    expect(await markMerged(lost, 'pP', 'pU', [])).toBe(false)

    // The same merge running twice at once: the other call marked P for U, so P is U's.
    const twice = db()
    beforeCommit(twice, () => updateRow(twice, 'persons', 'pP', { mergedInto: 'pU' }))
    expect(await markMerged(twice, 'pP', 'pU', [])).toBe(true)
  })
})

describe('moveMembers (step 2)', () => {
  const CREATED = '2026-09-01T00:00:00.000Z'
  const GROUPS = ['g1', 'g2', 'g3']
  const GROUP_ROWS = GROUPS.map((groupId) => ({
    $id: groupId,
    type: 'house',
    name: 'Flat',
    rev: 'r0',
  }))

  /** Every group's row and team exist, with nobody in the team yet. */
  function setUp(seed: Parameters<typeof fakes>[0]) {
    return fakes({ groups: GROUP_ROWS, ...seed }, { teams: { g1: [], g2: [], g3: [] } })
  }

  /** U's own member row, joined. */
  function ownRow(id: string, groupId: string, extra: object = {}) {
    return placeholderRow(id, groupId, 'pU', CREATED, {
      displayName: 'Sam Lee',
      status: 'active',
      joinedOn: '2026-10-01',
      ...extra,
    })
  }

  function activity(id: string, groupId: string, action: string, at: string) {
    return { $id: id, $createdAt: at, at, groupId, actorPersonId: 'pU', action, summary: 'Sam' }
  }

  function members(services: ReturnType<typeof fakes>) {
    return services.db
      .rows('members')
      .map((row) => [row.$id, row.groupId, row.personId, row.status, row.joinedOn])
  }

  function joinedRows(services: ReturnType<typeof fakes>) {
    return services.db
      .rows('activity')
      .filter((row) => row.action === 'member.joined')
      .map((row) => [row.groupId, row.actorPersonId, row.subjectPersonId, row.summary, row.at])
  }

  it('repoints P’s row to U, or keeps U’s with the earlier joinedOn, and joins U to each team', async () => {
    const services = setUp({
      persons: [U, P],
      members: [
        placeholderRow('m1', 'g1', 'pP', CREATED),
        // P moved out before anyone joined.
        placeholderRow('m2', 'g2', 'pP', CREATED, { leftOn: '2026-10-05', role: 'viewer' }),
        placeholderRow('m3', 'g3', 'pP', CREATED, { joinedOn: '2026-08-01' }),
        ownRow('m4', 'g3'),
      ],
    })
    // U was in g3 already, so only g1 and g2 are new to them.
    expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toEqual({
      kept: new Set(),
      joined: ['g1', 'g2'],
      putOff: [],
      done: true,
    })
    expect(members(services)).toEqual([
      ['m1', 'g1', 'pU', 'active', '2026-09-01'],
      ['m2', 'g2', 'pU', 'left', '2026-09-01'],
      ['m4', 'g3', 'pU', 'active', '2026-08-01'],
    ])
    for (const groupId of ['g1', 'g2', 'g3']) {
      expect(services.teams.members(groupId)?.map((member) => member.userId)).toEqual(['u1'])
    }
    expect(joinedRows(services)).toEqual([
      ['g1', 'pU', 'pU', 'joined', NOW.toISOString()],
      ['g2', 'pU', 'pU', 'joined', NOW.toISOString()],
      ['g3', 'pU', 'pU', 'joined', NOW.toISOString()],
    ])
    // Nothing points at P any more: a second run is a no-op.
    expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toEqual({
      kept: new Set(),
      joined: [],
      putOff: [],
      done: true,
    })
  })

  it('keeps a group U left on their own: P keeps its row there, and U stays out of the team', async () => {
    const services = setUp({
      persons: [U, P],
      members: [
        placeholderRow('m1', 'g1', 'pP', CREATED),
        ownRow('m2', 'g1', { status: 'left', role: 'viewer', leftOn: '2026-10-10' }),
        // In g2, U left and then came back (a later member.joined): a fresh membership.
        placeholderRow('m3', 'g2', 'pP', CREATED),
        ownRow('m4', 'g2'),
      ],
      activity: [
        activity('a1', 'g1', 'member.left', '2026-10-10T00:00:00.000Z'),
        activity('a2', 'g2', 'member.left', '2026-10-10T00:00:00.000Z'),
        activity('a3', 'g2', 'member.joined', '2026-10-12T00:00:00.000Z'),
      ],
    })
    expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toEqual({
      kept: new Set(['g1']),
      // U's row in g2 was joined already: P's merges into it, but nothing is new to U.
      joined: [],
      putOff: [],
      done: true,
    })
    expect(members(services)).toEqual([
      ['m1', 'g1', 'pP', 'placeholder', '2026-09-01'],
      ['m2', 'g1', 'pU', 'left', '2026-10-01'],
      ['m4', 'g2', 'pU', 'active', '2026-09-01'],
    ])
    expect(services.teams.members('g1')).toEqual([])
    expect(services.teams.members('g2')?.map((member) => member.userId)).toEqual(['u1'])
  })

  it('answers try again, and takes back the team, when P’s row changed after it was read', async () => {
    const services = setUp({
      persons: [U, P],
      members: [placeholderRow('m1', 'g1', 'pP', CREATED)],
    })
    // An admin marks P as moved out between the list and the staging.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"members"'),
      () => updateRow(services.db, 'members', 'm1', { leftOn: '2026-10-05' }),
    )
    await expect(moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).rejects.toThrow(TRY_AGAIN)
    expect(members(services)).toEqual([['m1', 'g1', 'pP', 'placeholder', '2026-09-01']])
    expect(services.teams.members('g1')).toEqual([])
    expect(joinedRows(services)).toEqual([])
    // The next claim moves it as it is now.
    expect((await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).joined).toEqual(['g1'])
    expect(members(services)).toEqual([['m1', 'g1', 'pU', 'left', '2026-09-01']])
  })

  it('answers try again when U’s row changed after it was read, and U keeps the team', async () => {
    const services = fakes(
      {
        persons: [U, P],
        groups: GROUP_ROWS,
        members: [placeholderRow('m1', 'g1', 'pP', CREATED), ownRow('m2', 'g1')],
      },
      { teams: { g1: ['u1'] } },
    )
    beforeCommit(services.db, () => updateRow(services.db, 'members', 'm2', { role: 'admin' }))
    await expect(moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).rejects.toThrow(TRY_AGAIN)
    expect(members(services).map(([id]) => id)).toEqual(['m1', 'm2'])
    // U's own joined row there keeps them in the team.
    expect(services.teams.members('g1')?.map((member) => member.userId)).toEqual(['u1'])
  })

  it('joins the team again when a parallel failure took it back just before the commit', async () => {
    const services = setUp({
      persons: [U, P],
      members: [placeholderRow('m1', 'g1', 'pP', CREATED)],
    })
    beforeCommit(services.db, () => removeFromTeam(services.teams, 'g1', 'u1'))
    expect((await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).joined).toEqual(['g1'])
    expect(services.teams.members('g1')?.map((member) => member.userId)).toEqual(['u1'])
  })

  it('guards U’s row even when nothing on it changes, so a leave meanwhile runs it again', async () => {
    // U's row is joined already, and since earlier than P's: keeping it changes nothing but `rev`.
    const services = setUp({
      persons: [U, P],
      members: [
        placeholderRow('m1', 'g1', 'pP', CREATED, { joinedOn: '2026-10-05' }),
        ownRow('m2', 'g1'),
      ],
    })
    const writes = vi.spyOn(services.db, 'createOperations')
    // U leaves on their own: their row changes after this merge staged it.
    beforeCommit(services.db, () =>
      updateRow(services.db, 'members', 'm2', { status: 'left', leftOn: '2026-10-18' }),
    )
    await expect(moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).rejects.toThrow(TRY_AGAIN)
    const memberWrites = writes.mock.calls.filter(([params]) =>
      JSON.stringify(params.operations).includes('"members"'),
    )
    expect(JSON.stringify(memberWrites)).toContain('"rev"')
    // P's row is still there for the next claim, which then sees U's leave.
    expect(members(services).map(([id]) => id)).toEqual(['m1', 'm2'])
  })

  it('keeps a pair or employer group U is already in: P keeps its row and shares there', async () => {
    const services = setUp({
      persons: [U, P],
      groups: [
        { $id: 'g1', type: 'pair', name: 'Sam and Sammy' },
        { $id: 'g2', type: 'employer', name: 'Acme' },
        { $id: 'g3', type: 'employer', name: 'Bakery' },
      ],
      members: [
        placeholderRow('m1', 'g1', 'pP', CREATED),
        ownRow('m2', 'g1'),
        // In g2, P is the employer and U the worker.
        placeholderRow('m3', 'g2', 'pP', CREATED),
        ownRow('m4', 'g2', { role: 'admin' }),
        // U isn't in g3: P's row there moves to U, as anywhere else.
        placeholderRow('m5', 'g3', 'pP', CREATED),
      ],
    })
    expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toEqual({
      kept: new Set(['g1', 'g2']),
      joined: ['g3'],
      putOff: [],
      done: true,
    })
    expect(members(services)).toEqual([
      ['m1', 'g1', 'pP', 'placeholder', '2026-09-01'],
      ['m2', 'g1', 'pU', 'active', '2026-10-01'],
      ['m3', 'g2', 'pP', 'placeholder', '2026-09-01'],
      ['m4', 'g2', 'pU', 'active', '2026-10-01'],
      ['m5', 'g3', 'pU', 'active', '2026-09-01'],
    ])
  })

  describe('a leave of U’s own, after U moved out, is final', () => {
    // U moved out of g1 and is still in its team; P has a row there too.
    function movedOut() {
      return fakes(
        {
          persons: [U, P],
          groups: GROUP_ROWS,
          members: [
            placeholderRow('m1', 'g1', 'pP', CREATED),
            ownRow('m2', 'g1', { status: 'left', role: 'viewer', leftOn: '2026-10-10', rev: 'r0' }),
          ],
        },
        { teams: { g1: ['u1'] } },
      )
    }

    /** U leaves on their own, as `groups POST /leave` does: the row's guard, then the team. */
    async function leave(services: ReturnType<typeof fakes>) {
      await withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'members', rowId: 'm2', data: { rev: 'r1' } },
          {
            action: 'create',
            tableId: 'activity',
            rowId: 'aLeft',
            data: {
              groupId: 'g1',
              actorPersonId: 'pU',
              action: 'member.left',
              summary: 'Sam Lee left',
              at: new Date().toISOString(),
            },
          },
        ),
      )
      await removeFromTeam(services.teams, 'g1', 'u1')
    }

    it('runs again when the leave lands after the check, and takes the team back', async () => {
      const services = movedOut()
      // Only the row's rev changes: the comparison must see it.
      beforeStaging(
        services.db,
        (operations) => operations.includes('"members"'),
        () => leave(services),
      )
      await expect(moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).rejects.toThrow(TRY_AGAIN)
      expect(services.teams.members('g1')).toEqual([])
      // The next claim sees the leave: g1 is kept, and U stays out.
      expect((await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).kept).toEqual(
        new Set(['g1']),
      )
      expect(services.teams.members('g1')).toEqual([])
    })

    it('takes the team back when the leave lands before the merge adds U to it', async () => {
      const services = movedOut()
      const add = services.teams.createMembership.bind(services.teams)
      vi.spyOn(services.teams, 'createMembership').mockImplementationOnce(async (params) => {
        await leave(services)
        return (await add(params)) as never
      })
      await expect(moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).rejects.toThrow(TRY_AGAIN)
      expect(services.teams.members('g1')).toEqual([])
    })

    it('takes the team back when the leave lands just after the merge commits', async () => {
      const services = movedOut()
      const commit = services.db.updateTransaction.bind(services.db)
      let done = false
      vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
        const result = await commit(params)
        if (!done && params.commit) {
          done = true
          await leave(services)
        }
        return result
      })
      await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)
      expect(services.teams.members('g1')).toEqual([])
    })

    it('doesn’t count a group U left just after joining it as one U joined', async () => {
      // U had no row in g1: P's row becomes U's, and U leaves it on their own right after.
      const services = fakes(
        {
          persons: [U, P],
          groups: GROUP_ROWS,
          members: [placeholderRow('m1', 'g1', 'pP', CREATED)],
        },
        { teams: { g1: [] } },
      )
      const commit = services.db.updateTransaction.bind(services.db)
      let done = false
      vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
        const result = await commit(params)
        if (!done && params.commit) {
          done = true
          await withTransaction(services.db, (tx) =>
            tx.write(
              { action: 'update', tableId: 'members', rowId: 'm1', data: { status: 'left' } },
              {
                action: 'create',
                tableId: 'activity',
                rowId: 'aLeft',
                data: {
                  groupId: 'g1',
                  actorPersonId: 'pU',
                  action: 'member.left',
                  summary: 'Sam Lee left',
                  at: new Date(Date.now() + 1000).toISOString(),
                },
              },
            ),
          )
        }
        return result
      })
      // So it isn't in linkedGroupIds.
      expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toMatchObject({
        joined: [],
        done: true,
      })
      expect(services.teams.members('g1')).toEqual([])
    })
  })

  it('starts no row once the deadline has passed', async () => {
    const services = setUp({
      persons: [U, P],
      members: [placeholderRow('m1', 'g1', 'pP', CREATED)],
    })
    expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, 0)).toEqual({
      kept: new Set(),
      joined: [],
      putOff: [],
      done: false,
    })
    expect(members(services)).toEqual([['m1', 'g1', 'pP', 'placeholder', '2026-09-01']])
  })

  describe('a group with a statement being finalized waits whole', () => {
    const FINALIZING = {
      $id: 'st1',
      groupId: 'g1',
      status: 'finalizing',
      periodStart: '2026-09-01',
    }

    function withP(statements: object[] = [{ ...FINALIZING, status: 'draft' }]) {
      return setUp({
        persons: [U, P],
        members: [
          placeholderRow('m1', 'g1', 'pP', CREATED),
          placeholderRow('m2', 'g2', 'pP', CREATED),
        ],
        statements,
      } as Parameters<typeof fakes>[0])
    }

    /** As finalize step 1 does it: the group's guard, with `finalizing`. */
    function startFinalize(services: ReturnType<typeof fakes>) {
      return withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'groups', rowId: 'g1', data: { rev: 'rFinalize' } },
          { action: 'update', tableId: 'statements', rowId: 'st1', data: { status: 'finalizing' } },
        ),
      )
    }

    it('keeps P’s row there, and U out of its team, while the other groups go on', async () => {
      const services = withP([FINALIZING])
      const adds = vi.spyOn(services.teams, 'createMembership')
      expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toEqual({
        kept: new Set(),
        joined: ['g2'],
        putOff: ['g1'],
        done: false,
      })
      expect(members(services)).toEqual([
        ['m1', 'g1', 'pP', 'placeholder', '2026-09-01'],
        ['m2', 'g2', 'pU', 'active', '2026-09-01'],
      ])
      // Never added, so never taken out again.
      expect(adds.mock.calls.map(([params]) => params.teamId)).toEqual(['g2', 'g2'])
      expect(services.teams.members('g1')).toEqual([])
    })

    it('puts it off when the finalize starts after the first check, and takes back the team', async () => {
      const services = withP()
      beforeStaging(
        services.db,
        (operations) => operations.includes('"groups"'),
        () => startFinalize(services),
      )
      expect(await moveMembers(services, 'u1', 'pP', 'pU', ['g1'], FAR)).toMatchObject({
        putOff: ['g1'],
        done: false,
      })
      expect(members(services)[0]).toEqual(['m1', 'g1', 'pP', 'placeholder', '2026-09-01'])
      expect(services.teams.members('g1')).toEqual([])
    })

    it('fails its commit when the finalize starts after its check, then puts it off', async () => {
      const services = withP()
      beforeCommit(services.db, () => startFinalize(services))
      await expect(moveMembers(services, 'u1', 'pP', 'pU', ['g1'], FAR)).rejects.toThrow(TRY_AGAIN)
      expect(members(services)[0]).toEqual(['m1', 'g1', 'pP', 'placeholder', '2026-09-01'])
      expect(services.teams.members('g1')).toEqual([])
      expect(await moveMembers(services, 'u1', 'pP', 'pU', ['g1'], FAR)).toMatchObject({
        putOff: ['g1'],
      })
    })
  })

  it('counts a row another merge moved meanwhile as done', async () => {
    const services = setUp({
      persons: [U, P],
      members: [placeholderRow('m1', 'g1', 'pP', CREATED)],
    })
    beforeCommit(services.db, () =>
      updateRow(services.db, 'members', 'm1', { personId: 'pU', status: 'active' }),
    )
    expect(await moveMembers(services, 'u1', 'pP', 'pU', GROUPS, FAR)).toEqual({
      kept: new Set(),
      joined: [],
      putOff: [],
      done: true,
    })
    expect(services.teams.members('g1')?.map((member) => member.userId)).toEqual(['u1'])
  })
})

describe('moveIdentities (step 3)', () => {
  it('repoints every identity of P to U, a batch at a time', async () => {
    const count = MERGE_BATCH + 5
    const store = db(
      [U, P],
      [...Array.from({ length: count }, (_, n) => identity(n)), identity(999, 'pU')],
    )
    expect(await moveIdentities(store, 'pP', 'pU', FAR)).toBe(count)
    expect(store.rows('identities').every((row) => row.personId === 'pU')).toBe(true)
    // Nothing left to move: a second run is a no-op.
    expect(await moveIdentities(store, 'pP', 'pU', FAR)).toBe(0)
  })

  it('never overwrites an identity that changed after it was listed', async () => {
    const store = db([U, P, { ...P, $id: 'pX' }], [identity(1), identity(2)])
    // Another merge takes i1 for pX between the list and the staging.
    beforeStaging(
      store,
      (operations) => operations.includes('i1'),
      () => identityUpdate(store, 'i1', { personId: 'pX' }),
    )
    expect(await moveIdentities(store, 'pP', 'pU', FAR)).toBe(1)
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
    expect(await moveIdentities(store, 'pP', 'pU', FAR)).toBe(1)
    expect(store.rows('identities')[0]?.personId).toBe('pU')
  })
})

describe('moveShares (step 3)', () => {
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

  function seed(shares: object[], statements: object[] = [], balances: object[] = []) {
    return new FakeDb({
      persons: [U, P],
      groups: [
        { $id: 'g1', type: 'house', name: 'Flat', rev: 'r0' },
        { $id: 'g2', type: 'house', name: 'Old flat', rev: 'r0' },
      ],
      // Step 2 has joined U to both: each batch guards U's row (#242 D/E).
      members: ['g1', 'g2'].map((groupId) =>
        placeholderRow(`mU-${groupId}`, groupId, 'pU', NOW.toISOString(), { status: 'active' }),
      ),
      shares,
      statements,
      balances,
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
    expect(await moveShares(store, 'pP', 'pU', ['g1'], FAR)).toEqual({
      moved: 2,
      putOff: [],
      done: true,
    })
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

  it('drops a combined share that comes to 0/0, as buildShares keeps none', async () => {
    // An adjustment that moved 3 from U to P: once P is U, it cancels out.
    const store = seed([share('s1', 't1', 'pP', 300, 0), share('s2', 't1', 'pU', -300, 0)])
    expect(await moveShares(store, 'pP', 'pU', ['g1'], FAR)).toMatchObject({ moved: 1 })
    expect(store.rows('shares')).toEqual([])
  })

  it('moves shares only in the groups it is given, and puts off one that is finalizing', async () => {
    const store = seed(
      [
        share('s1', 't1', 'pP', 100, 0, 'g1'),
        share('s2', 't1', 'pX', 0, 100, 'g1'),
        share('s3', 't2', 'pP', 100, 0, 'g2'),
        share('s4', 't2', 'pX', 0, 100, 'g2'),
      ],
      [{ $id: 'st1', groupId: 'g2', status: 'finalizing', periodStart: '2026-09-01' }],
    )
    // g1 isn't one of them (a kept group, say).
    expect(await moveShares(store, 'pP', 'pU', ['g2'], FAR)).toEqual({
      moved: 0,
      putOff: ['g2'],
      done: false,
    })
    expect(store.rows('shares').filter((row) => row.personId === 'pP')).toHaveLength(2)
    // The put-off group's guard rolled back with its batch.
    expect(store.rows('groups').find((row) => row.$id === 'g2')?.rev).toBe('r0')
  })

  it('moves 250 shares in batches of at most 90 writes, each with the group’s guard', async () => {
    const shares = Array.from({ length: 250 }, (_, n) => share(`s${n}`, `t${n}`, 'pP', 0, 100))
    const store = seed(shares)
    const commits = vi.spyOn(store, 'createOperations')
    expect((await moveShares(store, 'pP', 'pU', ['g1'], FAR)).moved).toBe(250)
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

  it('deletes the balances row of each group whose shares it moves, where there is one', async () => {
    const store = seed(
      [
        share('s1', 't1', 'pP', 100, 0, 'g1'),
        share('s2', 't1', 'pX', 0, 100, 'g1'),
        share('s3', 't2', 'pP', 100, 0, 'g2'),
        share('s4', 't2', 'pX', 0, 100, 'g2'),
      ],
      [],
      [
        { $id: 'g1', peopleJson: '[]' },
        { $id: 'g3', peopleJson: '[]' },
      ],
    )
    expect((await moveShares(store, 'pP', 'pU', ['g1', 'g2', 'g3'], FAR)).moved).toBe(2)
    // g2 had none, and nothing of P's was in g3.
    expect(store.rows('balances').map((row) => row.$id)).toEqual(['g3'])
  })

  it('keeps each batch within 90 writes with the balances row delete, every share combined', async () => {
    const shares = Array.from({ length: 100 }, (_, n) => [
      share(`p${n}`, `t${n}`, 'pP', 0, 100),
      share(`u${n}`, `t${n}`, 'pU', 100, 0),
    ]).flat()
    const store = seed(shares, [], [{ $id: 'g1', peopleJson: '[]' }])
    const commits = vi.spyOn(store, 'createOperations')
    expect((await moveShares(store, 'pP', 'pU', ['g1'], FAR)).moved).toBe(100)
    const perTransaction = new Map<string, unknown[]>()
    for (const [params] of commits.mock.calls) {
      perTransaction.set(params.transactionId, [
        ...(perTransaction.get(params.transactionId) ?? []),
        ...(params.operations ?? []),
      ])
    }
    const sizes = [...perTransaction.values()].map((operations) => operations.length)
    // The first: the group's guard, U's row guard, the delete and 43 combined shares, two writes
    // each.
    expect(sizes[0]).toBe(MERGE_BATCH - 1)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MERGE_BATCH)
    expect(store.rows('balances')).toEqual([])
  })

  // #242 D/E: each batch guards U's member row, then checks it as stored.
  it.each([
    [
      'an admin removes U’s row',
      [{ action: 'delete' as const, tableId: 'members' as const, rowId: 'mU-g1' }],
    ],
    [
      'U leaves on their own',
      [
        {
          action: 'update' as const,
          tableId: 'members' as const,
          rowId: 'mU-g1',
          data: { status: 'left', role: 'viewer', leftOn: '2026-10-18' },
        },
        {
          action: 'create' as const,
          tableId: 'activity' as const,
          rowId: 'aLeft',
          data: {
            groupId: 'g1',
            action: 'member.left',
            summary: 'left',
            at: '2026-10-18T00:00:00.000Z',
            actorPersonId: 'pU',
            subjectPersonId: 'pU',
          },
        },
      ],
    ],
  ])('moves no share onto U when %s just before a batch', async (_, writes) => {
    const store = seed([share('s1', 't1', 'pP', 0, 4500), share('s2', 't1', 'pX', 4500, 0)])
    beforeStaging(
      store,
      (operations) => operations.includes('"groups"'),
      () => withTransaction(store, (tx) => tx.write(...writes)),
    )
    expect(await moveShares(store, 'pP', 'pU', ['g1'], FAR)).toEqual({
      moved: 0,
      putOff: [],
      done: true,
    })
    // P's share stays P's, and stray() keeps the merge open (run-merge.ts).
    expect(store.rows('shares').map((row) => row.personId)).toEqual(['pP', 'pX'])
  })

  it('fails a batch whose U row a removal deletes after it was guarded, and then moves nothing', async () => {
    const store = seed([share('s1', 't1', 'pP', 0, 4500), share('s2', 't1', 'pX', 4500, 0)])
    beforeCommit(store, () =>
      withTransaction(store, (tx) =>
        tx.write({ action: 'delete', tableId: 'members', rowId: 'mU-g1' }),
      ),
    )
    expect((await moveShares(store, 'pP', 'pU', ['g1'], FAR)).moved).toBe(0)
    expect(store.rows('shares').map((row) => row.personId)).toEqual(['pP', 'pX'])
  })

  it('runs a batch again when the balances row is deleted after it was read', async () => {
    const store = seed(
      [share('s1', 't1', 'pP', 0, 100), share('s2', 't1', 'pX', 100, 0)],
      [],
      [{ $id: 'g1', peopleJson: '[]' }],
    )
    const raced = beforeStaging(
      store,
      (operations) => operations.includes('"balances"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({ action: 'delete', tableId: 'balances', rowId: 'g1' }),
        ),
    )
    expect((await moveShares(store, 'pP', 'pU', ['g1'], FAR)).moved).toBe(1)
    expect(raced).toHaveBeenCalled()
    expect(store.rows('shares').map((row) => row.personId)).toEqual(['pU', 'pX'])
    expect(store.rows('balances')).toEqual([])
  })

  it('starts no batch, and no identity, once the deadline has passed', async () => {
    const identities = db([U, P], [identity(1)])
    expect(await moveIdentities(identities, 'pP', 'pU', 0)).toBe(0)
    expect(identities.rows('identities')[0]?.personId).toBe('pP')
    const store = seed([share('s1', 't1', 'pP', 0, 100)])
    expect(await moveShares(store, 'pP', 'pU', ['g1'], 0)).toEqual({
      moved: 0,
      putOff: [],
      done: false,
    })
    expect(store.rows('shares')[0]?.personId).toBe('pP')
  })

  it('gives U one share when two of U’s placeholders are merged at once (I-5)', async () => {
    // t1: X paid 60 for P and P2, U's two placeholders.
    const store = seed([
      share('s1', 't1', 'pP', 0, 3000),
      share('s2', 't1', 'pP2', 0, 3000),
      share('s3', 't1', 'pX', 6000, 0),
    ])
    // P2's merge lands as P's batch starts: s2 is U's now.
    beforeStaging(
      store,
      (operations) => operations.includes('"rev"'),
      () => moveShares(store, 'pP2', 'pU', ['g1'], FAR),
    )
    await moveShares(store, 'pP', 'pU', ['g1'], FAR)
    expect(
      store.rows('shares').map((row) => [row.personId, row.givenCents, row.receivedCents]),
    ).toEqual([
      ['pU', 0, 6000],
      ['pX', 6000, 0],
    ])
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
    await moveShares(store, 'pP', 'pU', ['g1'], FAR)
    expect(
      store.rows('shares').map((row) => [row.personId, row.givenCents, row.receivedCents]),
    ).toEqual([['pU', 3000, 3000]])
  })
})

describe('moveReminders (step 3)', () => {
  function sentTo(n: number, groupId = 'g1', toPersonId = 'pP') {
    return {
      $id: `r${String(n).padStart(3, '0')}`,
      groupId,
      sentBy: 'pX',
      toPersonId,
      channel: 'email',
      sentAt: NOW.toISOString(),
    }
  }

  function seed(reminders: object[]) {
    return new FakeDb({ persons: [U, P], reminders } as ConstructorParameters<typeof FakeDb>[0])
  }

  it('makes every reminder P was sent to U, but in kept groups, in batches of at most 90', async () => {
    const store = seed([
      ...Array.from({ length: 100 }, (_, n) => sentTo(n, `g${n % 3}`)),
      // A kept group's, and one to someone else.
      sentTo(100, 'gKept'),
      sentTo(101, 'g1', 'pX'),
    ])
    const commits = vi.spyOn(store, 'createOperations')
    expect(await moveReminders(store, 'pP', 'pU', new Set(['gKept']), FAR)).toEqual({
      moved: 100,
      done: true,
    })
    const to = store.rows('reminders').map((row) => row.toPersonId)
    expect(to.filter((id) => id === 'pU')).toHaveLength(100)
    expect(to.slice(100)).toEqual(['pP', 'pX'])
    // Only the recipient changes.
    expect(store.rows('reminders')[0]).toMatchObject({ ...sentTo(0, 'g0'), toPersonId: 'pU' })
    const sizes = new Map<string, number>()
    for (const [params] of commits.mock.calls) {
      sizes.set(
        params.transactionId,
        (sizes.get(params.transactionId) ?? 0) + (params.operations?.length ?? 0),
      )
    }
    expect([...sizes.values()]).toEqual([MERGE_BATCH, 10])
  })

  it('runs a batch again when a purge deletes one of its rows first', async () => {
    const store = seed([sentTo(1), sentTo(2)])
    beforeStaging(
      store,
      (operations) => operations.includes('"toPersonId"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({ action: 'delete', tableId: 'reminders', rowId: 'r001' }),
        ),
    )
    expect(await moveReminders(store, 'pP', 'pU', new Set(), FAR)).toEqual({
      moved: 1,
      done: true,
    })
    expect(store.rows('reminders').map((row) => [row.$id, row.toPersonId])).toEqual([
      ['r002', 'pU'],
    ])
  })

  it('runs a batch again when another run of the merge moved a row first', async () => {
    const store = seed([sentTo(1), sentTo(2)])
    beforeStaging(
      store,
      (operations) => operations.includes('"toPersonId"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'reminders',
            rowId: 'r001',
            data: { toPersonId: 'pU' },
          }),
        ),
    )
    expect(await moveReminders(store, 'pP', 'pU', new Set(), FAR)).toEqual({
      moved: 1,
      done: true,
    })
    expect(store.rows('reminders').every((row) => row.toPersonId === 'pU')).toBe(true)
  })

  it('starts nothing once the deadline has passed', async () => {
    const store = seed([sentTo(1)])
    expect(await moveReminders(store, 'pP', 'pU', new Set(), 0)).toEqual({
      moved: 0,
      done: false,
    })
    expect(store.rows('reminders')[0]?.toPersonId).toBe('pP')
  })
})

describe('moveSubjects (step 3)', () => {
  function about(n: number, groupId = 'g1', subjectPersonId = 'pP') {
    return {
      $id: `a${String(n).padStart(3, '0')}`,
      groupId,
      actorPersonId: 'pX',
      action: 'member.added',
      subjectPersonId,
      summary: 'was added',
      at: NOW.toISOString(),
    }
  }

  function seed(activity: object[]) {
    return new FakeDb({ persons: [U, P], activity } as ConstructorParameters<typeof FakeDb>[0])
  }

  it('makes every activity row about P in its groups about U, in batches of at most 90', async () => {
    const store = seed([
      ...Array.from({ length: 100 }, (_, n) => about(n)),
      // Not one of the groups it was given (a kept group's), and not about P.
      about(100, 'g2'),
      about(101, 'g1', 'pX'),
    ])
    const commits = vi.spyOn(store, 'createOperations')
    expect(await moveSubjects(store, 'pP', 'pU', ['g1'], FAR)).toEqual({ moved: 100, done: true })
    const subjects = store.rows('activity').map((row) => row.subjectPersonId)
    expect(subjects.filter((id) => id === 'pU')).toHaveLength(100)
    // Only the subject changes.
    expect(store.rows('activity')[0]).toMatchObject({ ...about(0), subjectPersonId: 'pU' })
    expect(subjects.slice(100)).toEqual(['pP', 'pX'])
    const sizes = new Map<string, number>()
    for (const [params] of commits.mock.calls) {
      sizes.set(
        params.transactionId,
        (sizes.get(params.transactionId) ?? 0) + (params.operations?.length ?? 0),
      )
    }
    expect([...sizes.values()]).toEqual([MERGE_BATCH, 10])
  })

  it('runs a batch again when a purge deletes one of its rows first', async () => {
    const store = seed([about(1), about(2)])
    beforeStaging(
      store,
      (operations) => operations.includes('"subjectPersonId"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({ action: 'delete', tableId: 'activity', rowId: 'a001' }),
        ),
    )
    expect(await moveSubjects(store, 'pP', 'pU', ['g1'], FAR)).toEqual({ moved: 1, done: true })
    expect(store.rows('activity').map((row) => [row.$id, row.subjectPersonId])).toEqual([
      ['a002', 'pU'],
    ])
  })

  it('runs a batch again when another run of the merge moved a row first', async () => {
    const store = seed([about(1), about(2)])
    beforeStaging(
      store,
      (operations) => operations.includes('"subjectPersonId"'),
      () =>
        withTransaction(store, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'activity',
            rowId: 'a001',
            data: { subjectPersonId: 'pU' },
          }),
        ),
    )
    expect(await moveSubjects(store, 'pP', 'pU', ['g1'], FAR)).toEqual({ moved: 1, done: true })
    expect(store.rows('activity').every((row) => row.subjectPersonId === 'pU')).toBe(true)
  })

  it('starts nothing once the deadline has passed', async () => {
    const store = seed([about(1)])
    expect(await moveSubjects(store, 'pP', 'pU', ['g1'], 0)).toEqual({ moved: 0, done: false })
    expect(store.rows('activity')[0]?.subjectPersonId).toBe('pP')
  })
})
