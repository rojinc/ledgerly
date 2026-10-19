import type { Members } from '@ledgerly/core/generated/rows'
import type { DeleteAccountResult } from '@ledgerly/core/schemas/identity'
import { TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { describe, expect, it, vi } from 'vitest'
import { purge } from '../src/purge'
import { FORMER_MEMBER } from '../src/rows'
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
        posted('t3', 'h2', 9000, { receiptFileIds: ['r2', 'r3', 'r4', 'r5', 'r6', 'r7'] }),
        posted('t4', 'h2', 600, { statementId: 'st1' }),
        posted('t9', 'h1', 4000, { receiptFileIds: ['r9', 'r3', 'r5'] }),
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
      // r6 has none: attached before the ledger kept them.
      receiptFiles: [
        receipt('r1', ['t1']),
        receipt('r2', ['t3']),
        receipt('r3', ['t3', 't9']),
        receipt('r4', ['t3']),
        receipt('r5', ['t3', 't9']),
        receipt('r7', ['t3']),
        receipt('r9', ['t9']),
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
  // Attached in h1 and h2 at once (#43's accepted race), h2's permissions last.
  services.files.upload('receipts', 'r5', [team('h2')])
  services.files.upload('receipts', 'r6', [team('h2')])
  // Attached in h2 and h1 at once, h1's permissions last; h1's transaction has taken it off since.
  services.files.upload('receipts', 'r7', [team('h1')])
  services.files.upload('receipts', 'r9', [team('h1')])
  services.files.upload('statements', 'st1', [team('h2')])
  services.files.upload('statements', 'st2', [team('h2')])
  services.files.upload('statements', 'st9', [team('h1')])
  return services
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: key.split(':')[0], personId, verified: false, verifiedAt: null }
}

function receipt(fileId: string, transactionIds: string[]) {
  return { $id: fileId, transactionIds, detachedAt: null, deletingAt: null }
}

// Ten receipts, readable by exactly h2's team, each listed only by `transactionId`.
async function tenReceipts(services: Fakes, transactionId: string) {
  const fileIds = Array.from({ length: 10 }, (_, n) => `${transactionId}-f${n}`)
  await insert(
    services,
    'receiptFiles',
    fileIds.map((fileId) => receipt(fileId, [transactionId])),
  )
  for (const fileId of fileIds) services.files.upload('receipts', fileId, [team('h2')])
  return fileIds
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

// The writes each database transaction staged, as `tableId/rowId`, in the order they began.
function stagedByTransaction(services: Fakes): Map<string, string[]> {
  const staged = new Map<string, string[]>()
  const stage = services.db.createOperations.bind(services.db)
  vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
    const writes = params.operations as Array<{ tableId: string; rowId: string }>
    staged.set(params.transactionId, [
      ...(staged.get(params.transactionId) ?? []),
      ...writes.map(({ tableId, rowId }) => `${tableId}/${rowId}`),
    ])
    return stage(params)
  })
  return staged
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
    // Only files readable by exactly the purged group's team go, and a receipt only when its
    // receiptFiles row lists no other group's transaction.
    expect(services.files.ids().sort()).toEqual([
      'receipts/r3',
      'receipts/r4',
      'receipts/r5',
      'receipts/r6',
      'receipts/r7',
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
    const staged = stagedByTransaction(services)
    expect((await remove(services)).finished).toBe(true)
    expect(leftOf(services, PURGED)).toEqual([])
    const batches = [...staged.values()]
    expect(batches.every((writes) => writes.length <= 90)).toBe(true)
    const first = batches.findIndex((writes) => writes.includes('balances/h2'))
    expect(batches[first]?.slice(0, 2)).toEqual(['groups/h2', 'balances/h2'])
    // Every batch of a group's rows gives that group a fresh rev first, so a nightly check
    // reading meanwhile sees it (ledger.md#concurrency).
    const rows = batches.filter((writes) =>
      writes.some((write) => /^(balances|shares|items|transactions)\//.test(write)),
    )
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((writes) => writes[0]?.startsWith('groups/'))).toBe(true)
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
    // Member rows only once no share of the group is left (I-3).
    const writes = batches.flat()
    const lastShare = writes.findLastIndex((write) => /^shares\/(t3|t4|tBig\d)-/.test(write))
    expect(lastShare).toBeGreaterThan(-1)
    expect(writes.findIndex((write) => write.startsWith('members/h2-'))).toBeGreaterThan(lastShare)
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

  it('deletes a balances row a nightly check builds again just after the last transaction reads it', async () => {
    const services = world()
    // Its rebuild stages a guard write to the group row, then the row (nightly-check.ts).
    const rebuild = () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          { action: 'update', tableId: 'groups', rowId: 'h2', data: { rev: 'rebuilt' } },
          { action: 'upsert', tableId: 'balances', rowId: 'h2', data: { peopleJson: '[]' } },
        ),
      )
    // The purge reads balances/h2 twice: before the first batch, then in the last transaction.
    let reads = 0
    const getRow = services.db.getRow.bind(services.db)
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      try {
        return await getRow(params)
      } finally {
        if (params.tableId === 'balances' && params.rowId === 'h2' && ++reads === 2) {
          await rebuild()
        }
      }
    })
    // The group row's delete was staged before the read, so the rebuild fails this commit.
    expect((await remove(services)).finished).toBe(false)
    vi.restoreAllMocks()
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'balances', 'h2')).toBeUndefined()
    expect(leftOf(services, PURGED)).toEqual([])
  })

  it('leaves the row of someone else whose deletion purges the group too: both finish, and the group goes', async () => {
    const services = world()
    // Alex is being deleted too, and purges h3 just before Sam's last transaction there.
    await setRow(services, 'persons', 'p2', { deletedAt: DELETED_AT })
    let alex: unknown
    beforeStaging(
      services.db,
      (operations) => operations.includes('"rowId":"h3-p1"'),
      async () => {
        const own = rowOf(services, 'members', 'h3-p2') as unknown as Members
        alex = await purge(services, own).catch((error: unknown) => error)
      },
    )
    // Alex's purge deleted the group row first, so Sam's last transaction waits for a rerun.
    expect((await remove(services)).finished).toBe(false)
    expect(alex).toBe(true)
    vi.restoreAllMocks()
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'groups', 'h3')).toBeUndefined()
    expect(leftOf(services, ['h3'])).toEqual([])
  })

  it('deletes the rows of someone being deleted that their own deletion doesn’t come back to', async () => {
    const services = world()
    // Alex was added to h2 and never joined; Ray's deletion, still under way, kept h2 for them.
    await insert(services, 'members', [
      member('h2', 'p2', { role: 'member', status: 'placeholder' }),
    ])
    await setRow(services, 'members', 'h2-p3', { displayName: FORMER_MEMBER })
    await setRow(services, 'persons', 'p2', { deletedAt: DELETED_AT })
    await setRow(services, 'persons', 'p3', { deletedAt: DELETED_AT })
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'members', 'h2-p2')).toBeUndefined()
    expect(rowOf(services, 'members', 'h2-p3')).toBeUndefined()
    // Alex's own `left` row in h3 is left to Alex's purge of it.
    expect(leftOf(services, PURGED)).toEqual(['members/h3-p2'])
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
    // A finalize that started after step 1 checked (which refuses one they could finish).
    beforeStaging(
      services.db,
      (operations) => operations.includes('"deletedAt"'),
      () => insert(services, 'statements', [statement('st3', 'h2', 'finalizing')]),
    )
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

  it('deletes the group’s reminders with its rows, and keeps another group’s', async () => {
    const services = world()
    const reminder = (id: string, groupId: string) => ({
      $id: id,
      groupId,
      sentBy: 'p2',
      toPersonId: 'p3',
      channel: 'email',
      sentAt: DELETED_AT,
    })
    await insert(services, 'reminders', [reminder('rH2', 'h2'), reminder('rH1', 'h1')])
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(services.db.rows('reminders').map((row) => row.$id)).toEqual(['rH1'])
  })

  it('purges a group whose statement has been stuck finalizing for over an hour', async () => {
    const services = world()
    // A finalize that started after step 1 checked, and whose last write was 61 minutes ago.
    beforeStaging(
      services.db,
      (operations) => operations.includes('"deletedAt"'),
      async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW.getTime() - 61 * 60 * 1000)
        await insert(services, 'statements', [statement('st3', 'h2', 'finalizing')])
        vi.useRealTimers()
        // Step 7 uploaded its PDF, under the statement's ID, and stopped before `pdfFileId`.
        services.files.upload('statements', 'st3', [team('h2')])
      },
    )
    expect(await remove(services)).toEqual({ deletedAt: DELETED_AT, finished: true })
    expect(leftOf(services, PURGED)).toEqual([])
    expect(services.files.ids()).not.toContain('statements/st3')
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
      // Stopped after step 6, which clears `userId`: POST /delete no longer finds the person,
      // and the hourly job deletes the Appwrite user, the only step left (step 7).
      if (rowOf(services, 'persons', 'p1')?.userId === null) {
        const { users, ...rows } = state(services)
        const { users: _, ...endRows } = end
        expect(rows).toEqual(endRows)
        expect(users[0]).toMatchObject({ labels: ['deleted'], status: false })
        continue
      }
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

describe('POST /delete: a purged group’s receipts (#248)', () => {
  const detached = { transactionIds: null, detachedAt: DELETED_AT, deletingAt: null }

  it('deletes a receipt only its transactions list, and keeps its receiptFiles row, detached', async () => {
    const services = world()
    expect((await remove(services)).finished).toBe(true)
    expect(services.files.ids()).not.toContain('receipts/r1')
    expect(services.files.ids()).not.toContain('receipts/r2')
    // Taken off with its transaction; scheduler step 5 deletes the row later.
    expect(rowOf(services, 'receiptFiles', 'r1')).toMatchObject(detached)
    expect(rowOf(services, 'receiptFiles', 'r2')).toMatchObject(detached)
  })

  it('keeps a receipt another group’s transaction also lists, which then lists only that one', async () => {
    const services = world()
    expect((await remove(services)).finished).toBe(true)
    // Readable by exactly h2's team, but h1's t9 lists it too.
    expect(services.files.ids()).toContain('receipts/r5')
    expect(rowOf(services, 'receiptFiles', 'r5')).toMatchObject({
      transactionIds: ['t9'],
      detachedAt: null,
      deletingAt: null,
    })
    expect(rowOf(services, 'receiptFiles', 'r3')).toMatchObject({ transactionIds: ['t9'] })
  })

  it('keeps a receipt with no receiptFiles row, which may be listed elsewhere', async () => {
    const services = world()
    expect((await remove(services)).finished).toBe(true)
    expect(services.files.ids()).toContain('receipts/r6')
    // Taken off as the ledger takes off a file with no row: it gets one that lists nothing.
    expect(rowOf(services, 'receiptFiles', 'r6')).toMatchObject(detached)
  })

  it('keeps a receipt not readable by exactly the group’s team, though only its transactions list it', async () => {
    const services = world()
    expect((await remove(services)).finished).toBe(true)
    // More than h2's team can read r4; only h1's team can read r7.
    expect(services.files.ids()).toContain('receipts/r4')
    expect(services.files.ids()).toContain('receipts/r7')
    expect(rowOf(services, 'receiptFiles', 'r4')).toMatchObject(detached)
    expect(rowOf(services, 'receiptFiles', 'r7')).toMatchObject(detached)
  })

  it('stops before the next file once the time budget is used up, and a rerun finishes with the same rows', async () => {
    const withReceipts = async () => {
      const services = world()
      const ids = ['tMany0', 'tMany1']
      await insert(
        services,
        'transactions',
        ids.map((id) => posted(id, 'h2', 1000)),
      )
      for (const id of ids) {
        await setRow(services, 'transactions', id, {
          receiptFileIds: await tenReceipts(services, id),
        })
      }
      return services
    }
    const once = await withReceipts()
    expect((await remove(once)).finished).toBe(true)
    const services = await withReceipts()
    let deleted = 0
    const deleteFile = services.files.deleteFile.bind(services.files)
    vi.spyOn(services.files, 'deleteFile').mockImplementation(async (params) => {
      deleted += 1
      await deleteFile(params)
      return {}
    })
    // Used up once the fifth of h2's 21 deletable receipts is gone, all in its first 100.
    services.outOfTime = () => deleted >= 5
    expect((await remove(services)).finished).toBe(false)
    expect(deleted).toBe(5)
    expect(rowOf(services, 'transactions', 't3')).toBeDefined()
    services.outOfTime = () => false
    expect((await remove(services)).finished).toBe(true)
    expect(state(services)).toEqual(state(once))
  })

  it('reads the receipt rows 100 file IDs at a time, as Appwrite allows', async () => {
    const services = world()
    const ids = Array.from({ length: 12 }, (_, n) => `tMany${String(n).padStart(2, '0')}`)
    await insert(
      services,
      'transactions',
      ids.map((id) => posted(id, 'h2', 1000)),
    )
    const fileIds: string[] = []
    for (const id of ids) {
      const listed = await tenReceipts(services, id)
      await setRow(services, 'transactions', id, { receiptFileIds: listed })
      fileIds.push(...listed)
    }
    const listRows = vi.spyOn(services.db, 'listRows')
    expect((await remove(services)).finished).toBe(true)
    const sizes = listRows.mock.calls.flatMap(([params]) =>
      (params.queries ?? [])
        .map((query) => JSON.parse(query) as { method: string; attribute?: string; values: [] })
        .filter((query) => query.method === 'equal' && query.attribute === '$id')
        .map((query) => query.values.length),
    )
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100)
    // 125 of h2's receipts: every one of these went, and its row is detached.
    expect(services.files.ids().filter((id) => id.includes('tMany'))).toEqual([])
    for (const fileId of fileIds) {
      expect(rowOf(services, 'receiptFiles', fileId)).toMatchObject(detached)
    }
  })

  it('takes up to 10 receipts off with each transaction, within 90 writes with the guard', async () => {
    const services = world()
    const people = Array.from({ length: 15 }, (_, n) => `pWide${n}`)
    const ids = Array.from({ length: 6 }, (_, n) => `tWide${n}`)
    await insert(
      services,
      'transactions',
      ids.map((id) => posted(id, 'h2', 1500)),
    )
    const fileIds = new Map<string, string[]>()
    for (const id of ids) {
      fileIds.set(id, await tenReceipts(services, id))
      await setRow(services, 'transactions', id, { receiptFileIds: fileIds.get(id) })
      await insert(
        services,
        'shares',
        people.map((personId) => share(id, 'h2', personId, 100, 100)),
      )
    }
    // The largest a transaction can be: 15 people, 30 items and 10 receipts.
    await insert(
      services,
      'items',
      Array.from({ length: 30 }, (_, position) => item('tWide5', position, 50)),
    )
    const staged = stagedByTransaction(services)
    expect((await remove(services)).finished).toBe(true)
    const batches = [...staged.values()]
    expect(Math.max(...batches.map((writes) => writes.length))).toBeLessThanOrEqual(90)
    // Shares, items and receipt files have IDs `<transactionId>-…` here.
    for (const id of ids) {
      const holding = batches.filter((writes) =>
        writes.some((write) => write === `transactions/${id}` || write.includes(`/${id}-`)),
      )
      expect(holding).toHaveLength(1)
      expect(holding[0]?.[0]).toBe('groups/h2')
      expect(holding[0]).toEqual(
        expect.arrayContaining([
          `transactions/${id}`,
          ...people.map((personId) => `shares/${id}-${personId}`),
          ...(fileIds.get(id) ?? []).map((fileId) => `receiptFiles/${fileId}`),
        ]),
      )
    }
    expect(leftOf(services, PURGED)).toEqual([])
    for (const fileId of [...fileIds.values()].flat()) {
      expect(rowOf(services, 'receiptFiles', fileId)).toMatchObject(detached)
    }
  })

  it('leaves a group to the next run when a receipt row changes meanwhile, as by an attach elsewhere', async () => {
    const services = world()
    beforeStaging(
      services.db,
      (operations) => operations.includes('"tableId":"receiptFiles"'),
      () => setRow(services, 'receiptFiles', 'r5', { transactionIds: ['t3', 't9', 'tElsewhere'] }),
    )
    expect((await remove(services)).finished).toBe(false)
    expect(rowOf(services, 'transactions', 't3')).toBeDefined()
    vi.restoreAllMocks()
    expect((await remove(services)).finished).toBe(true)
    expect(rowOf(services, 'receiptFiles', 'r5')).toMatchObject({
      transactionIds: ['t9', 'tElsewhere'],
      detachedAt: null,
    })
    expect(leftOf(services, PURGED)).toEqual([])
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
    ['taking a batch’s receipts off', staging('"tableId":"receiptFiles"')],
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
