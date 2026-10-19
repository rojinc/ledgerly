import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it } from 'vitest'
import { beforeCommit, call, failure, fakes, group, member, ok, person, share } from './harness'

// identity-and-invites.md#while-a-merge-is-open-in-a-group. Person 2 (u2) is U, and pP, a
// placeholder merged into them, still has an identity: step 2 has moved pP's row in g1 to U
// (m2 is that row now), but pP's share there hasn't moved yet.
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

function open(more: { persons?: object[]; identities?: object[]; members?: object[] } = {}) {
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
      shares: [share('s1', 'g1', 'pP', 0, 500), share('s2', 'g1', 'p1', 500, 0)],
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
    expect(await failure(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    expect(services.db.rows('members').map((row) => row.$id)).toEqual(['m1', 'm2'])
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('goes ahead once the merge has finished, so P has no identity left', async () => {
    const services = open({ identities: [] })
    // The leave now fails only on the balance, as any leave would: P's share counts as P's.
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
