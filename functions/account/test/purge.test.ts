import type { DeleteAccountResult } from '@ledgerly/core/schemas/identity'
import { TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import {
  beforeStaging,
  call,
  crashOnCall,
  type Fakes,
  fakes,
  group,
  insert,
  member,
  NOW,
  ok,
  person,
  rowOf,
  schedule,
  setRow,
  TODAY,
  teamOf,
} from './harness'

const DELETED_AT = NOW.toISOString()
const BEFORE = '2026-09-01T00:00:00.000Z'
const PURGED = ['me', 'h2', 'h3']
const team = (groupId: string) => `read("team:${groupId}")`

// Made by ID.unique(): rows a deletion writes, such as h1's member.left.
const UNIQUE_ID = /^[0-9a-f]{20}$/

// Sam (p1, u1) is alone in the teams of their personal group `me` and of the house h2, where
// they added Kim (only there), Lee (also in Alex's house h1), Old (merged into Alex since) and
// Ray (p3, u3, who left on their own). Sam and Lee are in h1 with Alex (p2, u2), who keeps it.
// Sam and Alex both left the house h3 on their own, so nobody is left in its team.
// `moreActivity` more rows in h2 make its purge take several batches.
function world(moreActivity = 0) {
  const services = fakes(
    {
      persons: [
        person('p1', 'u1', { displayName: 'Sam Lee' }),
        person('p2', 'u2'),
        person('p3', 'u3'),
        person('pKim', null),
        person('pLee', null),
        person('pOld', null, { mergedInto: 'p2' }),
      ],
      identities: [
        identity('iSam', 'email:sam@example.com', 'p1'),
        identity('iKim', 'email:kim@example.com', 'pKim'),
        identity('iKim2', 'phone:+61412345678', 'pKim'),
        identity('iLee', 'email:lee@example.com', 'pLee'),
      ],
      profiles: [{ $id: 'u1', personId: 'p1', timezone: 'Australia/Sydney', region: 'AU-NSW' }],
      groups: [
        group('me', 'personal', 'p1'),
        group('h2', 'house', 'p1'),
        group('h1', 'house', 'p2'),
        group('h3', 'house', 'p2'),
      ],
      members: [
        member('me', 'p1'),
        member('h2', 'p1'),
        member('h2', 'pKim', { role: 'member', status: 'placeholder' }),
        member('h2', 'pLee', { role: 'member', status: 'placeholder' }),
        member('h2', 'pOld', { role: 'member', status: 'placeholder' }),
        member('h2', 'p3', { role: 'viewer', status: 'left', leftOn: '2026-09-30' }),
        member('h1', 'p2'),
        member('h1', 'p1', { role: 'member' }),
        member('h1', 'pLee', { role: 'member', status: 'placeholder' }),
        member('h3', 'p1', { role: 'viewer', status: 'left', leftOn: '2026-09-01' }),
        member('h3', 'p2', { role: 'viewer', status: 'left', leftOn: '2026-09-02' }),
      ],
      transactions: [
        posted('t1', 'me', 3000, { receiptFileIds: ['r1'] }),
        posted('t2', 'me', 5000, { kind: 'income' }),
        posted('t3', 'h2', 9000, { receiptFileIds: ['r2', 'r3', 'r4'] }),
        posted('t4', 'h2', 600, { statementId: 'st1' }),
        posted('t9', 'h1', 4000, { receiptFileIds: ['r9'] }),
      ],
      shares: [
        share('t1', 'me', 'p1', 3000, 3000),
        share('t2', 'me', 'p1', 5000, 5000),
        share('t3', 'h2', 'p1', 9000, 3000),
        share('t3', 'h2', 'pKim', 0, 3000),
        share('t3', 'h2', 'pLee', 0, 3000),
        share('t4', 'h2', 'p3', 600, 0),
        share('t4', 'h2', 'p1', 0, 600),
        share('t9', 'h1', 'p2', 4000, 2000),
        share('t9', 'h1', 'p1', 0, 2000),
      ],
      items: [item('t1', 0, 2000), item('t1', 1, 1000), item('t9', 0, 4000)],
      balances: [
        { $id: 'me', peopleJson: '[]' },
        { $id: 'h2', peopleJson: '[]' },
        { $id: 'h1', peopleJson: '[]' },
      ],
      schedules: [schedule('sMe', 'me', 'p1', ['p1']), schedule('sH2', 'h2', 'p1', ['p1', 'pKim'])],
      statements: [
        statement('st1', 'h2', 'final'),
        statement('st2', 'h2', 'void'),
        statement('st9', 'h1', 'final'),
      ],
      activity: [
        activity('a1', 'me', 'transaction.created'),
        activity('a2', 'h2', 'member.added'),
        activity('a9', 'h1', 'member.added'),
        activity('a3', 'h3', 'member.left', { subjectPersonId: 'p1' }),
        activity('a4', 'h3', 'member.left', { actorPersonId: 'p2', subjectPersonId: 'p2' }),
        ...Array.from({ length: moreActivity }, (_, index) =>
          activity(`aMany${index}`, 'h2', 'transaction.created'),
        ),
      ],
    },
    { teams: { me: ['u1'], h2: ['u1'], h1: ['u1', 'u2'], h3: [] } },
  )
  services.files.upload('receipts', 'r1', [team('me')])
  services.files.upload('receipts', 'r2', [team('h2')])
  // Also on h1's transactions, which limited it to h1's team when it was attached there.
  services.files.upload('receipts', 'r3', [team('h1')])
  // Not exactly the team's read.
  services.files.upload('receipts', 'r4', [team('h2'), 'delete("user:u1")'])
  services.files.upload('receipts', 'r9', [team('h1')])
  services.files.upload('statements', 'st1', [team('h2')])
  services.files.upload('statements', 'st2', [team('h2')])
  services.files.upload('statements', 'st9', [team('h1')])
  return services
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: key.split(':')[0], personId, verified: false, verifiedAt: null }
}

function posted(id: string, groupId: string, totalCents: number, extra: object = {}) {
  return {
    $id: id,
    groupId,
    kind: 'expense',
    status: 'posted',
    date: '2026-10-01',
    description: 'Groceries',
    totalCents,
    inputJson: '{}',
    receiptFileIds: null,
    statementId: null,
    createdBy: 'p1',
    updatedBy: 'p1',
    ...extra,
  }
}

function share(
  transactionId: string,
  groupId: string,
  personId: string,
  givenCents: number,
  receivedCents: number,
) {
  return {
    $id: `${transactionId}-${personId}`,
    transactionId,
    personId,
    givenCents,
    receivedCents,
    groupId,
    date: '2026-10-01',
    kind: 'expense',
  }
}

function item(transactionId: string, position: number, amountCents: number) {
  return {
    $id: `${transactionId}-item${position}`,
    transactionId,
    position,
    name: 'Bread',
    amountCents,
    splitJson: '{}',
  }
}

function statement(id: string, groupId: string, status: string) {
  return {
    $id: id,
    groupId,
    type: 'divide',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status,
    snapshotJson: '{}',
    pdfFileId: status === 'draft' || status === 'finalizing' ? null : id,
  }
}

// Written before the deletion started, as Appwrite's $createdAt says.
function activity(id: string, groupId: string, action: string, extra: object = {}) {
  return {
    $id: id,
    $createdAt: BEFORE,
    groupId,
    actorPersonId: 'p1',
    action,
    summary: action,
    at: BEFORE,
    ...extra,
  }
}

function remove(services: Fakes) {
  return ok<DeleteAccountResult>(services)
}

/** Every row of every table, every team, file and account, for "the same end state" checks. */
function state(services: Fakes) {
  const rows = Object.fromEntries(
    Object.values(TABLES).map((tableId) => [
      tableId,
      services.db
        .rows(tableId)
        // Made by the clock or at random: Appwrite's timestamps, guard values, activity IDs.
        .map(({ $createdAt, $updatedAt, $sequence, rev, ...row }) =>
          JSON.stringify(UNIQUE_ID.test(row.$id) ? { ...row, $id: 'unique' } : row),
        )
        .sort(),
    ]),
  )
  const teams = Object.fromEntries(
    services.teams.teamIds().map((teamId) => [teamId, teamOf(services, teamId)]),
  )
  const users = ['u1', 'u2', 'u3'].map((id) => services.users.account(id))
  return { rows, teams, files: services.files.ids().sort(), users }
}

// The rows of these groups (row ID = group ID for the group and its balances), and any item
// whose transaction is gone.
function leftOf(services: Fakes, groupIds: string[]) {
  const transactionIds = new Set(services.db.rows('transactions').map((row) => row.$id))
  return Object.values(TABLES).flatMap((tableId: TableId) =>
    services.db
      .rows(tableId)
      .filter(
        (row) =>
          groupIds.includes(row.groupId as string) ||
          groupIds.includes(row.$id) ||
          (tableId === 'items' && !transactionIds.has(row.transactionId as string)),
      )
      .map((row) => `${tableId}/${row.$id}`),
  )
}

function deleteRow(services: Fakes, tableId: TableId, rowId: string) {
  return withTransaction(services.db, (tx) => tx.write({ action: 'delete', tableId, rowId }))
}

async function oneRun(moreActivity = 0) {
  const services = world(moreActivity)
  expect((await remove(services)).finished).toBe(true)
  return state(services)
}

describe('POST /delete: purging a group nobody else is in', () => {
  it('deletes its team, files and rows, the balances row included, then finishes steps 5 to 7', async () => {
    const services = world()
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(leftOf(services, PURGED)).toEqual([])
    expect(teamOf(services, 'me')).toBeUndefined()
    expect(teamOf(services, 'h2')).toBeUndefined()
    // Only files readable by exactly the purged group's team go.
    expect(services.files.ids().sort()).toEqual([
      'receipts/r3',
      'receipts/r4',
      'receipts/r9',
      'statements/st9',
    ])
    // h1 is kept: the same rows, and their member.left.
    const kept = leftOf(services, ['h1'])
    expect(kept.filter((row) => !UNIQUE_ID.test(row.split('/')[1] as string))).toEqual(
      leftOf(world(), ['h1']),
    )
    expect(rowOf(services, 'members', 'h1-p1')).toMatchObject({ status: 'left' })
    expect(rowOf(services, 'persons', 'p1')).toMatchObject({ userId: null, deletedAt: DELETED_AT })
    expect(services.users.account('u1')).toBeUndefined()
  })

  it('deletes a placeholder only the purged group named, with its identities, and keeps the rest', async () => {
    const services = world()
    await remove(services)
    expect(rowOf(services, 'persons', 'pKim')).toBeUndefined()
    expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iLee'])
    // Lee is also in h1; Old was merged; Ray has an account; Sam is kept as "Former member".
    expect(services.db.rows('persons').map((row) => row.$id)).toEqual([
      'p1',
      'p2',
      'p3',
      'pLee',
      'pOld',
    ])
    expect(rowOf(services, 'members', 'h1-pLee')).toBeDefined()
  })

  it('keeps a placeholder that a merge marks after it was first checked', async () => {
    const services = world()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"persons"') && operations.includes('pKim'),
      () => setRow(services, 'persons', 'pKim', { mergedInto: 'p2' }),
    )
    expect((await remove(services)).finished).toBe(false)
    expect(rowOf(services, 'members', 'h2-pKim')).toBeDefined()
    vi.restoreAllMocks()
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ mergedInto: 'p2' })
    expect(services.db.rows('identities').map((row) => row.$id)).toEqual(['iKim', 'iKim2', 'iLee'])
    expect(rowOf(services, 'members', 'h2-pKim')).toBeUndefined()
  })

  it('writes at most 90 rows per transaction, never splitting a transaction from its shares and items, the balances row first', async () => {
    const services = world(85)
    // Three of 30 items each: two fit in a batch with t3 and t4, the third doesn't.
    await insert(
      services,
      'transactions',
      [0, 1, 2].map((n) => posted(`tBig${n}`, 'h2', 4500)),
    )
    for (const n of [0, 1, 2]) {
      await insert(
        services,
        'items',
        Array.from({ length: 30 }, (_, position) => item(`tBig${n}`, position, 150)),
      )
    }
    const batches: string[][] = []
    const stage = services.db.createOperations.bind(services.db)
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      const writes = params.operations as Array<{ tableId: string; rowId: string }>
      batches.push(writes.map(({ tableId, rowId }) => `${tableId}/${rowId}`))
      return stage(params)
    })
    expect((await remove(services)).finished).toBe(true)
    expect(leftOf(services, PURGED)).toEqual([])
    expect(batches.every((writes) => writes.length <= 90)).toBe(true)
    const first = batches.findIndex((writes) => writes.includes('balances/h2'))
    expect(batches[first]?.[0]).toBe('balances/h2')
    // Shares and items have IDs `<transactionId>-…` here.
    for (const transactionId of ['t3', 't4', 'tBig0', 'tBig1', 'tBig2']) {
      const holding = batches.filter((writes) =>
        writes.some(
          (write) =>
            write === `transactions/${transactionId}` || write.includes(`/${transactionId}-`),
        ),
      )
      expect(holding).toHaveLength(1)
      expect(holding[0]).toContain(`transactions/${transactionId}`)
    }
    expect(batches[first]).not.toContain('transactions/tBig2')
    expect(batches[first + 1]).toContain('items/tBig2-item29')
  })

  it('deletes a balances row a nightly check built again after the first batch', async () => {
    const services = world()
    // It read the team before the purge deleted it, then repaired the missing row.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rowId":"h2-p3"'),
      () => insert(services, 'balances', [{ $id: 'h2', peopleJson: '[]' }]),
    )
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'balances', 'h2')).toBeUndefined()
  })

  it('purges a group they left on their own once nobody else is left in its team', async () => {
    const services = world()
    expect((await remove(services)).finished).toBe(true)
    expect(leftOf(services, ['h3'])).toEqual([])
    expect(teamOf(services, 'h3')).toBeUndefined()
    // Alex keeps their person: only the group's rows go.
    expect(rowOf(services, 'persons', 'p2')).toBeDefined()
  })

  it('waits while a statement is being finalized, changing nothing, then purges on a later run', async () => {
    const services = world()
    await insert(services, 'statements', [statement('st3', 'h2', 'finalizing')])
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: false })
    expect(rowOf(services, 'groups', 'h2')).toMatchObject({ archivedAt: null })
    expect(teamOf(services, 'h2')).toEqual(['u1'])
    expect(rowOf(services, 'transactions', 't3')).toBeDefined()
    expect(services.files.ids()).toContain('receipts/r2')
    // `me` was purged meanwhile; steps 5–7 wait for h2.
    expect(rowOf(services, 'groups', 'me')).toBeUndefined()
    expect(services.users.account('u1')).toBeDefined()

    await setRow(services, 'statements', 'st3', { status: 'final' })
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(leftOf(services, PURGED)).toEqual([])
  })

  it('doesn’t wait for a timer someone else left running: it goes with the group', async () => {
    const services = world()
    await insert(services, 'transactions', [
      {
        $id: 'tRunning',
        groupId: 'h2',
        kind: 'shift',
        status: 'running',
        date: TODAY,
        description: 'Shift',
        totalCents: 0,
        inputJson: '{}',
        startedAt: NOW.toISOString(),
        createdBy: 'p2',
        updatedBy: 'p2',
      },
    ])
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(rowOf(services, 'transactions', 'tRunning')).toBeUndefined()
    expect(leftOf(services, PURGED)).toEqual([])
  })

  it('stops wherever the time budget runs out, and a rerun finishes with the same rows', async () => {
    const end = await oneRun()
    for (let budget = 1; ; budget += 7) {
      const services = world()
      let calls = 0
      services.outOfTime = () => ++calls > budget
      const { finished } = await remove(services)
      services.outOfTime = () => false
      if (finished) break
      expect((await remove(services)).finished).toBe(true)
      expect(state(services)).toEqual(end)
    }
  })

  it('leaves a group to the next run when one of its rows is deleted meanwhile, as by another run', async () => {
    const services = world()
    // Staging the delete of a row that's gone fails with 409 (#243).
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rowId":"t3"'),
      () => deleteRow(services, 'shares', 't3-pKim'),
    )
    expect((await remove(services)).finished).toBe(false)
    expect(rowOf(services, 'transactions', 't3')).toBeDefined()
    vi.restoreAllMocks()
    expect((await remove(services)).finished).toBe(true)
    expect(state(services)).toEqual(await oneRun())
  })
})

describe('POST /delete: a purge cut off by a crash, then run again', () => {
  // Groups go in $id order: h1 (kept), h2, then me. h2's rows take three batches.
  const staging =
    (text: string, nth = 1) =>
    (services: Fakes) =>
      crashOnCall(
        services.db,
        'createOperations',
        (params) => JSON.stringify(params.operations).includes(text),
        nth,
      )
  const crashes: Array<[string, (services: Fakes) => void]> = [
    ['the archive', (services) => crashOnCall(services.teams, 'delete')],
    ['deleting the team', (services) => crashOnCall(services.files, 'getFile')],
    ['a file', (services) => crashOnCall(services.files, 'deleteFile', () => true, 2)],
    ['the files', staging('"tableId":"balances","rowId":"h2"')],
    ['a batch of rows', staging('aMany', 2)],
    ['two batches of rows', staging('aMany', 3)],
    ['the rows', staging('"rowId":"h2-p3"')],
    ['a member row', staging('"rowId":"h2-pKim"')],
    ['a placeholder', staging('"rowId":"h2-pLee"')],
    ['the placeholders', staging('"rowId":"h2-p1"')],
    ['a purged group', staging('"rowId":"me"')],
  ]

  it.each(crashes)(
    'leaves the same rows, files and teams after a crash after %s',
    async (_, crash) => {
      const services = world(200)
      crash(services)
      const crashed = await call(services)
      expect(crashed.status).toBe(500)
      // Only IDs and codes in the log line, never the error's message.
      expect(crashed.logs.join('\n')).not.toMatch(/Crashed|Sam|Kim|@/)
      vi.restoreAllMocks()
      expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
      expect(state(services)).toEqual(await oneRun(200))
    },
  )
})
