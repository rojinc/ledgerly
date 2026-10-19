import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import {
  beforeCommit,
  beforeStaging,
  call,
  failure,
  fakes,
  group,
  member,
  ok,
  person,
  share,
} from './harness'

// identity-and-invites.md#while-a-merge-is-open-in-a-group. Person 2 (u2) is U, and pP, a
// placeholder merged into them, still has an identity: step 2 has moved pP's row in g1 to U
// (m2 is that row now), but pP's share there hasn't moved yet. Open per group: whatever the
// merge's state elsewhere, it's open in g1 while g1 still names pP.
const P = {
  $id: 'pP',
  userId: null,
  displayName: 'Sammy',
  claimedAt: null,
  mergedInto: 'p2',
  mergeGroupIds: ['g1'],
  deletedAt: null,
}
const PHONE = {
  $id: 'iP',
  key: 'phone:+61412345678',
  type: 'phone',
  personId: 'pP',
  verified: true,
}

const PS_SHARES = [share('s1', 'g1', 'pP', 0, 500), share('s2', 'g1', 'p1', 500, 0)]

function open(
  more: {
    persons?: object[]
    identities?: object[]
    members?: object[]
    shares?: object[]
    transactions?: object[]
  } = {},
) {
  return fakes(
    {
      persons: [person(1), person(2), ...(more.persons ?? [P])],
      identities: more.identities ?? [PHONE],
      groups: [group('g1', 'house')],
      members: [
        member('m1', 'g1', 'p1', 'admin', 'active'),
        member('m2', 'g1', 'p2', 'member', 'active'),
        ...(more.members ?? []),
      ],
      // pP's share is still pP's: U's balance alone is 0.
      shares: more.shares ?? PS_SHARES,
      transactions: more.transactions ?? [],
    } as never,
    { g1: ['u1', 'u2'] },
  )
}

const MERGING = { status: 409, code: 'CONFLICT' }

describe('while a merge into the member is open in the group', () => {
  it('refuses their leave, with the merging reason, and changes nothing', async () => {
    const services = open()
    const { body } = await call(services, 'POST', '/groups/g1/leave', undefined, 'u2')
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', details: { reason: 'merging' } },
    })
    expect(services.db.rows('members').find((row) => row.$id === 'm2')?.status).toBe('active')
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('refuses removing them, before their team membership is touched', async () => {
    const services = open()
    const removed = vi.spyOn(services.teams, 'deleteMembership')
    expect(await failure(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    expect(removed).not.toHaveBeenCalled()
    expect(services.db.rows('members').map((row) => row.$id)).toEqual(['m1', 'm2'])
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('keeps refusing while P has a share here, whether or not P has an identity left', async () => {
    // A merge into a U deleted midway: deletion took P's identities, and P's share stays.
    const services = open({ identities: [] })
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject(
      MERGING,
    )
  })

  it('goes ahead once nothing here names P any more', async () => {
    const services = open({ shares: [] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('refuses removing them while an unposted transaction here names P, but not their leave', async () => {
    const scheduled = {
      $id: 't9',
      groupId: 'g1',
      kind: 'expense',
      status: 'scheduled',
      date: '2026-10-25',
      description: 'Cleaning',
      totalCents: 4000,
      inputJson: JSON.stringify({ split: { mode: 'equal', personIds: ['pP', 'p1'] } }),
      statementId: null,
    }
    const services = open({ shares: [], transactions: [scheduled] })
    expect(await failure(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('goes ahead where P keeps its own row (a kept group, or one step 2 hasn’t reached)', async () => {
    const services = open({ members: [member('mP', 'g1', 'pP', 'member', 'placeholder')] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('goes ahead in a group the merge doesn’t list', async () => {
    const services = open({ persons: [{ ...P, mergeGroupIds: ['g9'] }] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('refuses a leave whose balance read loses to a merge batch moving P’s share, on its retry', async () => {
    // P has no share yet when the leave checks it... until a batch that moves one onto U, as the
    // merge's shares batch does, commits between the leave's reads and its commit. The batch
    // writes the group row, which the leave staged.
    const services = open({ shares: [share('s2', 'g1', 'p1', 0, 0)] })
    const { $id: _, ...moved } = share('s1', 'g1', 'p2', 0, 500)
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'groups', rowId: 'g1', data: { rev: 'rBatch' } },
          {
            action: 'create',
            tableId: 'shares',
            rowId: 's1',
            data: moved,
          },
        ),
      ),
    )
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      status: 409,
    })
    expect(services.db.rows('members').find((row) => row.$id === 'm2')?.status).toBe('active')
  })

  it('guards the group row before it reads the balance, so a batch just before counts', async () => {
    // The batch commits just before the leave stages the group row (its second write): the
    // balance read after it sees U's new share.
    const services = open({ shares: [share('s2', 'g1', 'p1', 0, 0)] })
    const { $id: _, ...moved } = share('s1', 'g1', 'p2', 0, 500)
    beforeStaging(services.db, 2, () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'groups', rowId: 'g1', data: { rev: 'rBatch' } },
          { action: 'create', tableId: 'shares', rowId: 's1', data: moved },
        ),
      ),
    )
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(services.db.rows('members').find((row) => row.$id === 'm2')?.status).toBe('active')
  })

  it('refuses a leave whose commit loses to merge step 2, on its retry', async () => {
    // Before step 2: pP still has its row in g1, so the first check lets the leave through.
    const services = open({ members: [member('mP', 'g1', 'pP', 'member', 'placeholder')] })
    // Step 2 commits between the leave's staging and its commit: pP's row merges into U's,
    // which it stages, so the leave's commit fails.
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'members', rowId: 'm2', data: { rev: 'rMerge' } },
          { action: 'delete', tableId: 'members', rowId: 'mP' },
        ),
      ),
    )
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      status: 409,
    })
    // The retry sees the merge open and is refused with the merging reason.
    const { body } = await call(services, 'POST', '/groups/g1/leave', undefined, 'u2')
    expect(body).toMatchObject({ ok: false, error: { details: { reason: 'merging' } } })
  })
})
