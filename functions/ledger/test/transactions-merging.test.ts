import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, member, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>
type Write = Parameters<Parameters<typeof withTransaction>[1]>[0] extends {
  write: (...writes: infer W) => unknown
}
  ? W[number]
  : never

// Pat has an identity, so once Pat's merge is marked it stays unfinished until identities move
// (identity-and-invites.md#while-a-merge-is-open-in-a-group).
const patsKey = {
  $id: 'id-pat',
  key: 'pat@example.com',
  type: 'email',
  personId: 'pat',
  verified: true,
  verifiedAt: '2026-10-18T00:00:00.000Z',
}

// September's electricity, $90.00 paid by Alice, split by the days each person was in the
// house: its input names no one, so only its shares name Pat (AI A's probe C on #242).
const byDays = {
  id: 'b1',
  groupId: 'house',
  kind: 'bill',
  date: '2026-10-10',
  description: 'Electricity',
  totalCents: 9000,
  split: { mode: 'days' },
  bill: { status: 'paid', periodStart: '2026-09-01', periodEnd: '2026-09-30' },
}

const withPat = { mode: 'equal', personIds: ['alice', 'pat'] }

/** Pat's merge into Bob (or `into`), marked: Pat lists `groupIds` and keeps the identity. */
const marked = (groupIds = ['house'], into = 'bob'): Write => ({
  action: 'update',
  tableId: 'persons',
  rowId: 'pat',
  data: { mergedInto: into, mergeGroupIds: groupIds },
})

/**
 * Merge step 2 in the house: Bob was already a member, so Pat's member row goes. It stages the
 * group row too, as the merge's member writes do. Pat's shares and inputs still name Pat.
 */
const stepTwo: Write[] = [
  { action: 'delete', tableId: 'members', rowId: 'm-pat' },
  { action: 'update', tableId: 'groups', rowId: 'house', data: { rev: 'step-2' } },
]

async function commit(db: Db, ...writes: Write[]): Promise<void> {
  await withTransaction(db, (tx) => tx.write(...writes))
}

/** A house where `body` was written while Pat was still a member, then `writes` committed. */
async function written(body: object, ...writes: Write[]): Promise<Db> {
  const db = seed({ identities: [patsKey] })
  expect((await call(db, 'POST', '/transactions', body)).status).toBe(200)
  await commit(db, ...writes)
  return db
}

// What a refused write must leave as it was.
const ledgerOf = (db: Db) => ({
  transactions: rows.transactions(db),
  shares: rows.shares(db),
  items: rows.items(db),
  activity: rows.activity(db),
  balances: db.rows('balances'),
})

function expectMerging(response: Awaited<ReturnType<typeof call>>) {
  expect(response.status).toBe(409)
  expect(response.body.error).toEqual({
    code: 'CONFLICT',
    message: "Some of this group's records are still being updated. Try again shortly.",
    details: { reason: 'merging' },
  })
}

/** Runs `meanwhile` to completion just before the request's `nth` staging (1 is the first). */
function beforeStaging(db: Db, nth: number, meanwhile: () => Promise<unknown>) {
  const stage = db.createOperations.bind(db)
  let count = 0
  vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    count += 1
    if (count === nth) await meanwhile()
    return stage(params)
  })
}

/** Runs `meanwhile` to completion just before the request's first commit. */
function beforeCommit(db: Db, meanwhile: () => Promise<unknown>) {
  const update = db.updateTransaction.bind(db)
  vi.spyOn(db, 'updateTransaction').mockImplementationOnce(async (params) => {
    if (params.commit) await meanwhile()
    return update(params)
  })
}

describe('while a merge is open in the row’s group', () => {
  it('PATCH refuses a row only its shares name the person by (probe C), and changes nothing', async () => {
    const db = await written(byDays, marked(), ...stepTwo)
    expect(rows.shares(db).map((share) => share.personId)).toContain('pat')
    const before = ledgerOf(db)
    expectMerging(await call(db, 'PATCH', '/transactions/b1', { ...byDays, description: 'Power' }))
    // Planned again with today's members, Pat's part would have gone to Alice and Bob.
    expect(ledgerOf(db)).toEqual(before)
  })

  it('PATCH refuses a row whose stored split names the person, not as a non-member', async () => {
    const db = await written({ ...byDays, split: withPat }, marked(), ...stepTwo)
    const before = ledgerOf(db)
    const response = await call(db, 'PATCH', '/transactions/b1', {
      ...byDays,
      split: withPat,
      description: 'Power',
    })
    expectMerging(response)
    expect(ledgerOf(db)).toEqual(before)
  })

  // A due bill has no shares, so only its stored input or items can name Pat. The edit leaves
  // Pat out, so a check that missed them would plan Pat's part away.
  const withoutPat = { mode: 'equal', personIds: ['alice', 'bob'] }

  it('PATCH refuses a due bill only its stored split names the person by', async () => {
    const due = { ...byDays, split: withPat, bill: { status: 'due', dueOn: '2026-10-25' } }
    const db = await written(due, marked(), ...stepTwo)
    expect(rows.shares(db)).toEqual([])
    const before = ledgerOf(db)
    expectMerging(await call(db, 'PATCH', '/transactions/b1', { ...due, split: withoutPat }))
    expect(ledgerOf(db)).toEqual(before)
  })

  it('PATCH refuses a due bill only an item’s split names the person by', async () => {
    const item = { name: 'Usage', amountCents: 9000 }
    const due = {
      ...byDays,
      totalCents: undefined,
      split: undefined,
      bill: { status: 'due', dueOn: '2026-10-25' },
      items: [{ ...item, split: withPat }],
    }
    const db = await written(due, marked(), ...stepTwo)
    const before = ledgerOf(db)
    const response = await call(db, 'PATCH', '/transactions/b1', {
      ...due,
      items: [{ ...item, split: withoutPat }],
    })
    expectMerging(response)
    expect(ledgerOf(db)).toEqual(before)
  })

  it('holds the row when U’s row there is `left`: a former housemate is still joined', async () => {
    const bobLeft: Write = {
      action: 'update',
      tableId: 'members',
      rowId: 'm-bob',
      data: { status: 'left', leftOn: '2026-10-05' },
    }
    const db = await written(byDays, marked(), ...stepTwo, bobLeft)
    const before = ledgerOf(db)
    expectMerging(await call(db, 'PATCH', '/transactions/b1', { ...byDays, description: 'Power' }))
    expect(ledgerOf(db)).toEqual(before)
  })

  // Bob left the house on their own after step 2: their own member.left is their newest there.
  const bobQuit: Write[] = [
    {
      action: 'update',
      tableId: 'members',
      rowId: 'm-bob',
      data: { status: 'left', role: 'viewer', leftOn: '2026-10-05' },
    },
    {
      action: 'create',
      tableId: 'activity',
      rowId: 'a-bob-left',
      data: {
        groupId: 'house',
        actorPersonId: 'bob',
        action: 'member.left',
        subjectPersonId: 'bob',
        summary: 'left',
        at: '2026-10-05T00:00:00.000Z',
      },
    },
  ]

  it('lets an edit through where U left on their own: step 3 leaves the row on P (#349)', async () => {
    const due = { ...byDays, split: withPat, bill: { status: 'due', dueOn: '2026-10-25' } }
    const db = await written(due, marked(), ...stepTwo, ...bobQuit)
    // Still naming Pat, an edit or a post answers as for any non-member, not `merging`.
    const patch = await call(db, 'PATCH', '/transactions/b1', { ...due, description: 'Power' })
    const post = await call(db, 'POST', '/transactions/b1/post', {})
    for (const response of [patch, post]) {
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('VALIDATION_FAILED')
    }
    // An edit must name someone else instead of Pat.
    const alone = { ...due, split: { mode: 'equal', personIds: ['alice'] } }
    expect((await call(db, 'PATCH', '/transactions/b1', alone)).status).toBe(200)
  })

  it('holds the row where U’s account was deleted, though U’s member.left is newest (#362)', async () => {
    // Bob deleted their account after step 2, which stops the merge where it was. The deletion
    // kept the house, with Bob's row `left` and a member.left by Bob (bobQuit's, written after
    // deletedAt: the keep's), and Pat's shares are Pat's.
    const bobDeleted: Write = {
      action: 'update',
      tableId: 'persons',
      rowId: 'bob',
      data: { deletedAt: '2026-10-05T00:00:00.000Z' },
    }
    const db = await written(byDays, marked(), ...stepTwo, ...bobQuit, bobDeleted)
    const before = ledgerOf(db)
    expectMerging(await call(db, 'PATCH', '/transactions/b1', { ...byDays, description: 'Power' }))
    expect(ledgerOf(db)).toEqual(before)
  })

  it('lets an edit through where U left on their own before deleting their account (#370)', async () => {
    // Bob left on their own after step 2, so step 3 left the row on Pat. Then Bob deleted their
    // account, and the keep wrote a second member.left. Only the first counts.
    const due = { ...byDays, split: withPat, bill: { status: 'due', dueOn: '2026-10-25' } }
    const db = await written(due, marked(), ...stepTwo, ...bobQuit)
    const deletedAt = '2026-10-18T02:00:00.000Z'
    vi.setSystemTime(new Date(deletedAt))
    await commit(
      db,
      { action: 'update', tableId: 'persons', rowId: 'bob', data: { deletedAt } },
      {
        action: 'create',
        tableId: 'activity',
        rowId: 'a-bob-kept',
        data: {
          groupId: 'house',
          actorPersonId: 'bob',
          action: 'member.left',
          subjectPersonId: 'bob',
          summary: 'left',
          at: deletedAt,
        },
      },
    )
    const alone = { ...due, split: { mode: 'equal', personIds: ['alice'] } }
    expect((await call(db, 'PATCH', '/transactions/b1', alone)).status).toBe(200)
  })

  it('/post refuses a due bill whose stored split names the person', async () => {
    const due = { ...byDays, split: withPat, bill: { status: 'due', dueOn: '2026-10-25' } }
    const db = await written(due, marked(), ...stepTwo)
    const before = ledgerOf(db)
    expectMerging(await call(db, 'POST', '/transactions/b1/post', {}))
    expect(ledgerOf(db)).toEqual(before)
    expect(rows.transactions(db)[0]?.status).toBe('due')
  })

  it('/post refuses a due bill only an item’s split names the person by', async () => {
    const due = {
      ...byDays,
      totalCents: undefined,
      split: undefined,
      bill: { status: 'due', dueOn: '2026-10-25' },
      items: [{ name: 'Usage', amountCents: 9000, split: withPat }],
    }
    const db = await written(due, marked(), ...stepTwo)
    // A due bill has no shares, and its stored input holds no items.
    expect(rows.shares(db)).toEqual([])
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '')).not.toHaveProperty('items')
    expectMerging(await call(db, 'POST', '/transactions/b1/post', {}))
    expect(rows.transactions(db)[0]?.status).toBe('due')
  })

  it('holds the row whether or not the merge has finished elsewhere: no identity is needed', async () => {
    // A merge into a U deleted midway: deletion took Pat's identities, and Pat's shares stay.
    const db = await written(byDays, marked(), ...stepTwo, {
      action: 'delete',
      tableId: 'identities',
      rowId: 'id-pat',
    })
    expectMerging(await call(db, 'PATCH', '/transactions/b1', { ...byDays, description: 'Power' }))
  })

  it('/void goes ahead: it plans nothing again', async () => {
    const db = await written(byDays, marked(), ...stepTwo)
    const response = await call(db, 'POST', '/transactions/b1/void', { reason: 'Duplicate' })
    expect(response.status).toBe(200)
    expect(rows.transactions(db)[0]?.status).toBe('void')
    expect(rows.shares(db)).toEqual([])
  })

  it('a step 2 that commits between the first check and the guard writes is refused', async () => {
    const db = await written(byDays, marked())
    const before = ledgerOf(db)
    // Staging 1 guards the transaction row and staging 2 the group row; the first check runs
    // between them, while Pat still has a member row. The edit leaves Pat out, so no guard
    // write on Pat's member row fails: only the check after the guard writes sees the merge.
    beforeStaging(db, 2, () => commit(db, ...stepTwo))
    const response = await call(db, 'PATCH', '/transactions/b1', {
      ...byDays,
      split: { mode: 'days', personIds: ['alice', 'bob'] },
    })
    expectMerging(response)
    expect(ledgerOf(db)).toEqual(before)
  })

  it('/post with payers in the body, and a step 2 between the check and the guard, is refused', async () => {
    // An occurrence a schedule made, whose template has Pat paying. The body's payers leave Pat
    // out of the plan, so only the check after the guard writes sees the merge.
    const db = seed({
      identities: [patsKey],
      transactions: [
        {
          $id: 'sch2_20261016',
          groupId: 'house',
          kind: 'expense',
          status: 'scheduled',
          date: '2026-10-16',
          description: 'Internet',
          totalCents: 9000,
          inputJson: JSON.stringify({
            payers: [{ personId: 'pat', cents: 9000 }],
            split: { mode: 'equal', personIds: ['alice', 'bob'] },
          }),
          scheduleId: 'sch2',
          overridden: false,
          statementId: null,
          createdBy: 'alice',
          updatedBy: 'alice',
        },
      ],
    })
    await commit(db, marked())
    beforeStaging(db, 2, () => commit(db, ...stepTwo))
    const response = await call(db, 'POST', '/transactions/sch2_20261016/post', {
      payers: [{ personId: 'alice', cents: 9000 }],
    })
    expectMerging(response)
    expect(rows.transactions(db)[0]?.status).toBe('scheduled')
    expect(rows.shares(db)).toEqual([])
  })

  it('a step 2 that commits after the checks fails the commit, and the rerun is refused', async () => {
    const db = await written(byDays, marked())
    const before = ledgerOf(db)
    beforeCommit(db, () => commit(db, ...stepTwo))
    expectMerging(await call(db, 'PATCH', '/transactions/b1', { ...byDays, description: 'Power' }))
    expect(rows.shares(db)).toEqual(before.shares)
    expect(rows.transactions(db)).toEqual(before.transactions)
  })
})

describe('a merge that isn’t open in the row’s group', () => {
  const edit = { ...byDays, description: 'Power' }

  it('one where U has no row in the group (Pat’s was removed before step 2) doesn’t hold it', async () => {
    // Pat's merge into Dan, who isn't in the house: nothing gave Pat's place to anyone.
    const db = await written(byDays, marked(['house'], 'dan'), ...stepTwo)
    expect((await call(db, 'PATCH', '/transactions/b1', edit)).status).toBe(200)
  })

  it('one where U has only a placeholder row (U never joined) doesn’t hold it (D-016)', async () => {
    // Dan was added to the house but hasn't joined; Pat's row was removed before step 2.
    const { $id, ...placeholder } = member('m-dan', 'house', 'dan', 'member', 'placeholder')
    const dansRow: Write = { action: 'create', tableId: 'members', rowId: $id, data: placeholder }
    const db = await written(byDays, dansRow, marked(['house'], 'dan'), ...stepTwo)
    expect((await call(db, 'PATCH', '/transactions/b1', edit)).status).toBe(200)
  })

  it('a group the merge kept (Pat still has a member row) goes ahead', async () => {
    const db = await written(byDays, marked())
    expect((await call(db, 'PATCH', '/transactions/b1', edit)).status).toBe(200)
    expect(rows.shares(db).map((share) => share.personId)).toContain('pat')
  })

  it('one open in another group only doesn’t hold this one', async () => {
    const db = await written(byDays, marked(['job']), ...stepTwo)
    expect((await call(db, 'PATCH', '/transactions/b1', edit)).status).toBe(200)
  })

  it('a row naming nobody merged reads only `persons`', async () => {
    const db = await written(expenseFor(['alice', 'bob']))
    const read = vi.spyOn(db, 'listRows')
    expect(
      (await call(db, 'PATCH', '/transactions/t1', expenseFor(['alice', 'bob'], 'Big shop')))
        .status,
    ).toBe(200)
    const tables = read.mock.calls.map(([params]) => params.tableId)
    // Once before planning and once after the guard writes.
    expect(
      read.mock.calls.filter(
        ([params]) =>
          params.tableId === 'persons' &&
          params.queries?.some((query) => query.includes('isNotNull')),
      ),
    ).toHaveLength(2)
    expect(tables).not.toContain('identities')
  })
})

function expenseFor(personIds: string[], description = 'Groceries') {
  return {
    id: 't1',
    groupId: 'house',
    kind: 'expense',
    date: '2026-10-10',
    description,
    totalCents: 9000,
    split: { mode: 'equal', personIds },
  }
}
