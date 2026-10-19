import { readdirSync, readFileSync } from 'node:fs'
import type { Groups } from '@ledgerly/core/generated/rows'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { nightlyCheck } from '../src/steps/nightly-check'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  fakes,
  group,
  member,
  NOW,
  person,
} from './harness'

// scheduling.md#step-6-nightly-check. NOW is 07:00 on Monday 19 October in Sydney.
const TOMORROW_3AM_SYDNEY = '2026-10-19T16:00:00.000Z'
const HOUR = 60 * 60 * 1000

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function transaction(id: string, totalCents: number, extra: object = {}) {
  return {
    $id: id,
    groupId: 'elm',
    kind: 'expense',
    status: 'posted',
    date: '2026-10-10',
    description: 'Groceries',
    category: null,
    totalCents,
    inputJson: '{}',
    dueOn: null,
    scheduleId: null,
    overridden: false,
    statementId: null,
    receiptFileIds: null,
    startedAt: null,
    remindedAt: null,
    voidReason: null,
    createdBy: 'pSam',
    updatedBy: 'pSam',
    ...extra,
  }
}

function share(
  id: string,
  transactionId: string,
  personId: string,
  given: number,
  received: number,
) {
  return {
    $id: id,
    transactionId,
    personId,
    givenCents: given,
    receivedCents: received,
    groupId: 'elm',
    date: '2026-10-10',
    kind: 'expense',
    category: null,
  }
}

// Sam paid $60 of groceries for Sam and Alex.
const GROCERIES = [
  transaction('t1', 6000),
  share('s1', 't1', 'pSam', 6000, 3000),
  share('s2', 't1', 'pAlex', 0, 3000),
]
const ROW = [
  { personId: 'pAlex', netCents: -3000, shares: 1 },
  { personId: 'pSam', netCents: 3000, shares: 1 },
]
// Then Alex paid $20 of milk for both of them.
const MILK = transaction('t2', 2000)
const MILK_SHARES = [share('s3', 't2', 'pSam', 0, 1000), share('s4', 't2', 'pAlex', 2000, 1000)]
const ROW_WITH_MILK = [
  { personId: 'pAlex', netCents: -2000, shares: 2 },
  { personId: 'pSam', netCents: 2000, shares: 2 },
]

const MEMBERS = [
  member('elm', 'pSam'),
  member('elm', 'pAlex', { role: 'member' }),
  member('elm', 'pPat', { status: 'placeholder' }),
  member('elm', 'pLee', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
]

/**
 * Elm St, a Sydney house: Sam (u1) and Alex (u2) live there, Pat is a placeholder, and Lee (u3)
 * moved out. Each of them has a team membership but Pat. `extra` adds rows by table.
 */
function seeded(extra: Record<string, object[]> = {}, teams: Record<string, string[]> = {}) {
  const [transactions, shares] = [GROCERIES.slice(0, 1), GROCERIES.slice(1)]
  return fakes(
    {
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pPat', null),
        person('pLee', 'u3'),
      ],
      groups: [
        group('elm', 'pSam', {
          type: 'house',
          name: 'Elm St',
          settingsJson: '{"type":"house"}',
          rev: 'r0',
        }),
      ],
      members: MEMBERS,
      transactions,
      shares,
      ...extra,
    } as never,
    { teams: { elm: ['u1', 'u2', 'u3'], ...teams } },
  )
}

/** Posts the milk as a ledger write does: the group's guard, the rows, and the balances row. */
function postMilk(services: Fakes, peopleJson?: string) {
  const create = (
    tableId: 'transactions' | 'shares',
    { $id, ...data }: { $id: string },
  ): Write => ({
    action: 'create',
    tableId,
    rowId: $id,
    data,
  })
  const balances: Write = {
    action: 'update',
    tableId: 'balances',
    rowId: 'elm',
    data: { peopleJson },
  }
  return withTransaction(services.db, (tx) =>
    tx.write(
      { action: 'update', tableId: 'groups', rowId: 'elm', data: { rev: 'r1' } },
      create('transactions', MILK),
      ...MILK_SHARES.map((row) => create('shares', row)),
      ...(peopleJson === undefined ? [] : [balances]),
    ),
  )
}

/** A write to the group row that commits outside the check, as a ledger write's guard does. */
function guard(services: Fakes, rev: string) {
  return withTransaction(services.db, (tx) =>
    tx.write({ action: 'update', tableId: 'groups', rowId: 'elm', data: { rev } }),
  )
}

const DUE = { balances: [{ $id: 'elm', peopleJson: JSON.stringify(ROW) }] }
const AN_HOUR_ON = new Date(NOW.getTime() + HOUR).toISOString()

function stored(services: Fakes, groupId = 'elm') {
  const row = services.db.rows('balances').find((balances) => balances.$id === groupId)
  return row && JSON.parse(String(row.peopleJson))
}

function groupRow(services: Fakes, groupId = 'elm') {
  return services.db.rows('groups').find((row) => row.$id === groupId) as unknown as Groups
}

// The logProblem lines a spy saw, without `fn`.
const linesOf = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => {
    const { fn: _fn, ...event } = JSON.parse(String(line)) as Record<string, unknown>
    return event
  })
const logged = () => linesOf(errors)

describe('step 6: nightly check', () => {
  it('backfills a group’s balances row on its first check, then waits until 03:00 tomorrow', async () => {
    const services = seeded()
    const writes = vi.spyOn(services.db, 'createOperations')
    expect(await nightlyCheck(services)).toEqual({
      checked: 1,
      busy: 0,
      cutOff: 0,
      skipped: 0,
      findings: 0,
      merging: 0,
      repaired: 1,
      removed: 0,
      failed: 0,
    })
    expect(stored(services)).toEqual(ROW)
    // Server-only, with no permissions (data-model.md#balances).
    const upsert = writes.mock.calls
      .flatMap(([params]) => params.operations ?? [])
      .find((operation) => JSON.stringify(operation).includes('"balances"'))
    expect(upsert).toMatchObject({ data: { $permissions: [] } })
    expect(groupRow(services).nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
    // A backfill isn't a finding, and a group that isn't due yet isn't read.
    expect(logged()).toEqual([])
    expect((await nightlyCheck(services)).checked).toBe(0)
  })

  it('checks a due group again, and finds nothing when all is well', async () => {
    const services = seeded({ balances: [{ $id: 'elm', peopleJson: JSON.stringify(ROW) }] })
    vi.setSystemTime(new Date(Date.parse(TOMORROW_3AM_SYDNEY)))
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'groups',
        rowId: 'elm',
        data: { nextCheckAt: NOW.toISOString() },
      }),
    )
    const counts = await nightlyCheck(services)
    expect(counts).toMatchObject({ checked: 1, repaired: 0, findings: 0 })
    expect(logged()).toEqual([])
  })

  it('repairs a balances row that drifted, and logs it with the group ID only', async () => {
    const wrong = [{ personId: 'pSam', netCents: 100, shares: 1 }]
    const services = seeded({ balances: [{ $id: 'elm', peopleJson: JSON.stringify(wrong) }] })
    expect(await nightlyCheck(services)).toMatchObject({ repaired: 1, findings: 1 })
    expect(stored(services)).toEqual(ROW)
    expect(logged()).toEqual([
      { event: 'nightly_check_finding', groupId: 'elm', rule: 'balances_row' },
    ])
  })

  it('repairs a row that can’t be read', async () => {
    const services = seeded({ balances: [{ $id: 'elm', peopleJson: '{' }] })
    expect(await nightlyCheck(services)).toMatchObject({ repaired: 1, findings: 1 })
    expect(stored(services)).toEqual(ROW)
  })

  it('reports broken shares and transactions, and never changes them', async () => {
    const services = seeded({
      transactions: [
        transaction('t1', 6000),
        // I-1: the shares add up to $50, not $60.
        transaction('t2', 6000),
        // I-6: a void transaction with a share left behind.
        transaction('t3', 1000, { status: 'void' }),
        // I-3: shares for two people with no member row, one line for the transaction. Dan
        // has an identity, but nobody is merging him.
        transaction('t4', 1000),
      ],
      shares: [
        ...GROCERIES.slice(1),
        share('s3', 't2', 'pSam', 5000, 2500),
        share('s4', 't2', 'pAlex', 0, 2500),
        share('s5', 't3', 'pSam', 1000, 1000),
        share('s6', 't4', 'pSam', 1000, 0),
        share('s7', 't4', 'pDan', 0, 500),
        share('s8', 't4', 'pEve', 0, 500),
      ],
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pPat', null),
        person('pLee', 'u3'),
        person('pDan', 'u4'),
        person('pEve', null),
      ],
      identities: [
        {
          $id: 'i1',
          key: 'email:dan@example.com',
          type: 'email',
          personId: 'pDan',
          verified: true,
          verifiedAt: null,
        },
      ],
    })
    const before = structuredClone([services.db.rows('shares'), services.db.rows('transactions')])
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 3, merging: 0 })
    expect(logged()).toEqual([
      { event: 'nightly_check_finding', groupId: 'elm', rule: 'I-1', transactionId: 't2' },
      { event: 'nightly_check_finding', groupId: 'elm', rule: 'I-6', transactionId: 't3' },
      { event: 'nightly_check_finding', groupId: 'elm', rule: 'I-3', transactionId: 't4' },
    ])
    expect([services.db.rows('shares'), services.db.rows('transactions')]).toEqual(before)
  })

  it('counts the shares of a placeholder and of a member who left as members’ shares', async () => {
    // Pat, the placeholder, paid $10 for Lee before Lee moved out.
    const services = seeded({
      transactions: [transaction('t1', 6000), transaction('t2', 1000)],
      shares: [
        ...GROCERIES.slice(1),
        share('s3', 't2', 'pPat', 1000, 0),
        share('s4', 't2', 'pLee', 0, 1000),
      ],
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 0, merging: 0 })
    expect(logged()).toEqual([])
  })

  it('counts a share of a person being merged as merging, not as broken', async () => {
    // Pat was merged into Dan, whose merge hasn't moved Pat's share yet; Pat's row went to Dan.
    const services = seeded(
      {
        persons: [
          person('pSam', 'u1'),
          person('pAlex', 'u2'),
          { ...person('pPat', null), mergedInto: 'pDan' },
          person('pLee', 'u3'),
          person('pDan', 'u4'),
        ],
        members: [member('elm', 'pSam'), member('elm', 'pAlex', { role: 'member' })],
        transactions: [transaction('t1', 6000)],
        shares: [share('s1', 't1', 'pSam', 6000, 3000), share('s2', 't1', 'pPat', 0, 3000)],
        // A merge moves P's identities last, so Pat still having one means it isn't finished.
        identities: [
          {
            $id: 'i1',
            key: 'email:pat@example.com',
            type: 'email',
            personId: 'pPat',
            verified: true,
            verifiedAt: null,
          },
        ],
      },
      { elm: ['u1', 'u2'] },
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 0, merging: 1 })

    // Once the merge is finished (no identity left on Pat, and Dan's account is still there), a
    // share left on Pat is broken.
    await withTransaction(services.db, (tx) =>
      tx.write(
        { action: 'delete', tableId: 'identities', rowId: 'i1' },
        { action: 'update', tableId: 'groups', rowId: 'elm', data: { nextCheckAt: null } },
      ),
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 1, merging: 0 })
    expect(logged()).toEqual([
      { event: 'nightly_check_finding', groupId: 'elm', rule: 'I-3', transactionId: 't1' },
    ])
  })

  it('counts a share of a person merged into a deleted account as merging, not as broken', async () => {
    // Pat was merged into Dan, then Dan deleted his account before the merge finished. Deletion
    // deletes Pat's identities too (identity-and-invites.md, step 5), so it never will.
    const services = seeded(
      {
        persons: [
          person('pSam', 'u1'),
          person('pAlex', 'u2'),
          { ...person('pPat', null), mergedInto: 'pDan' },
          { ...person('pDan', null), deletedAt: '2026-10-18T00:00:00.000Z' },
        ],
        members: [member('elm', 'pSam'), member('elm', 'pAlex', { role: 'member' })],
        transactions: [transaction('t1', 6000)],
        shares: [share('s1', 't1', 'pSam', 6000, 3000), share('s2', 't1', 'pPat', 0, 3000)],
      },
      { elm: ['u1', 'u2'] },
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 0, merging: 1 })
    expect(logged()).toEqual([])
  })

  it('reads a group again when a write of shares lands while it is read', async () => {
    const services = seeded()
    const list = services.db.listRows.bind(services.db)
    let writes = 0
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      // A ledger write's group guard lands during the first read only.
      if (params.tableId === 'shares' && ++writes === 1) {
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'update', tableId: 'groups', rowId: 'elm', data: { rev: 'r1' } }),
        )
      }
      return list(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, busy: 0 })
    expect(writes).toBeGreaterThan(1)
  })

  it('reads a group again when a write of shares lands while its balances row is read', async () => {
    const services = seeded(DUE)
    const get = services.db.getRow.bind(services.db)
    let reads = 0
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      // The milk is posted as the row is first read: its shares were read before it.
      if (params.tableId === 'balances' && ++reads === 1) {
        await postMilk(services, JSON.stringify(ROW_WITH_MILK))
      }
      return get(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, findings: 0, repaired: 0 })
    expect(reads).toBe(2)
  })

  it('leaves a group for the next run when writes land during every read', async () => {
    const services = seeded()
    const list = services.db.listRows.bind(services.db)
    let rev = 0
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares') {
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'groups',
            rowId: 'elm',
            data: { rev: `r${++rev}` },
          }),
        )
      }
      return list(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 1 })
    expect(rev).toBe(3)
    // An hour on, so the next run starts with the groups after it.
    expect(groupRow(services).nextCheckAt).toBe(new Date(NOW.getTime() + HOUR).toISOString())
    expect(stored(services)).toBeUndefined()
  })

  it('leaves the row for the next run when a write of shares beats the repair', async () => {
    const services = seeded()
    const commit = services.db.updateTransaction.bind(services.db)
    let first = true
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      if (first && params.commit) {
        first = false
        // A ledger write's guard commits between the repair's staging and its commit.
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'update', tableId: 'groups', rowId: 'elm', data: { rev: 'r9' } }),
        )
      }
      return commit(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 1, repaired: 0 })
    expect(stored(services)).toBeUndefined()
    // Busy, so a run an hour on tries again.
    expect(groupRow(services).nextCheckAt).toBe(AN_HOUR_ON)
  })

  it('sums the shares after staging its guard, so a write of shares just before it counts', async () => {
    const services = seeded()
    // The milk is posted after the group is read whole, just before the repair stages its guard.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rev"'),
      () => postMilk(services),
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, repaired: 1 })
    expect(stored(services)).toEqual(ROW_WITH_MILK)
  })

  it('doesn’t write a balances row the shares make invalid, and fails the group', async () => {
    // A net past the largest safe integer: Sam paid that much for Alex, on top of the groceries.
    const huge = Number.MAX_SAFE_INTEGER
    const services = seeded({
      transactions: [transaction('t1', 6000), transaction('t2', huge)],
      shares: [
        ...GROCERIES.slice(1),
        share('s3', 't2', 'pSam', huge, 0),
        share('s4', 't2', 'pAlex', 0, huge),
      ],
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, repaired: 0, failed: 1 })
    expect(stored(services)).toBeUndefined()
    // Rolled back, guard and all, and left due.
    expect(groupRow(services).rev).toBe('r0')
    expect(groupRow(services).nextCheckAt ?? null).toBeNull()
    expect(logged()).toEqual([
      { event: 'nightly_check_failed', groupId: 'elm', cause: 'LedgerError' },
    ])
  })

  it('still removes a stale membership from a group whose balances fail', async () => {
    const huge = Number.MAX_SAFE_INTEGER
    // u9 has no member row: a stale membership, in a group whose sums make no valid row.
    const services = seeded(
      {
        transactions: [transaction('t1', 6000), transaction('t2', huge)],
        shares: [
          ...GROCERIES.slice(1),
          share('s3', 't2', 'pSam', huge, 0),
          share('s4', 't2', 'pAlex', 0, huge),
        ],
      },
      { elm: ['u1', 'u2', 'u3', 'u9'] },
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await nightlyCheck(services)).toMatchObject({ failed: 1, removed: 1 })
    expect(services.teams.members('elm')?.map((membership) => membership.userId)).not.toContain(
      'u9',
    )
  })

  it('puts a group off an hour when a write to its row beats its nextCheckAt', async () => {
    const services = seeded(DUE)
    beforeCommit(services.db, () => guard(services, 'r1'))
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 1 })
    expect(groupRow(services).nextCheckAt).toBe(AN_HOUR_ON)
  })

  it('leaves a group due when writes to its row beat its nextCheckAt twice', async () => {
    const services = seeded(DUE)
    const commit = services.db.updateTransaction.bind(services.db)
    let landing = false
    let rev = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // A ledger write's guard commits before each of the check's commits.
      if (params.commit && !landing) {
        landing = true
        await guard(services, `r${++rev}`)
        landing = false
      }
      return commit(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 1 })
    expect(rev).toBe(2)
    expect(groupRow(services).nextCheckAt ?? null).toBeNull()
  })

  it('fails a group whose nextCheckAt can’t be written for another reason', async () => {
    const services = seeded(DUE)
    vi.spyOn(services.db, 'updateTransaction').mockRejectedValueOnce(
      new AppwriteException('Server error', 500, 'general_unknown'),
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, busy: 0, failed: 1 })
    expect(logged()).toEqual([
      {
        event: 'nightly_check_failed',
        groupId: 'elm',
        cause: 'AppwriteException 500 general_unknown',
      },
    ])
  })

  it('moves a group the budget cuts off to tomorrow, by ID, and checks it then from the start', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // u9 has no member row: a stale membership.
    const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
    // Out of time once the group is read whole.
    let read = false
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'shares') read = true
      return list(params)
    })
    services.outOfTime = () => read
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, cutOff: 1, repaired: 0 })
    expect(groupRow(services).nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
    expect(linesOf(warned).at(-1)).toEqual({ event: 'nightly_check_cut_off', groupId: 'elm' })
    // The team wasn't reached.
    expect(services.teams.members('elm')).toHaveLength(4)
    services.outOfTime = () => false
    services.now = new Date(TOMORROW_3AM_SYDNEY)
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, repaired: 1, removed: 1 })
  })

  it('leaves a group it doesn’t reach due, for the next run', async () => {
    const services = seeded(
      {
        groups: [
          group('elm', 'pSam', { type: 'house', name: 'Elm St', settingsJson: '{"type":"house"}' }),
          group('oak', 'pSam', { type: 'house', name: 'Oak Rd', settingsJson: '{"type":"house"}' }),
        ],
      },
      { oak: ['u1'] },
    )
    // Out of time once Elm St is done.
    services.outOfTime = () => Boolean(groupRow(services).nextCheckAt)
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, cutOff: 0 })
    expect(groupRow(services, 'oak').nextCheckAt ?? null).toBeNull()
  })

  it('skips a group whose team is gone, as a purge leaves it, and leaves it due', async () => {
    // The purge has deleted the team and some of the group's shares: s2 is gone.
    const services = seeded({ shares: [GROCERIES[1] as object] })
    services.teams = new FakeTeams()
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, skipped: 1, findings: 0 })
    expect(stored(services)).toBeUndefined()
    expect(groupRow(services).nextCheckAt ?? null).toBeNull()
    expect(logged()).toEqual([])
  })

  it('skips a group whose purge starts during the read, with no findings', async () => {
    const services = seeded()
    // The purge deletes the team, then a batch of shares without the group's guard, while the
    // check reads.
    const list = services.db.listRows.bind(services.db)
    let purged = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const result = await list(params)
      if (params.tableId === 'shares' && !purged) {
        purged = true
        services.teams = new FakeTeams()
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'shares', rowId: 's2' }),
        )
      }
      return result
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, skipped: 1, findings: 0 })
    expect(stored(services)).toBeUndefined()
    expect(logged()).toEqual([])
  })

  it('skips a group whose row a purge deletes during the read', async () => {
    const services = seeded()
    const get = services.db.getRow.bind(services.db)
    let reads = 0
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      if (params.tableId === 'groups' && ++reads === 2) {
        services.teams = new FakeTeams()
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'groups', rowId: 'elm' }),
        )
      }
      return get(params)
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, skipped: 1, failed: 0 })
    expect(logged()).toEqual([])
  })

  it('reads a big group whole, page by page, with at most 100 IDs in any one filter', async () => {
    // 250 members and 250 transactions with 500 shares; 150 of them belong to strangers merged
    // into Sam, whose merges aren't finished.
    const ids = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, n) => `${prefix}${String(n).padStart(3, '0')}`)
    const people = ids('pM', 250)
    const strangers = ids('pS', 150)
    const transactions = ids('tB', 250).map((id) => transaction(id, 100))
    const shares = transactions.flatMap(({ $id }, n) => [
      share(`${$id}a`, $id, people[n] as string, 100, 0),
      share(
        `${$id}b`,
        $id,
        n < 150 ? (strangers[n] as string) : (people[(n + 1) % 250] as string),
        0,
        100,
      ),
    ])
    const services = seeded({
      persons: [
        person('pSam', 'u1'),
        person('pAlex', 'u2'),
        person('pPat', null),
        person('pLee', 'u3'),
        ...people.map((id) => person(id, null)),
        ...strangers.map((id) => ({ ...person(id, null), mergedInto: 'pSam' })),
      ],
      members: [
        member('elm', 'pSam'),
        member('elm', 'pAlex', { role: 'member' }),
        member('elm', 'pPat', { status: 'placeholder' }),
        member('elm', 'pLee', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
        ...people.map((id) => member('elm', id, { status: 'placeholder' })),
      ],
      identities: strangers.map((id, n) => ({
        $id: `i${n}`,
        key: `email:s${n}@example.com`,
        type: 'email',
        personId: id,
        verified: false,
      })),
      transactions: [GROCERIES[0] as object, ...transactions],
      shares: [GROCERIES[1] as object, GROCERIES[2] as object, ...shares],
    })
    const reads = vi.spyOn(services.db, 'listRows')
    expect(await nightlyCheck(services)).toMatchObject({
      checked: 1,
      findings: 0,
      merging: 150,
      repaired: 1,
    })
    // Everyone with a share: Sam, Alex, the 250 members and the 150 strangers.
    expect(stored(services)).toHaveLength(402)
    const widest = Math.max(
      ...reads.mock.calls.flatMap(([params]) =>
        (params.queries ?? [])
          .map((query) => JSON.parse(query) as { method: string; values?: unknown[] })
          .filter((query) => query.method === 'equal')
          .map((query) => query.values?.length ?? 0),
      ),
    )
    expect(widest).toBeLessThanOrEqual(100)
  })

  it('checks every due group, page by page', async () => {
    const groups = Array.from({ length: 250 }, (_, n) =>
      group(`g${String(n).padStart(3, '0')}`, 'pSam', {
        type: 'house',
        name: 'Flat',
        settingsJson: '{"type":"house"}',
        rev: 'r0',
      }),
    )
    const services = fakes({ persons: [person('pSam', 'u1')], groups } as never, {
      teams: Object.fromEntries(groups.map((row) => [row.$id, []])),
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 250, failed: 0, busy: 0 })
  })

  it('fails a group whose team can’t be read, and leaves it due', async () => {
    const services = seeded()
    vi.spyOn(services.teams, 'listMemberships').mockRejectedValue(
      new AppwriteException('Server error', 500, 'general_unknown'),
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 0, skipped: 0, failed: 1 })
    expect(groupRow(services).nextCheckAt ?? null).toBeNull()
    expect(logged()).toEqual([
      {
        event: 'nightly_check_failed',
        groupId: 'elm',
        cause: 'AppwriteException 500 general_unknown',
      },
    ])
  })

  it('counts a group that fails, leaves it due, and goes on to the next', async () => {
    const house = { type: 'house', settingsJson: '{"type":"house"}' } as const
    const services = seeded(
      {
        groups: [
          group('elm', 'pSam', { ...house, name: 'Elm St', timezone: 'Nowhere/Elm' }),
          group('oak', 'pSam', { ...house, name: 'Oak Rd' }),
        ],
      },
      { oak: [] },
    )
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, failed: 1 })
    expect(groupRow(services).nextCheckAt ?? null).toBeNull()
    expect(groupRow(services, 'oak').nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
    expect(logged()).toEqual([
      { event: 'nightly_check_failed', groupId: 'elm', cause: 'RangeError' },
    ])
  })

  it('checks archived groups too', async () => {
    const services = seeded({
      groups: [
        group('elm', 'pSam', {
          type: 'house',
          name: 'Elm St',
          settingsJson: '{"type":"house"}',
          archivedAt: '2026-10-01T00:00:00.000Z',
        }),
      ],
    })
    expect(await nightlyCheck(services)).toMatchObject({ checked: 1, repaired: 1 })
  })

  it('is due at 03:00 local, across a daylight saving change', async () => {
    // Sydney moves its clocks forward at 02:00 on Sunday 4 October 2026: 03:00 on the 4th is
    // 16:00 UTC on the 3rd, and 03:00 on the 3rd was 17:00 UTC on the 2nd.
    vi.setSystemTime(new Date('2026-10-02T20:00:00.000Z'))
    const services = seeded()
    services.now = new Date('2026-10-02T20:00:00.000Z')
    await nightlyCheck(services)
    expect(groupRow(services).nextCheckAt).toBe('2026-10-03T16:00:00.000Z')
  })

  describe('the team', () => {
    // Pat, the placeholder, has an account now.
    const PAT_SIGNED_UP = [
      person('pSam', 'u1'),
      person('pAlex', 'u2'),
      person('pPat', 'u9'),
      person('pLee', 'u3'),
    ]
    const userIds = (services: Fakes, groupId = 'elm') =>
      services.teams.members(groupId)?.map((membership) => membership.userId)

    it('removes a membership that no joined member row backs, and logs only its ID', async () => {
      // Pat got a membership: a join that stopped halfway.
      const services = seeded({ persons: PAT_SIGNED_UP }, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const stale = services.teams.members('elm')?.find((membership) => membership.userId === 'u9')
      expect(await nightlyCheck(services)).toMatchObject({ removed: 1, findings: 1 })
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3'])
      expect(logged()).toEqual([
        { event: 'team_membership_removed', groupId: 'elm', membershipId: stale?.$id },
      ])
    })

    it('keeps a membership up to an hour old, and removes one older', async () => {
      for (const [minutes, removed] of [
        [59, 0],
        [60, 0],
        [61, 1],
      ] as const) {
        const services = seeded({ persons: PAT_SIGNED_UP })
        // Joining adds the membership before the member row.
        vi.setSystemTime(new Date(NOW.getTime() - minutes * 60 * 1000))
        await services.teams.createMembership({ teamId: 'elm', userId: 'u9', roles: [] })
        vi.setSystemTime(NOW)
        expect([minutes, (await nightlyCheck(services)).removed]).toEqual([minutes, removed])
      }
    })

    it('never removes one whose join lands after the group is read', async () => {
      const services = seeded({ persons: PAT_SIGNED_UP }, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const remove = vi.spyOn(services.teams, 'deleteMembership')
      const list = services.db.listRows.bind(services.db)
      let joined = false
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        // Pat's join commits as the check looks up the team's persons.
        if (!joined && params.tableId === 'persons') {
          joined = true
          await withTransaction(services.db, (tx) =>
            tx.write({
              action: 'update',
              tableId: 'members',
              rowId: 'elm-pPat',
              data: { status: 'active' },
            }),
          )
        }
        return list(params)
      })
      expect((await nightlyCheck(services)).removed).toBe(0)
      expect(remove).not.toHaveBeenCalled()
      expect(userIds(services)).toContain('u9')
    })

    it('keeps someone who moved out, and removes someone who left on their own', async () => {
      const services = seeded({
        activity: [
          {
            $id: 'a1',
            $createdAt: '2026-10-01T00:00:00.000Z',
            at: '2026-10-01T00:00:00.000Z',
            groupId: 'elm',
            actorPersonId: 'pAlex',
            action: 'member.left',
            transactionId: null,
            summary: 'Member left',
            changesJson: null,
          },
        ],
        members: [
          member('elm', 'pSam'),
          member('elm', 'pAlex', {
            $createdAt: '2026-09-01T00:00:00.000Z',
            role: 'viewer',
            status: 'left',
            leftOn: '2026-10-01',
          }),
          member('elm', 'pPat', { status: 'placeholder' }),
          member('elm', 'pLee', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
        ],
      })
      expect((await nightlyCheck(services)).removed).toBe(1)
      expect(userIds(services)).toEqual(['u1', 'u3'])
    })

    it('leaves alone the membership of someone whose account is being deleted', async () => {
      // Pat's deletion is between its member transaction and its team step.
      const services = seeded(
        {
          persons: [
            person('pSam', 'u1'),
            person('pAlex', 'u2'),
            { ...person('pPat', 'u9'), deletedAt: '2026-10-18T19:00:00.000Z' },
            person('pLee', 'u3'),
          ],
        },
        { elm: ['u1', 'u2', 'u3', 'u9'] },
      )
      expect((await nightlyCheck(services)).removed).toBe(0)
      expect(userIds(services)).toContain('u9')
    })

    it('keeps one that any of the user’s persons keeps', async () => {
      // idx_userId isn't unique: a second person with the same user ID, read after the first.
      for (const [persons, team] of [
        // Alex's other person has no member row here.
        [
          [...PAT_SIGNED_UP, person('pAlex2', 'u2')],
          ['u1', 'u2', 'u3'],
        ],
        // One of Pat's persons is being deleted.
        [
          [{ ...person('pPat0', 'u9'), deletedAt: '2026-10-18T19:00:00.000Z' }, ...PAT_SIGNED_UP],
          ['u1', 'u2', 'u3', 'u9'],
        ],
      ] as const) {
        const services = seeded({ persons: [...persons] }, { elm: [...team] })
        expect((await nightlyCheck(services)).removed).toBe(0)
        expect(userIds(services)).toEqual(team)
      }
    })

    it('counts only the member rows in this group', async () => {
      // Pat joined Oak Rd, and is still a placeholder in Elm St.
      const services = seeded(
        { persons: PAT_SIGNED_UP, members: [...MEMBERS, member('oak', 'pPat')] },
        { elm: ['u1', 'u2', 'u3', 'u9'] },
      )
      expect((await nightlyCheck(services)).removed).toBe(1)
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3'])
    })

    it('puts a membership back when a join or a deletion lands while it is removed', async () => {
      for (const [tableId, rowId, data] of [
        // Pat's join commits just as the membership goes.
        ['members', 'elm-pPat', { status: 'active' }],
        // Or Pat's account deletion starts.
        ['persons', 'pPat', { deletedAt: '2026-10-18T20:00:00.000Z' }],
      ] as const) {
        const services = seeded({ persons: PAT_SIGNED_UP }, { elm: ['u1', 'u2', 'u3', 'u9'] })
        const remove = services.teams.deleteMembership.bind(services.teams)
        vi.spyOn(services.teams, 'deleteMembership').mockImplementation(async (params) => {
          await withTransaction(services.db, (tx) =>
            tx.write({ action: 'update', tableId, rowId, data }),
          )
          return (await remove(params)) as object
        })
        expect(await nightlyCheck(services)).toMatchObject({ removed: 0, findings: 0 })
        expect(userIds(services)).toContain('u9')
      }
    })

    it('reads every page of the team', async () => {
      const services = seeded()
      // 100 joins under way, then a stale membership past the first page.
      for (let index = 0; index < 100; index++) {
        await services.teams.createMembership({ teamId: 'elm', userId: `new${index}`, roles: [] })
      }
      vi.setSystemTime(new Date(NOW.getTime() - 2 * HOUR))
      await services.teams.createMembership({ teamId: 'elm', userId: 'u9', roles: [] })
      vi.setSystemTime(NOW)
      expect((await nightlyCheck(services)).removed).toBe(1)
      expect(userIds(services)).toHaveLength(103)
      expect(userIds(services)).not.toContain('u9')
    })

    it('counts a membership already gone as removed', async () => {
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const remove = services.teams.deleteMembership.bind(services.teams)
      // Another run removed it first, so this delete gets 404.
      vi.spyOn(services.teams, 'deleteMembership').mockImplementation(async (params) => {
        await remove(params)
        return (await remove(params)) as object
      })
      expect((await nightlyCheck(services)).removed).toBe(1)
    })

    it('counts the memberships it removed before a failure', async () => {
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u8', 'u9'] })
      const last = services.teams.members('elm')?.[4]?.$id
      const remove = services.teams.deleteMembership.bind(services.teams)
      vi.spyOn(services.teams, 'deleteMembership').mockImplementation(async (params) => {
        // u8's goes, then Teams fails on u9's.
        if (params.membershipId === last) {
          throw new AppwriteException('Server error', 500, 'general_unknown')
        }
        return (await remove(params)) as object
      })
      expect(await nightlyCheck(services)).toMatchObject({ checked: 0, removed: 1, failed: 1 })
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3', 'u9'])
    })

    it('leaves the stale memberships after the budget runs out for the next check', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u8', 'u9'] })
      const remove = vi.spyOn(services.teams, 'deleteMembership')
      // Out of time once u8's membership is removed.
      services.outOfTime = () => remove.mock.calls.length > 0
      expect(await nightlyCheck(services)).toMatchObject({ checked: 0, cutOff: 1, removed: 1 })
      expect(userIds(services)).toEqual(['u1', 'u2', 'u3', 'u9'])
      expect(groupRow(services).nextCheckAt).toBe(TOMORROW_3AM_SYDNEY)
      expect(linesOf(warn).at(-1)).toEqual({ event: 'nightly_check_cut_off', groupId: 'elm' })
    })

    it('is never removed by a route that people call', async () => {
      const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
      const remove = vi.spyOn(services.teams, 'deleteMembership')
      const add = vi.spyOn(services.teams, 'createMembership')
      const body = {
        id: 'groceriesElm00000001',
        groupId: 'elm',
        kind: 'expense',
        description: 'Groceries',
        template: { totalCents: 6_000, split: { mode: 'equal', personIds: ['pSam', 'pAlex'] } },
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        startsOn: '2026-10-12',
        skipPublicHolidays: false,
        autoPost: false,
      }
      const { id, ...preview } = body
      const path = `/schedules/${id}`
      for (const [method, url, options] of [
        ['POST', '/schedules/preview', { body: preview }],
        ['POST', '/schedules', { body }],
        ['PATCH', path, { body: { ...body, description: 'Food' } }],
        ['POST', `${path}/end`, { body: { endsOn: '2026-10-31' } }],
        ['DELETE', path, {}],
      ] as const) {
        const { body: sent } = await call(services, method, url, options)
        expect([method, url, sent]).toMatchObject([method, url, { ok: true }])
      }
      expect(remove).not.toHaveBeenCalled()
      expect(add).not.toHaveBeenCalled()
    })
  })
})

describe('the team writes (teams.write)', () => {
  it('are reached by no route that people call', async () => {
    // Only step 6 writes to a team, and only the cron run calls step 6.
    const src = new URL('../src/', import.meta.url)
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) =>
      file.endsWith('.ts'),
    )
    const text = (file: string) => readFileSync(new URL(file, src), 'utf8')
    const writes =
      /\b(createMembership|deleteMembership|updateMembership|addToTeam|removeFromTeam|ensureTeam)\(/
    expect(files.filter((file) => writes.test(text(file)))).toEqual(['steps/nightly-check.ts'])
    expect(files.filter((file) => /from '[./]+(steps\/)?nightly-check'/.test(text(file)))).toEqual([
      'routes/run.ts',
    ])
    // And the cron route refuses a person, whatever the trigger says: u9's stale membership stays.
    const services = seeded({}, { elm: ['u1', 'u2', 'u3', 'u9'] })
    const remove = vi.spyOn(services.teams, 'deleteMembership')
    expect((await call(services, 'POST', '/', { userId: 'u1', scheduled: true })).status).toBe(403)
    expect(remove).not.toHaveBeenCalled()
  })
})
