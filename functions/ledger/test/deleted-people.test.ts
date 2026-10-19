import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, expense, MEMBERS, member, NOW, rows, seed } from './harness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

type Db = ReturnType<typeof seed>

// Part 3 of #50 sets it when they delete their account: a minute on, after the rows a test made.
function deleteAccount(db: Db, personId: string) {
  vi.setSystemTime(Date.now() + 60_000)
  return withTransaction(db, (tx) =>
    tx.write({
      action: 'update',
      tableId: 'persons',
      rowId: personId,
      data: { deletedAt: new Date().toISOString() },
    }),
  )
}

const refused = { status: 400, code: 'VALIDATION_FAILED' }

// A due bill with no split: everyone in the house on its date, Bob included.
const powerBill = {
  id: 'b1',
  groupId: 'house',
  kind: 'bill',
  date: '2026-10-12',
  description: 'Power',
  totalCents: 9000,
  bill: { status: 'due', dueOn: '2026-10-15' },
}
const renamed = { ...powerBill, description: 'Electricity' }

function outcome(response: Awaited<ReturnType<typeof call>>) {
  return response.status === 200
    ? { status: 200 }
    : { status: response.status, code: (response.body as { error: { code: string } }).error.code }
}

// functions-api.md#ledger ("Deleted people").
describe('a person who deleted their account, in a group they had joined', () => {
  it('can’t be named in a new expense', async () => {
    const db = seed()
    await deleteAccount(db, 'bob')
    expect(outcome(await call(db, 'POST', '/transactions', expense()))).toEqual(refused)
    expect(rows.transactions(db)).toEqual([])
  })

  it('can’t be named where they have left, as deleting the account leaves every group', async () => {
    const db = seed()
    const withLee = expense({ split: { mode: 'equal', personIds: ['alice', 'lee'] } })
    expect(outcome(await call(db, 'POST', '/transactions', withLee))).toEqual({ status: 200 })
    await deleteAccount(db, 'lee')
    expect(outcome(await call(db, 'POST', '/transactions', { ...withLee, id: 't2' }))).toEqual(
      refused,
    )
  })

  it('can’t be named in an item’s split either', async () => {
    const db = seed()
    await deleteAccount(db, 'bob')
    const items = expense({
      totalCents: undefined,
      split: undefined,
      items: [
        { name: 'Milk', amountCents: 300, split: { mode: 'equal', personIds: ['alice'] } },
        { name: 'Wine', amountCents: 2000, split: { mode: 'equal', personIds: ['bob'] } },
      ],
    })
    expect(outcome(await call(db, 'POST', '/transactions', items))).toEqual(refused)
  })

  it('can be named where they never joined (a placeholder), so nothing shows the deletion', async () => {
    const db = seed()
    await deleteAccount(db, 'pat')
    const withPat = expense({ split: { mode: 'equal', personIds: ['alice', 'pat'] } })
    expect(outcome(await call(db, 'POST', '/transactions', withPat))).toEqual({ status: 200 })
  })

  it('can still be paid or adjusted, so balances with them can be settled', async () => {
    const db = seed()
    await deleteAccount(db, 'bob')
    const payment = {
      id: 'p1',
      groupId: 'house',
      kind: 'payment',
      date: '2026-10-10',
      description: 'Settling up',
      totalCents: 4500,
      payment: { fromPersonId: 'alice', toPersonId: 'bob' },
    }
    expect(outcome(await call(db, 'POST', '/transactions', payment))).toEqual({ status: 200 })
    const adjustment = {
      id: 'a1',
      groupId: 'house',
      kind: 'adjustment',
      date: '2026-10-10',
      description: 'Fix',
      totalCents: 100,
      adjustment: {
        reason: 'Fix',
        shares: [
          { personId: 'alice', givenCents: 100, receivedCents: 0 },
          { personId: 'bob', givenCents: 0, receivedCents: 100 },
        ],
      },
    }
    expect(outcome(await call(db, 'POST', '/transactions', adjustment))).toEqual({ status: 200 })
  })

  it('stays on a transaction that already names them, which can still be changed', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense())
    await deleteAccount(db, 'bob')
    const changed = expense({ description: 'Food', totalCents: 9500 })
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', changed))).toEqual({ status: 200 })
    expect(rows.transactions(db)[0]?.description).toBe('Food')
  })

  it('can’t be added to an existing transaction', async () => {
    const db = seed()
    const aliceOnly = expense({ split: { mode: 'equal', personIds: ['alice'] } })
    await call(db, 'POST', '/transactions', aliceOnly)
    await deleteAccount(db, 'bob')
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', expense()))).toEqual(refused)
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '').split.personIds).toEqual(['alice'])
  })

  it('can’t become the payer an edit fills in, as the creator of a row with several payers', async () => {
    const db = seed()
    // Bob records what Alice and Cara paid between them. Without payers, an edit keeps the
    // creator paying (functions-api.md#ledger, "Payers when none are given").
    const twoPayers = expense({
      payers: [
        { personId: 'alice', cents: 4500 },
        { personId: 'cara', cents: 4500 },
      ],
      split: { mode: 'equal', personIds: ['alice', 'cara'] },
    })
    expect(outcome(await call(db, 'POST', '/transactions', twoPayers, 'u-bob'))).toEqual({
      status: 200,
    })
    await deleteAccount(db, 'bob')
    const { payers, ...noPayers } = twoPayers
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', noPayers))).toEqual(refused)
    expect(JSON.parse(rows.transactions(db)[0]?.inputJson ?? '').payers).toEqual(payers)
    expect(rows.shares(db).map((share) => share.personId)).not.toContain('bob')
  })

  it('stays on a due bill that names them, which can still be paid, but can’t become its payer', async () => {
    const db = seed()
    const bill = {
      id: 'b1',
      groupId: 'house',
      kind: 'bill',
      date: '2026-10-12',
      description: 'Power',
      totalCents: 9000,
      bill: { status: 'due', dueOn: '2026-10-15' },
      split: { mode: 'equal', personIds: ['alice', 'cara'] },
    }
    await call(db, 'POST', '/transactions', bill)
    await call(db, 'POST', '/transactions', {
      ...bill,
      id: 'b2',
      split: { mode: 'equal', personIds: ['alice', 'bob'] },
    })
    await deleteAccount(db, 'bob')
    // Unposted, it has no shares: its input names Bob already.
    const renamed = {
      ...bill,
      id: 'b2',
      description: 'Electricity',
      split: { mode: 'equal', personIds: ['alice', 'bob'] },
    }
    expect(outcome(await call(db, 'PATCH', '/transactions/b2', renamed))).toEqual({ status: 200 })
    const bobPays = { payers: [{ personId: 'bob', cents: 9000 }] }
    expect(outcome(await call(db, 'POST', '/transactions/b1/post', bobPays))).toEqual(refused)
    expect(outcome(await call(db, 'POST', '/transactions/b2/post', {}))).toEqual({ status: 200 })
  })

  it('can’t get a share from the default split of a new expense', async () => {
    const db = seed()
    await deleteAccount(db, 'bob')
    // No split: everyone in the house on its date, Bob included (ledger.md#default-split).
    const everyone = expense({ split: undefined })
    expect(outcome(await call(db, 'POST', '/transactions', everyone))).toEqual(refused)
    expect(rows.transactions(db)).toEqual([])
  })

  it('keeps a share the default split gave them, which an edit can name', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense({ split: undefined }))
    await deleteAccount(db, 'bob')
    const named = expense({ split: { mode: 'equal', personIds: ['alice', 'bob'] } })
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', named))).toEqual({ status: 200 })
  })

  it('keeps the share a due bill made before gives them by its default split', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', powerBill)
    await deleteAccount(db, 'bob')
    expect(outcome(await call(db, 'PATCH', '/transactions/b1', renamed))).toEqual({ status: 200 })
    expect(outcome(await call(db, 'POST', '/transactions/b1/post', {}))).toEqual({ status: 200 })
    expect(rows.shares(db).map((share) => share.personId)).toContain('bob')
  })

  it('can’t get a first share from an edit of a due bill made before', async () => {
    // Bob moved out on 10 October: a bill dated after it doesn't split to him.
    const db = seed({
      members: [
        ...MEMBERS.filter((row) => row.$id !== 'm-bob'),
        { ...member('m-bob', 'house', 'bob', 'viewer', 'left'), leftOn: '2026-10-10' },
      ],
    })
    await call(db, 'POST', '/transactions', powerBill)
    await deleteAccount(db, 'bob')
    const earlier = { ...powerBill, date: '2026-10-05' }
    expect(outcome(await call(db, 'PATCH', '/transactions/b1', earlier))).toEqual(refused)
    expect(rows.transactions(db)[0]?.date).toBe('2026-10-12')
  })

  it('can’t get a share from the default split of a row made after', async () => {
    // An occurrence of a schedule the deletion didn't end, made after it.
    const db = seed({
      transactions: [
        {
          $id: 'groceries_20261018',
          groupId: 'house',
          kind: 'expense',
          status: 'scheduled',
          date: '2026-10-18',
          description: 'Groceries',
          totalCents: 9000,
          inputJson: JSON.stringify({}),
          scheduleId: 'groceries',
          overridden: false,
          statementId: null,
          createdBy: 'alice',
          updatedBy: 'alice',
          $createdAt: new Date(NOW.getTime() + 120_000).toISOString(),
        },
      ],
    })
    await deleteAccount(db, 'bob')
    vi.setSystemTime(NOW.getTime() + 180_000)
    expect(outcome(await call(db, 'POST', '/transactions/groceries_20261018/post', {}))).toEqual(
      refused,
    )
  })

  it('stays on a row made after that names them already, which can still be changed and posted', async () => {
    // Made between the deletion's start and the end of the schedule that names them.
    const db = seed({
      transactions: [
        {
          $id: 'groceries_20261018',
          groupId: 'house',
          kind: 'expense',
          status: 'scheduled',
          date: '2026-10-18',
          description: 'Groceries',
          totalCents: 9000,
          inputJson: JSON.stringify({ split: { mode: 'equal', personIds: ['alice', 'bob'] } }),
          scheduleId: 'groceries',
          overridden: false,
          statementId: null,
          createdBy: 'alice',
          updatedBy: 'alice',
          $createdAt: new Date(NOW.getTime() + 120_000).toISOString(),
        },
      ],
    })
    await deleteAccount(db, 'bob')
    vi.setSystemTime(NOW.getTime() + 180_000)
    const food = {
      ...expense({ id: 'groceries_20261018', date: '2026-10-18', totalCents: 9000 }),
      description: 'Food',
    }
    expect(outcome(await call(db, 'PATCH', '/transactions/groceries_20261018', food))).toEqual({
      status: 200,
    })
    expect(outcome(await call(db, 'POST', '/transactions/groceries_20261018/post', {}))).toEqual({
      status: 200,
    })
  })

  it('can’t get a first share from the default split when a posted row is edited', async () => {
    const db = seed()
    await call(db, 'POST', '/transactions', expense({ split: undefined }))
    // Dan joins, back-dated, so the default split on the row's date would now include him.
    const { $id, ...dan } = member('m-dan', 'house', 'dan', 'member')
    await withTransaction(db, (tx) =>
      tx.write({ action: 'create', tableId: 'members', rowId: $id, data: dan }),
    )
    await deleteAccount(db, 'dan')
    const renamed = expense({ split: undefined, description: 'Food' })
    expect(outcome(await call(db, 'PATCH', '/transactions/t1', renamed))).toEqual(refused)
  })

  describe('as the employer, who a shift names without listing them', () => {
    // Acme has joined the employer group.
    const joined = (transactions: Record<string, unknown>[] = []) =>
      seed({
        members: [
          ...MEMBERS.filter((row) => row.$id !== 'm-acme'),
          member('m-acme', 'job', 'acme', 'member'),
        ],
        transactions,
      })
    const shift = {
      id: 's1',
      groupId: 'job',
      kind: 'shift',
      date: '2026-10-16',
      description: 'Thursday',
      shift: { minutes: 300, rateCents: 2500 },
    }

    it('can’t be named in a new shift, or by a new timer', async () => {
      const db = joined()
      await deleteAccount(db, 'acme')
      expect(outcome(await call(db, 'POST', '/transactions', shift, 'u-sam'))).toEqual(refused)
      const timer = { id: 'tm1', groupId: 'job' }
      expect(outcome(await call(db, 'POST', '/timer/start', timer, 'u-sam'))).toEqual(refused)
      expect(rows.transactions(db)).toEqual([])
    })

    it('can be named where they never joined (a placeholder), also by a new timer', async () => {
      const db = seed()
      await deleteAccount(db, 'acme')
      expect(outcome(await call(db, 'POST', '/transactions', shift, 'u-sam'))).toEqual({
        status: 200,
      })
      const timer = { id: 'tm1', groupId: 'job' }
      expect(outcome(await call(db, 'POST', '/timer/start', timer, 'u-sam'))).toEqual({
        status: 200,
      })
    })

    it('stays on a shift made before, which can still be confirmed, but not on one made after', async () => {
      const scheduledShift = (id: string, createdAt: string) => ({
        $id: id,
        groupId: 'job',
        kind: 'shift',
        status: 'scheduled',
        date: '2026-10-16',
        description: 'Thursday',
        totalCents: 12500,
        inputJson: JSON.stringify({ shift: { minutes: 300, rateCents: 2500 } }),
        scheduleId: 'sch1',
        overridden: false,
        statementId: null,
        createdBy: 'sam',
        updatedBy: 'sam',
        $createdAt: createdAt,
      })
      const db = joined([
        scheduledShift('before', NOW.toISOString()),
        scheduledShift('after', new Date(NOW.getTime() + 120_000).toISOString()),
      ])
      await deleteAccount(db, 'acme')
      vi.setSystemTime(NOW.getTime() + 180_000)
      const confirm = (id: string) => call(db, 'POST', `/transactions/${id}/post`, {}, 'u-sam')
      expect(outcome(await confirm('before'))).toEqual({ status: 200 })
      expect(outcome(await confirm('after'))).toEqual(refused)
    })

    it('stays on a shift made before as its worker, which the employer can still confirm', async () => {
      // Acme joined as an admin, so the group is kept when Sam deletes the account.
      const db = seed({
        members: [
          ...MEMBERS.filter((row) => row.$id !== 'm-acme'),
          member('m-acme', 'job', 'acme', 'admin'),
        ],
        persons: [
          { $id: 'sam', userId: 'u-sam', displayName: 'Sam' },
          { $id: 'acme', userId: 'u-acme', displayName: 'Acme' },
        ],
        transactions: [
          {
            $id: 'sch1_20261016',
            groupId: 'job',
            kind: 'shift',
            status: 'scheduled',
            date: '2026-10-16',
            description: 'Thursday',
            totalCents: 12500,
            inputJson: JSON.stringify({ shift: { minutes: 300, rateCents: 2500 } }),
            scheduleId: 'sch1',
            overridden: false,
            statementId: null,
            createdBy: 'sam',
            updatedBy: 'sam',
            $createdAt: NOW.toISOString(),
          },
        ],
      })
      await deleteAccount(db, 'sam')
      const confirm = await call(db, 'POST', '/transactions/sch1_20261016/post', {}, 'u-acme')
      expect(outcome(confirm)).toEqual({ status: 200 })
    })

    it('stays on a timer started before, which can still be stopped', async () => {
      const db = joined()
      const timer = { id: 'tm1', groupId: 'job', rateCents: 2500 }
      expect(outcome(await call(db, 'POST', '/timer/start', timer, 'u-sam'))).toEqual({
        status: 200,
      })
      await deleteAccount(db, 'acme')
      vi.setSystemTime(NOW.getTime() + 60 * 60 * 1000)
      const stop = { transactionId: 'tm1' }
      expect(outcome(await call(db, 'POST', '/timer/stop', stop, 'u-sam'))).toEqual({ status: 200 })
      expect(rows.shares(db).map((share) => share.personId)).toContain('acme')
    })
  })

  it('is checked with a read only, so a transaction’s writes stay within budget', async () => {
    const db = seed()
    // A write that races the deletion is the same as one made just before it (ledger.md).
    const stage = vi.spyOn(db, 'createOperations')
    expect(outcome(await call(db, 'POST', '/transactions', expense()))).toEqual({ status: 200 })
    expect(JSON.stringify(stage.mock.calls)).not.toContain('"persons"')
  })
})
