import type { FakeDb } from '@ledgerly/server/appwrite/fake'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  group,
  member,
  ok,
  person,
  share,
  TRY_AGAIN,
  updateRow,
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
// U's row, and pP's own row in g1 before step 2 reaches it.
const U_ROW = member('m2', 'g1', 'p2', 'member', 'active')
const P_ROW = member('mP', 'g1', 'pP', 'member', 'placeholder')
// U moved out (leftOn set) before the merge, and hasn't left on their own: no member.left.
const MOVED_OUT = member('m2', 'g1', 'p2', 'viewer', 'left', { leftOn: '2026-10-10' })
// Before step 1: pP isn't marked yet, and still has its own row in g1.
const UNMARKED = {
  persons: [{ ...P, mergedInto: null, mergeGroupIds: null }],
  members: [U_ROW, P_ROW],
}

function open(
  more: {
    persons?: object[]
    identities?: object[]
    members?: object[]
    shares?: object[]
    transactions?: object[]
    activity?: object[]
  } = {},
) {
  return fakes(
    {
      persons: [person(1), person(2), ...(more.persons ?? [P])],
      identities: more.identities ?? [PHONE],
      groups: [group('g1', 'house')],
      members: [member('m1', 'g1', 'p1', 'admin', 'active'), ...(more.members ?? [U_ROW])],
      // pP's share is still pP's: U's balance alone is 0.
      shares: more.shares ?? PS_SHARES,
      transactions: more.transactions ?? [],
      activity: more.activity ?? [],
    } as never,
    { g1: ['u1', 'u2'] },
  )
}

// The merge's own writes, as identity's merge.ts and merge-inputs.ts stage them in g1.

/** Step 1 (markMerged): pP is marked as merged into U, with its groups. */
function markP(db: FakeDb) {
  return updateRow(db, 'persons', 'pP', { mergedInto: 'p2', mergeGroupIds: ['g1'] })
}

/**
 * Step 2 (moveMember), where U has a row: the group's guard, U's row keeps pP's place, with the
 * status it had (`left` if U moved out), and pP's goes.
 */
function moveP(db: FakeDb, status: 'active' | 'left' = 'active') {
  return withTransaction(db, (tx) =>
    tx.write(
      { action: 'update', tableId: 'groups', rowId: 'g1', data: { rev: 'rMove' } },
      {
        action: 'update',
        tableId: 'members',
        rowId: 'm2',
        data: { joinedOn: '2026-09-01', status, rev: 'rMove' },
      },
      { action: 'delete', tableId: 'members', rowId: 'mP' },
      { action: 'update', tableId: 'persons', rowId: 'p2', data: { rev: 'rMove' } },
    ),
  )
}

/** A step 3 share batch (moveShareBatch): the group's and U's row's guards, then s1 moves to U. */
function moveShare(db: FakeDb) {
  return withTransaction(db, (tx) =>
    tx.write(
      { action: 'update', tableId: 'groups', rowId: 'g1', data: { rev: 'rShares' } },
      { action: 'update', tableId: 'members', rowId: 'm2', data: { rev: 'rShares' } },
      { action: 'update', tableId: 'shares', rowId: 's1', data: { personId: 'p2' } },
    ),
  )
}

/** A step 3 inputs batch (runBatch): the group's and U's person row's guards, then t9 names U. */
function moveInput(db: FakeDb) {
  return withTransaction(db, (tx) =>
    tx.write(
      { action: 'update', tableId: 'groups', rowId: 'g1', data: { rev: 'rInputs' } },
      { action: 'update', tableId: 'persons', rowId: 'p2', data: { rev: 'rInputs' } },
      { action: 'update', tableId: 'transactions', rowId: 't9', data: { inputJson: names('p2') } },
    ),
  )
}

function names(personId: string) {
  return JSON.stringify({ split: { mode: 'equal', personIds: [personId, 'p1'] } })
}

/** An unposted transaction in g1 whose input names `personId`. */
function scheduled(personId: string) {
  return {
    $id: 't9',
    groupId: 'g1',
    kind: 'expense',
    status: 'scheduled',
    date: '2026-10-25',
    description: 'Cleaning',
    totalCents: 4000,
    inputJson: names(personId),
    statementId: null,
  }
}

/** The error a request failed with, details included, or nothing if it succeeded. */
async function refusal(services: Fakes, method: string, path: string, userId = 'u1') {
  const { status, body } = await call(services, method, path, undefined, userId)
  return body.ok ? { status } : { status, ...body.error }
}

const MERGING = { status: 409, code: 'CONFLICT', details: { reason: 'merging' } }

function memberIds(services: Fakes) {
  return services.db.rows('members').map((row) => row.$id)
}

function statusOfU(services: Fakes) {
  return services.db.rows('members').find((row) => row.$id === 'm2')?.status
}

describe('while a merge into the member is open in the group', () => {
  it('refuses their leave, with the merging reason, and changes nothing', async () => {
    const services = open()
    expect(await refusal(services, 'POST', '/groups/g1/leave', 'u2')).toMatchObject(MERGING)
    expect(statusOfU(services)).toBe('active')
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('refuses removing them, before their team membership is touched', async () => {
    const services = open()
    const removed = vi.spyOn(services.teams, 'deleteMembership')
    expect(await refusal(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    expect(removed).not.toHaveBeenCalled()
    expect(memberIds(services)).toEqual(['m1', 'm2'])
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('refuses removing them with merging even when they have shares: that check comes first', async () => {
    const services = open({ shares: [...PS_SHARES, share('s3', 'g1', 'p2', 100, 0)] })
    expect(await refusal(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
  })

  it('keeps refusing while P has a share here, whether or not P has an identity left', async () => {
    // A merge into a U deleted midway: deletion took P's identities, and P's share stays.
    const services = open({ identities: [] })
    expect(await refusal(services, 'POST', '/groups/g1/leave', 'u2')).toMatchObject(MERGING)
  })

  it('goes ahead once nothing here names P any more', async () => {
    const services = open({ shares: [] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('refuses removing them while an unposted transaction here names P, but not their leave', async () => {
    const services = open({ shares: [], transactions: [scheduled('pP')] })
    expect(await refusal(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('goes ahead removing a U who never joined: a placeholder row isn’t P’s place (D-016)', async () => {
    const services = open({ members: [member('m2', 'g1', 'p2', 'member', 'placeholder')] })
    expect(await ok(services, 'DELETE', '/groups/g1/members/m2')).toEqual({})
    expect(memberIds(services)).toEqual(['m1'])
  })

  it('refuses the leave of a U who moved out, whose row is left (it’s still P’s place)', async () => {
    const services = open({ members: [MOVED_OUT] })
    expect(await refusal(services, 'POST', '/groups/g1/leave', 'u2')).toMatchObject(MERGING)
    // Their leave isn't recorded, so it isn't final, and they keep their access.
    expect(services.db.rows('activity')).toEqual([])
    expect(statusOfU(services)).toBe('left')
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('refuses removing a U who moved out', async () => {
    const services = open({ members: [MOVED_OUT] })
    expect(await refusal(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    expect(memberIds(services)).toEqual(['m1', 'm2'])
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
  })

  it('goes ahead removing a U who left on their own: step 3 leaves P’s rows on P (#349)', async () => {
    const services = open({
      members: [MOVED_OUT],
      // U's leave was refused while P had a share here, so P has none; P is named only unposted.
      shares: [],
      transactions: [scheduled('pP')],
      activity: [
        {
          $id: 'aLeft',
          groupId: 'g1',
          actorPersonId: 'p2',
          action: 'member.left',
          subjectPersonId: 'p2',
          summary: 'left',
          at: '2026-10-10T00:00:00.000Z',
        },
      ],
    })
    expect(await ok(services, 'DELETE', '/groups/g1/members/m2')).toEqual({})
    expect(memberIds(services)).toEqual(['m1'])
  })

  it('goes ahead where P keeps its own row (a kept group, or one step 2 hasn’t reached)', async () => {
    const services = open({ members: [U_ROW, P_ROW] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it('finds a merge into them past the first 100 persons merged into them', async () => {
    // Merges into U in other groups, stored before pP's.
    const elsewhere = Array.from({ length: 100 }, (_, n) => ({
      ...P,
      $id: `pA${n}`,
      mergeGroupIds: ['g9'],
    }))
    const services = open({ persons: [...elsewhere, P] })
    expect(await refusal(services, 'POST', '/groups/g1/leave', 'u2')).toMatchObject(MERGING)
  })

  it('goes ahead in a group the merge doesn’t list', async () => {
    const services = open({ persons: [{ ...P, mergeGroupIds: ['g9'] }] })
    expect(await ok(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({})
  })

  it.each([
    { row: U_ROW, status: 'active' as const },
    { row: MOVED_OUT, status: 'left' as const },
  ])(
    'refuses a leave that steps 1 and 2 overtake before it stages its row ($status)',
    async ({ row, status }) => {
      // The merge isn't marked when the leave starts. Steps 1 and 2 commit just before it stages
      // U's row, so the checks after that staging see the merge open.
      const services = open({ ...UNMARKED, members: [row, P_ROW] })
      beforeStaging(services.db, 1, async () => {
        await markP(services.db)
        await moveP(services.db, status)
      })
      expect(await refusal(services, 'POST', '/groups/g1/leave', 'u2')).toMatchObject(MERGING)
      expect(statusOfU(services)).toBe(status)
      expect(services.db.rows('activity')).toEqual([])
    },
  )

  it('refuses a removal that steps 1 and 2 overtake after its early check, keeping U’s row', async () => {
    // The early check passes: the merge isn't marked yet. Steps 1 and 2 commit just before the
    // delete is staged, so only the check in the transaction can see the merge open.
    const services = open(UNMARKED)
    beforeStaging(services.db, 1, async () => {
      await markP(services.db)
      await moveP(services.db)
    })
    expect(await refusal(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
    // P's share keeps a member row to move to: U's, which holds P's place now (I-3).
    expect(memberIds(services)).toEqual(['m1', 'm2'])
    expect(services.db.rows('shares').find((row) => row.$id === 's1')?.personId).toBe('pP')
    expect(services.teams.members('g1')?.map((m) => m.userId)).toEqual(['u1', 'u2'])
    // And the retry is refused the same way, by the early check.
    expect(await refusal(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject(MERGING)
  })

  it('refuses a removal whose reads an inputs batch overtakes, reading P’s names before U’s', async () => {
    // Step 2 hasn't reached g1, so the early check passes and t9 can name pP. It commits just
    // before the delete is staged, and an inputs batch that rewrites t9 to name U just before
    // the group's guard: the reads after that see t9 naming U.
    const services = open({
      members: [U_ROW, P_ROW],
      shares: [],
      transactions: [scheduled('pP')],
    })
    const first = beforeStaging(services.db, 1, async () => {
      await moveP(services.db)
      first.mockRestore()
      beforeStaging(services.db, 1, () => moveInput(services.db))
    })
    expect(await failure(services, 'DELETE', '/groups/g1/members/m2')).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    })
    expect(memberIds(services)).toEqual(['m1', 'm2'])
  })

  it('refuses a leave whose commit loses to steps 2 and 3, counting P’s moved share on its retry', async () => {
    // Before step 2: pP still has its row in g1, so the leave goes ahead with U's balance at 0.
    // Step 2 and a share batch commit before the leave does, and both write U's row.
    const services = open({ members: [U_ROW, P_ROW] })
    beforeCommit(services.db, async () => {
      await moveP(services.db)
      await moveShare(services.db)
    })
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    expect(statusOfU(services)).toBe('active')
    // P's share is U's now, so U's balance isn't 0.
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('guards the group row before it reads the balance, so a batch just before counts', async () => {
    // A share batch commits just before the leave stages the group row (its second write): the
    // reads after it see P's share on U.
    const services = open()
    beforeStaging(services.db, 2, () => moveShare(services.db))
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(statusOfU(services)).toBe('active')
  })

  it('refuses a leave whose commit loses to merge step 2, on its retry', async () => {
    // Before step 2: pP still has its row in g1, so the first check lets the leave through.
    const services = open({ members: [U_ROW, P_ROW] })
    // Step 2 commits between the leave's staging and its commit: it writes U's row, which the
    // leave staged, so the leave's commit fails.
    beforeCommit(services.db, () => moveP(services.db))
    expect(await failure(services, 'POST', '/groups/g1/leave', undefined, 'u2')).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // The retry sees the merge open and is refused with the merging reason.
    expect(await refusal(services, 'POST', '/groups/g1/leave', 'u2')).toMatchObject(MERGING)
  })
})
