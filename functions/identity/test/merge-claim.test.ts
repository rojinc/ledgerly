import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishMerges } from '../src/run-merge'
import { account, BEFORE, beforeCommit, call, type Fakes, fakes, placeholderRow } from './harness'

// Sam (pSam, with an account) verifies a phone that Sammy (pP), a placeholder, holds: Sammy is
// merged into Sam. Alex (pX) is a housemate.
const CLAIMED_AT = '2026-10-10T00:00:00.000Z'
const SAM = {
  $id: 'pSam',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: CLAIMED_AT,
  mergedInto: null,
  deletedAt: null,
}
const SAMMY = { ...SAM, $id: 'pP', userId: null, displayName: 'Sammy', claimedAt: null }
const ALEX = { ...SAM, $id: 'pX', userId: 'u2', displayName: 'Alex' }
const PHONE = {
  $id: 'iPhone',
  key: 'phone:+61412345678',
  type: 'phone',
  personId: 'pP',
  verified: false,
}
const EMAIL = {
  $id: 'iEmail',
  key: 'email:sam@example.com',
  type: 'email',
  personId: 'pSam',
  verified: true,
  verifiedAt: CLAIMED_AT,
}

function transaction(id: string, groupId: string, input: object, totalCents = 0) {
  return {
    $id: id,
    groupId,
    kind: 'expense',
    status: 'posted',
    statementId: null,
    date: '2026-10-01',
    description: 'Groceries',
    totalCents,
    inputJson: JSON.stringify(input),
  }
}

function share(
  id: string,
  transactionId: string,
  groupId: string,
  personId: string,
  given: number,
  received: number,
) {
  return {
    $id: id,
    transactionId,
    groupId,
    personId,
    givenCents: given,
    receivedCents: received,
    date: '2026-10-01',
    kind: 'expense',
    category: null,
  }
}

function group(id: string) {
  return {
    $id: id,
    type: 'house',
    name: 'Flat',
    rev: 'r0',
    settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"days"}',
  }
}

/**
 * g1: Alex paid 90 for Sammy and Alex. g2: Sam and Sammy are both in (Sammy since earlier), and
 * Sam paid 60 for both. `more` adds rows to any table.
 */
function house(more: Record<string, object[]> = {}): Fakes {
  const services = fakes(
    {
      persons: [SAM, SAMMY, ALEX],
      identities: [EMAIL, PHONE, ...(more.identities ?? [])],
      groups: [
        group('g1'),
        group('g2'),
        { ...group('gMe'), type: 'personal', settingsJson: '{"type":"personal"}' },
        ...(more.groups ?? []),
      ],
      members: [
        placeholderRow('m1', 'g1', 'pP', BEFORE),
        placeholderRow('m2', 'g1', 'pX', BEFORE, { status: 'active', displayName: 'Alex' }),
        placeholderRow('m3', 'g2', 'pP', BEFORE, { joinedOn: '2026-08-01' }),
        placeholderRow('m4', 'g2', 'pSam', BEFORE, {
          status: 'active',
          displayName: 'Sam Lee',
          joinedOn: '2026-09-15',
        }),
        // Sam's personal group, which a placeholder is never in.
        placeholderRow('mMe', 'gMe', 'pSam', BEFORE, {
          status: 'active',
          role: 'admin',
          displayName: 'Sam Lee',
        }),
        ...(more.members ?? []),
      ],
      transactions: [
        transaction(
          't1',
          'g1',
          {
            payers: [{ personId: 'pX', cents: 9000 }],
            split: { mode: 'equal', personIds: ['pP', 'pX'] },
          },
          9000,
        ),
        transaction(
          't2',
          'g2',
          {
            payers: [{ personId: 'pSam', cents: 6000 }],
            split: { mode: 'equal', personIds: ['pP', 'pSam'] },
          },
          6000,
        ),
        ...(more.transactions ?? []),
      ],
      shares: [
        share('s1', 't1', 'g1', 'pX', 9000, 4500),
        share('s2', 't1', 'g1', 'pP', 0, 4500),
        share('s3', 't2', 'g2', 'pSam', 6000, 3000),
        share('s4', 't2', 'g2', 'pP', 0, 3000),
        ...(more.shares ?? []),
      ],
      // g1's weekly cleaning, shared by Sammy and Alex.
      schedules: [
        {
          $id: 'sc1',
          groupId: 'g1',
          kind: 'expense',
          description: 'Cleaning',
          templateJson: JSON.stringify({
            totalCents: 4000,
            payers: [{ personId: 'pX', cents: 4000 }],
            split: { mode: 'equal', personIds: ['pP', 'pX'] },
          }),
          rrule: 'FREQ=WEEKLY',
          startsOn: '2026-10-01',
          endsOn: null,
          exdates: null,
          skipPublicHolidays: false,
          autoPost: false,
          horizonDays: 56,
          generatedThrough: '2026-11-30',
          nextRunAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      statements: more.statements ?? [],
      items: more.items ?? [],
      // Alex reminded Sammy in g1, before Sam signed up.
      reminders: [
        {
          $id: 'rToSammy',
          groupId: 'g1',
          sentBy: 'pX',
          toPersonId: 'pP',
          channel: 'email',
          sentAt: BEFORE,
        },
        ...(more.reminders ?? []),
      ],
      activity: [
        // Alex added Sammy to g1 (#257: once merged, the feed names Sam).
        {
          $id: 'aAdded',
          $createdAt: BEFORE,
          at: BEFORE,
          groupId: 'g1',
          actorPersonId: 'pX',
          action: 'member.added',
          subjectPersonId: 'pP',
          summary: 'was added',
        },
        ...(more.activity ?? []),
      ],
    } as Parameters<typeof fakes>[0],
    { teams: { g1: ['u2'], g2: ['u1'], g3: ['u2'] } },
  )
  services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
  return services
}

async function claim(services: Fakes) {
  return call(services, 'POST', '/claim')
}

/** Each person's net in a group: Σ (given − received). */
function nets(services: Fakes, groupId: string) {
  const result: Record<string, number> = {}
  for (const row of services.db.rows('shares').filter((row) => row.groupId === groupId)) {
    const id = row.personId as string
    result[id] = (result[id] ?? 0) + (row.givenCents as number) - (row.receivedCents as number)
  }
  return result
}

/** Every row still naming Sammy, table by table. */
function namingSammy(services: Fakes) {
  const tables = [
    'identities',
    'members',
    'shares',
    'transactions',
    'schedules',
    'reminders',
    'activity',
  ] as const
  return Object.fromEntries(
    tables.map((table) => [
      table,
      services.db
        .rows(table)
        // `inputJson` and `templateJson` hold JSON of their own, so match the bare ID.
        .filter((row) => /\bpP\b/.test(JSON.stringify(row)))
        .map((row) => row.$id),
    ]),
  )
}

let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  // No personal data in logs: IDs and counts only.
  for (const args of [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]) {
    expect(String(args)).not.toMatch(/@|\d{6,}|Sam Lee|Sammy|Alex/)
  }
  vi.restoreAllMocks()
})

/**
 * The groups part done: Sammy's row is Sam's there, but something still names Sammy, which a
 * leave, a removal or an edit would count as someone else's.
 */
function partDone(services: Fakes) {
  return ['g1', 'g2'].filter(
    (groupId) =>
      !services.db
        .rows('members')
        .some((row) => row.groupId === groupId && row.personId === 'pP') &&
      ['shares', 'transactions', 'schedules', 'activity'].some((table) =>
        services.db
          .rows(table as 'shares')
          .some((row) => row.groupId === groupId && /\bpP\b/.test(JSON.stringify(row))),
      ),
  )
}

/** Runs the merges into Sam until the clock has been read `cutAt` times, then runs out. */
async function cutOffAt(services: Fakes, cutAt: number) {
  const start = Date.now()
  let reads = 0
  vi.spyOn(Date, 'now').mockImplementation(() => (++reads > cutAt ? start + 60_000 : start))
  await finishMerges(services, 'u1', 'pSam', start + 1000)
  vi.mocked(Date.now).mockRestore()
}

/** P's and Sam's member dates in these groups, as merge step 1 records them (#242 B2). */
function recorded(services: Fakes, groupIds: string[]): string {
  const dates = (personId: string, groupId: string) => {
    const row = services.db
      .rows('members')
      .find((member) => member.groupId === groupId && member.personId === personId)
    return row ? { joinedOn: row.joinedOn, leftOn: row.leftOn ?? null } : null
  }
  // Sammy had a row in each of them when step 1 ran, even one a test has since removed.
  const added = { joinedOn: '2026-01-01', leftOn: null }
  return JSON.stringify(
    groupIds.map((groupId) => ({
      groupId,
      from: dates('pP', groupId) ?? added,
      into: dates('pSam', groupId),
    })),
  )
}

/** The logProblem lines a spy saw, without `fn`. */
function events(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(([line]: unknown[]) => {
    const { fn: _fn, ...event } = JSON.parse(String(line)) as Record<string, unknown>
    return event
  })
}

/** The merges that stopped on an error: none, unless a test makes one. */
function stopped() {
  return events(warn).filter(({ event }) => event === 'merge_stopped')
}

describe('POST /claim, merging a placeholder', () => {
  it('moves Sammy’s rows, shares and inputs to Sam, with every group’s balances the same', async () => {
    const services = house()
    const reads = vi.spyOn(services.db, 'listRows')
    const before = { g1: nets(services, 'g1'), g2: nets(services, 'g2') }
    const { body } = await claim(services)
    // g2 isn't new to Sam, who was in it already.
    expect(body).toEqual({ ok: true, data: { linkedGroupIds: ['g1'] } })

    expect(nets(services, 'g1')).toEqual({ pX: before.g1.pX, pSam: before.g1.pP })
    // The feed names Sam on the row written when Alex added Sammy (#257); nothing else changed.
    expect(services.db.rows('activity').find((row) => row.$id === 'aAdded')).toMatchObject({
      subjectPersonId: 'pSam',
      actorPersonId: 'pX',
      action: 'member.added',
      summary: 'was added',
    })
    expect(nets(services, 'g2')).toEqual({ pSam: (before.g2.pSam ?? 0) + (before.g2.pP ?? 0) })
    // One share per person in t2 (I-5).
    expect(
      services.db
        .rows('shares')
        .filter((row) => row.transactionId === 't2')
        .map((row) => [row.personId, row.givenCents, row.receivedCents]),
    ).toEqual([['pSam', 6000, 6000]])
    const input = (id: string) =>
      JSON.parse(
        services.db.rows('transactions').find((row) => row.$id === id)?.inputJson as string,
      )
    expect(input('t1').split).toEqual({ mode: 'equal', personIds: ['pSam', 'pX'] })
    expect(input('t2').split).toEqual({
      mode: 'weights',
      weights: [{ personId: 'pSam', weight: 2 }],
    })

    // Sam's own row in g2 stays, joined since Sammy's earlier date; Sammy's g1 row is Sam's.
    expect(
      services.db
        .rows('members')
        .map((row) => [row.$id, row.groupId, row.personId, row.status, row.joinedOn]),
    ).toEqual([
      ['m1', 'g1', 'pSam', 'active', '2026-09-01'],
      ['m2', 'g1', 'pX', 'active', '2026-09-01'],
      ['m4', 'g2', 'pSam', 'active', '2026-08-01'],
      ['mMe', 'gMe', 'pSam', 'active', '2026-09-01'],
    ])
    expect(services.teams.members('g1')?.map((member) => member.userId)).toEqual(['u2', 'u1'])
    // The phone is Sam's now, verified; Sammy is kept, merged, and named nowhere else.
    expect(services.db.rows('identities').find((row) => row.$id === 'iPhone')).toMatchObject({
      personId: 'pSam',
      verified: true,
    })
    expect(services.db.rows('persons').find((row) => row.$id === 'pP')).toMatchObject({
      userId: null,
      mergedInto: 'pSam',
    })
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: [],
      shares: [],
      transactions: [],
      schedules: [],
      reminders: [],
      activity: [],
    })

    // The schedule names Sam now; Sam's personal group was never searched.
    expect(JSON.parse(services.db.rows('schedules')[0]?.templateJson as string).split).toEqual({
      mode: 'equal',
      personIds: ['pSam', 'pX'],
    })
    expect(
      reads.mock.calls.some(
        ([params]) =>
          ['transactions', 'schedules'].includes(params.tableId) &&
          JSON.stringify(params.queries).includes('gMe'),
      ),
    ).toBe(false)
    expect(stopped()).toEqual([])

    // Finished: the next claim leaves Sammy alone.
    const writes = vi.spyOn(services.db, 'createOperations')
    expect((await claim(services)).body).toEqual({ ok: true, data: { linkedGroupIds: [] } })
    expect(writes).not.toHaveBeenCalled()
  })

  it('moves only the key Sam verified: a key typed for Sammy is deleted as the merge starts', async () => {
    // Someone added Sammy by email too, an address Sam never verified (the #252 S1 attack).
    const typed = {
      $id: 'iTyped',
      key: 'email:sammy@example.com',
      type: 'email',
      personId: 'pP',
      verified: false,
    }
    const services = house({ identities: [typed] })
    await claim(services)
    expect(services.db.rows('identities').map((row) => [row.$id, row.personId])).toEqual([
      ['iEmail', 'pSam'],
      ['iPhone', 'pSam'],
    ])
    expect(stopped()).toEqual([])
  })

  it('looks in Sammy’s groups only, never Sam’s others', async () => {
    // g9 is Sam's own, with a transaction and a schedule of its own: Sammy was never in it.
    const services = house({
      groups: [group('g9')],
      members: [
        placeholderRow('m9', 'g9', 'pSam', BEFORE, { status: 'active', displayName: 'Sam Lee' }),
      ],
      transactions: [transaction('t9', 'g9', { payers: [{ personId: 'pSam', cents: 100 }] }, 100)],
    })
    const reads = vi.spyOn(services.db, 'listRows')
    await claim(services)
    expect(services.db.rows('persons').find((row) => row.$id === 'pP')?.mergeGroupIds).toEqual([
      'g1',
      'g2',
    ])
    expect(
      reads.mock.calls.some(
        ([params]) =>
          ['transactions', 'schedules'].includes(params.tableId) &&
          JSON.stringify(params.queries).includes('g9'),
      ),
    ).toBe(false)
    expect(stopped()).toEqual([])
  })

  it('leaves Sammy’s rows and shares in a group Sam left on their own, and still finishes', async () => {
    const services = house({
      groups: [group('g3')],
      members: [
        placeholderRow('m5', 'g3', 'pSam', BEFORE, {
          status: 'left',
          role: 'viewer',
          displayName: 'Sam Lee',
          leftOn: '2026-10-05',
        }),
        placeholderRow('m6', 'g3', 'pP', BEFORE),
      ],
      // Sammy keeps a reminder sent in a group Sam left on their own.
      reminders: [
        {
          $id: 'rKept',
          groupId: 'g3',
          sentBy: 'pX',
          toPersonId: 'pP',
          channel: 'email',
          sentAt: BEFORE,
        },
      ],
      transactions: [
        transaction('t3', 'g3', {
          payers: [{ personId: 'pX', cents: 1000 }],
          split: { mode: 'equal', personIds: ['pP'] },
        }),
      ],
      shares: [share('s5', 't3', 'g3', 'pX', 1000, 0), share('s6', 't3', 'g3', 'pP', 0, 1000)],
      activity: [
        {
          $id: 'a1',
          $createdAt: '2026-10-05T00:00:00.000Z',
          at: '2026-10-05T00:00:00.000Z',
          groupId: 'g3',
          actorPersonId: 'pSam',
          action: 'member.left',
          summary: 'Left',
        },
        // Sammy stays Sammy in a kept group, activity included (#257).
        {
          $id: 'aKept',
          $createdAt: BEFORE,
          at: BEFORE,
          groupId: 'g3',
          actorPersonId: 'pX',
          action: 'member.added',
          subjectPersonId: 'pP',
          summary: 'was added',
        },
      ],
    })
    expect((await claim(services)).body).toEqual({ ok: true, data: { linkedGroupIds: ['g1'] } })
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: ['m6'],
      shares: ['s6'],
      transactions: ['t3'],
      schedules: [],
      reminders: ['rKept'],
      activity: ['aKept'],
    })
    expect(services.teams.members('g3')?.map((member) => member.userId)).toEqual(['u2'])
    expect(nets(services, 'g3')).toEqual({ pX: 1000, pP: -1000 })
  })

  it('puts off a group being finalized, keeps the merge open, and a later claim finishes it', async () => {
    const services = house({
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-10-01' }],
    })
    await claim(services)
    // g2 is done. g1 waits whole, Sammy's member row included, and so does the phone.
    expect(namingSammy(services)).toEqual({
      identities: ['iPhone'],
      members: ['m1'],
      shares: ['s2'],
      transactions: ['t1'],
      schedules: ['sc1'],
      reminders: [],
      activity: ['aAdded'],
    })
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'statements',
        rowId: 'st1',
        data: { status: 'final' },
      }),
    )
    await claim(services)
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: [],
      shares: [],
      transactions: [],
      schedules: [],
      reminders: [],
      activity: [],
    })
    expect(nets(services, 'g1')).toEqual({ pX: 4500, pSam: -4500 })
  })

  // #334: an account deletion purging a group deletes its team first and its rows last.
  it('puts off a group a purge is deleting, merges the others, and finishes once its rows go', async () => {
    const services = house()
    const add = services.teams.createMembership.bind(services.teams)
    vi.spyOn(services.teams, 'createMembership').mockImplementation(async (params) => {
      if (params.teamId === 'g1')
        throw new AppwriteException('Team not found', 404, 'team_not_found')
      return (await add(params)) as never
    })
    expect((await claim(services)).body).toEqual({ ok: true, data: { linkedGroupIds: [] } })
    expect(stopped()).toEqual([])
    // g2 is done. g1 waits whole, and so does the phone.
    expect(namingSammy(services)).toEqual({
      identities: ['iPhone'],
      members: ['m1'],
      shares: ['s2'],
      transactions: ['t1'],
      schedules: ['sc1'],
      reminders: [],
      activity: ['aAdded'],
    })
    // The purge reaches g1's rows.
    await withTransaction(services.db, (tx) =>
      tx.write(
        ...(
          [
            ['members', 'm1'],
            ['members', 'm2'],
            ['shares', 's1'],
            ['shares', 's2'],
            ['transactions', 't1'],
            ['schedules', 'sc1'],
            ['reminders', 'rToSammy'],
            ['activity', 'aAdded'],
            // The group row goes last, while mergeGroupIds still lists it.
            ['groups', 'g1'],
          ] as const
        ).map(([tableId, rowId]) => ({ action: 'delete' as const, tableId, rowId })),
      ),
    )
    expect((await claim(services)).body).toEqual({ ok: true, data: { linkedGroupIds: [] } })
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: [],
      shares: [],
      transactions: [],
      schedules: [],
      reminders: [],
      activity: [],
    })
  })

  it('moves no share in a group whose inputs it put off, even once the finalize ends', async () => {
    // In g2, Alex is in too, and Sam paid 90 split the default way: Sam, Sammy and Alex, 30 each.
    // After the merge, the default would give Sam and Alex 45 each, so the split must be written
    // out (Sam counting twice), and only Sammy's share shows that the row was theirs.
    const services = house({
      members: [
        placeholderRow('m6', 'g2', 'pX', BEFORE, { status: 'active', displayName: 'Alex' }),
      ],
      transactions: [
        transaction('t5', 'g2', { payers: [{ personId: 'pSam', cents: 9000 }] }, 9000),
      ],
      shares: [
        share('s5', 't5', 'g2', 'pSam', 9000, 3000),
        share('s6', 't5', 'g2', 'pP', 0, 3000),
        share('s7', 't5', 'g2', 'pX', 0, 3000),
      ],
      statements: [{ $id: 'st2', groupId: 'g2', status: 'draft', periodStart: '2026-10-01' }],
    })
    expect(nets(services, 'g2')).toEqual({ pSam: 9000, pP: -6000, pX: -3000 })
    // A finalize starts once Sammy's row in g2 is Sam's, just before g2's templates and inputs,
    // and ends as soon as g2's shares are looked for.
    const list = services.db.listRows.bind(services.db)
    const finalize = (status: string) =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'update', tableId: 'statements', rowId: 'st2', data: { status } }),
      )
    let ended = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const queries = (params.queries ?? []).join()
      const inG2 = queries.includes('"attribute":"groupId","values":["g2"]')
      if (params.tableId === 'schedules' && inG2) await finalize('finalizing')
      if (params.tableId === 'shares' && inG2 && queries.includes('"personId"') && !ended) {
        ended = true
        await finalize('final')
      }
      return list(params)
    })
    await claim(services)
    // g2's shares wait with its inputs, unread: Sammy's is still there for the next claim to see.
    expect(ended).toBe(false)
    expect(services.db.rows('shares').find((row) => row.$id === 's6')?.personId).toBe('pP')
    vi.mocked(services.db.listRows).mockRestore()
    await finalize('final')
    await claim(services)
    expect(namingSammy(services).shares).toEqual([])
    expect(
      JSON.parse(
        services.db.rows('transactions').find((row) => row.$id === 't5')?.inputJson as string,
      ).split,
    ).toEqual({
      mode: 'weights',
      weights: [
        { personId: 'pSam', weight: 2 },
        { personId: 'pX', weight: 1 },
      ],
    })
    // Sammy's part is Sam's now, and Alex's is the same.
    expect(nets(services, 'g2')).toEqual({ pSam: 3000, pX: -3000 })
  })

  it('keeps the merge open while only an unposted input waits on a finalizing group', async () => {
    // g3 has nothing of Sammy's but a scheduled bill naming them, so no share waits there.
    const services = house({
      groups: [group('g3')],
      members: [placeholderRow('m5', 'g3', 'pP', BEFORE)],
      transactions: [
        {
          ...transaction('t3', 'g3', { split: { mode: 'equal', personIds: ['pP', 'pX'] } }),
          status: 'scheduled',
        },
      ],
      statements: [{ $id: 'st1', groupId: 'g3', status: 'finalizing', periodStart: '2026-10-01' }],
    })
    await claim(services)
    expect(namingSammy(services)).toEqual({
      identities: ['iPhone'],
      members: ['m5'],
      shares: [],
      transactions: ['t3'],
      schedules: [],
      reminders: [],
      activity: [],
    })
  })

  // Cut off after every step and batch in turn: each read of the clock is one place it can stop.
  // A whole merge of this house reads it 26 times, so the 26th run isn't cut at all.
  it.each(Array.from({ length: 26 }, (_, n) => n + 1))(
    'carries on a merge cut off at clock read %i, and adds nothing twice',
    async (cutAt) => {
      const services = house()
      // Marked as a claim would, with P's groups; then time runs out partway through.
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'persons',
          rowId: 'pP',
          data: {
            mergedInto: 'pSam',
            mergeGroupIds: ['g1', 'g2'],
            mergeMembersJson: recorded(services, ['g1', 'g2']),
          },
        }),
      )
      const start = Date.now()
      let reads = 0
      vi.spyOn(Date, 'now').mockImplementation(() => (++reads > cutAt ? start + 60_000 : start))
      await finishMerges(services, 'u1', 'pSam', start + 1000)
      vi.mocked(Date.now).mockRestore()
      expect(partDone(services).length).toBeLessThanOrEqual(1)

      await claim(services)
      expect(namingSammy(services)).toEqual({
        identities: [],
        members: [],
        shares: [],
        transactions: [],
        schedules: [],
        reminders: [],
        activity: [],
      })
      expect(nets(services, 'g1')).toEqual({ pX: 4500, pSam: -4500 })
      expect(nets(services, 'g2')).toEqual({ pSam: 0 })
      expect(services.db.rows('shares').filter((row) => row.transactionId === 't2')).toHaveLength(1)
    },
  )

  it('moves no share of Sammy’s where neither of them has a row, and keeps the merge open', async () => {
    // In g3, Sammy's row became Sam's in an earlier claim, and an admin then removed it, while
    // Sammy's share was still there.
    const services = house({
      groups: [group('g3')],
      transactions: [
        transaction(
          't9',
          'g3',
          {
            payers: [{ personId: 'pX', cents: 2000 }],
            split: { mode: 'equal', personIds: ['pP', 'pX'] },
          },
          2000,
        ),
      ],
      shares: [share('s9', 't9', 'g3', 'pX', 2000, 1000), share('s10', 't9', 'g3', 'pP', 0, 1000)],
      activity: [
        {
          $id: 'aG3',
          $createdAt: BEFORE,
          at: BEFORE,
          groupId: 'g3',
          actorPersonId: 'pX',
          action: 'member.added',
          subjectPersonId: 'pP',
          summary: 'was added',
        },
      ],
    })
    // Marked in that earlier claim, so g3 is one of Sammy's groups.
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'persons',
        rowId: 'pP',
        data: {
          mergedInto: 'pSam',
          mergeGroupIds: ['g1', 'g2', 'g3'],
          mergeMembersJson: recorded(services, ['g1', 'g2', 'g3']),
        },
      }),
    )
    await claim(services)
    // Sam has no row in g3, so Sammy's share stays there (I-3), logged by ID, and the phone
    // waits. The input stays on Sammy too (#347): renamed, it would name Sam in a group Sam
    // never joined.
    expect(services.db.rows('shares').find((row) => row.$id === 's10')?.personId).toBe('pP')
    expect(namingSammy(services)).toMatchObject({ identities: ['iPhone'], transactions: ['t9'] })
    expect(events(warn)).toContainEqual({
      event: 'merge_left_inputs',
      personId: 'pP',
      intoPersonId: 'pSam',
      groupId: 'g3',
    })
    // Sam isn't joined there, so the activity stays on Sammy too, logged by ID (#338).
    expect(services.db.rows('activity').find((row) => row.$id === 'aG3')?.subjectPersonId).toBe(
      'pP',
    )
    expect(events(warn)).toContainEqual({
      event: 'merge_left_stray_row',
      personId: 'pP',
      intoPersonId: 'pSam',
      groupId: 'g3',
      table: 'shares',
      rowId: 's10',
    })
    expect(events(warn)).toContainEqual({
      event: 'merge_left_subjects',
      personId: 'pP',
      intoPersonId: 'pSam',
      groupId: 'g3',
      count: 1,
    })
  })

  // #338: subjects move only where Sam is joined, so no row g3's team reads links Sammy's key to
  // Sam's account (D-016). They don't hold the merge open: with nothing else of Sammy's left in
  // g3, the merge finishes and the phone moves.
  // Sam left g3 on their own (their own member.left, the newest of theirs there), after step 1.
  const leftOnTheirOwn = {
    members: [
      placeholderRow('m9', 'g3', 'pSam', BEFORE, {
        status: 'left',
        role: 'viewer',
        displayName: 'Sam Lee',
        leftOn: '2026-10-05',
      }),
    ],
    activity: [
      {
        $id: 'aSamLeft',
        $createdAt: '2026-10-05T00:00:00.000Z',
        at: '2026-10-05T00:00:00.000Z',
        groupId: 'g3',
        actorPersonId: 'pSam',
        action: 'member.left',
        subjectPersonId: 'pSam',
        summary: 'left',
      },
    ],
  }
  it.each([
    ['no row', { members: [], activity: [] }],
    [
      'only a placeholder row',
      { members: [placeholderRow('m9', 'g3', 'pSam', BEFORE)], activity: [] },
    ],
    ['a row they left on their own', leftOnTheirOwn],
  ])(
    'leaves Sammy’s activity and inputs in a group where Sam has %s, and still finishes',
    async (_, more) => {
      const services = house({
        groups: [group('g3')],
        members: more.members,
        // Posted, with Sammy at 0 basis points, so Sammy has no share in it (#347).
        transactions: [
          transaction(
            'tG3',
            'g3',
            {
              payers: [{ personId: 'pX', cents: 2000 }],
              split: {
                mode: 'percent',
                percents: [
                  { personId: 'pX', basisPoints: 10000 },
                  { personId: 'pP', basisPoints: 0 },
                ],
              },
            },
            2000,
          ),
        ],
        shares: [share('sG3', 'tG3', 'g3', 'pX', 2000, 2000)],
        activity: [
          ...more.activity,
          {
            $id: 'aG3',
            $createdAt: BEFORE,
            at: BEFORE,
            groupId: 'g3',
            actorPersonId: 'pX',
            action: 'member.added',
            subjectPersonId: 'pP',
            summary: 'was added',
          },
        ],
      })
      // And a schedule in g3 that names Sammy.
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'create',
          tableId: 'schedules',
          rowId: 'scG3',
          data: {
            groupId: 'g3',
            kind: 'expense',
            description: 'Internet',
            createdBy: 'pX',
            templateJson: JSON.stringify({
              totalCents: 3000,
              payers: [{ personId: 'pX', cents: 3000 }],
              split: { mode: 'equal', personIds: ['pP', 'pX'] },
            }),
            rrule: 'FREQ=MONTHLY',
            startsOn: '2026-10-01',
            endsOn: null,
            exdates: null,
            skipPublicHolidays: false,
            autoPost: false,
            horizonDays: 56,
            generatedThrough: '2026-11-30',
            nextRunAt: '2026-11-01T00:00:00.000Z',
          },
        }),
      )
      // Sammy's row in g3 was removed after step 1 listed it. An earlier run, while Sam was still
      // joined there, scanned g3 and left tG3: a group where U isn't joined is done at once,
      // whatever its cursor says (#347).
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'persons',
          rowId: 'pP',
          data: {
            mergedInto: 'pSam',
            mergeGroupIds: ['g1', 'g2', 'g3'],
            mergeMembersJson: recorded(services, ['g1', 'g2', 'g3']),
            mergeCursorsJson: JSON.stringify([{ groupId: 'g3', after: 'tG3', left: ['tG3'] }]),
          },
        }),
      )
      await claim(services)
      expect(namingSammy(services)).toEqual({
        identities: [],
        members: [],
        shares: [],
        transactions: ['tG3'],
        schedules: ['scG3'],
        reminders: [],
        activity: ['aG3'],
      })
      expect(events(warn)).toContainEqual({
        event: 'merge_left_inputs',
        personId: 'pP',
        intoPersonId: 'pSam',
        groupId: 'g3',
      })
      expect(events(warn)).toContainEqual({
        event: 'merge_left_subjects',
        personId: 'pP',
        intoPersonId: 'pSam',
        groupId: 'g3',
        count: 1,
      })
      expect(events(log)).toContainEqual(expect.objectContaining({ event: 'merge_finished' }))
    },
  )

  // The self-review's race on #347: Sam's placeholder row in g3 becomes joined while the claim
  // is past g3's check. Nothing in g3 moves this run, shares included, so the next run renames
  // the input before it moves the shares, as everywhere else.
  it('moves nothing in a group where Sam joins after its check, and the next claim does it all', async () => {
    const services = house({
      groups: [group('g3')],
      members: [placeholderRow('m9', 'g3', 'pSam', BEFORE)],
      transactions: [
        transaction(
          't9',
          'g3',
          {
            payers: [{ personId: 'pX', cents: 3000 }],
            split: { mode: 'equal', personIds: ['pP', 'pSam', 'pX'] },
          },
          3000,
        ),
      ],
      shares: [
        share('s9', 't9', 'g3', 'pX', 3000, 1000),
        share('s10', 't9', 'g3', 'pP', 0, 1000),
        share('s11', 't9', 'g3', 'pSam', 0, 1000),
      ],
    })
    // Sammy's row in g3 was removed after step 1 listed it.
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'persons',
        rowId: 'pP',
        data: {
          mergedInto: 'pSam',
          mergeGroupIds: ['g1', 'g2', 'g3'],
          mergeMembersJson: recorded(services, ['g1', 'g2', 'g3']),
        },
      }),
    )
    // Sam's row in g3 is joined as soon as anything lists g3's shares.
    const list = services.db.listRows.bind(services.db)
    let joinedMeanwhile = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (
        !joinedMeanwhile &&
        params.tableId === 'shares' &&
        JSON.stringify(params.queries).includes('g3')
      ) {
        joinedMeanwhile = true
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'members',
            rowId: 'm9',
            data: { status: 'active' },
          }),
        )
      }
      return list(params)
    })
    await claim(services)
    expect(services.db.rows('shares').find((row) => row.$id === 's10')?.personId).toBe('pP')
    vi.mocked(services.db.listRows).mockRestore()
    // Sam is joined in g3 now (this claim joined Sam's own rows last).
    await claim(services)
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: [],
      shares: [],
      transactions: [],
      schedules: [],
      reminders: [],
      activity: [],
    })
    expect(nets(services, 'g3')).toEqual({ pX: 2000, pSam: -2000 })
  })

  // Two claims cut off in turn: the second finishes the group the first left part done before
  // it starts another, since both walk Sammy's groups in step 1's order.
  it.each(Array.from({ length: 25 }, (_, n) => n + 1))(
    'leaves at most one group part done after two claims, the first cut off at read %i',
    async (first) => {
      for (let second = 1; second <= 25; second += 1) {
        const services = house()
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'persons',
            rowId: 'pP',
            data: {
              mergedInto: 'pSam',
              mergeGroupIds: ['g1', 'g2'],
              mergeMembersJson: recorded(services, ['g1', 'g2']),
            },
          }),
        )
        await cutOffAt(services, first)
        await cutOffAt(services, second)
        expect(partDone(services).length).toBeLessThanOrEqual(1)
      }
    },
  )

  // AI A's F on #242: the first claim puts g1 off (a finalize) and is cut off in g2. The second,
  // once the finalize has ended, finishes g2 before it starts g1 again.
  it.each(Array.from({ length: 25 }, (_, n) => n + 1))(
    'leaves at most one group part done when the first claim put a group off and was cut off at read %i',
    async (first) => {
      for (let second = 1; second <= 25; second += 1) {
        const services = house({
          statements: [
            { $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-10-01' },
          ],
        })
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'persons',
            rowId: 'pP',
            data: {
              mergedInto: 'pSam',
              mergeGroupIds: ['g1', 'g2'],
              mergeMembersJson: recorded(services, ['g1', 'g2']),
            },
          }),
        )
        await cutOffAt(services, first)
        await withTransaction(services.db, (tx) =>
          tx.write({ action: 'delete', tableId: 'statements', rowId: 'st1' }),
        )
        await cutOffAt(services, second)
        expect(partDone(services).length).toBeLessThanOrEqual(1)
      }
    },
  )

  it('puts a group off whole when its templates wait, even if the finalize ends before its inputs', async () => {
    // A finalize in g1 starts once Sammy's row there has moved, and ends before g1's inputs.
    const services = house({
      statements: [{ $id: 'st1', groupId: 'g1', status: 'draft', periodStart: '2026-10-01' }],
    })
    const status = (value: string) =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'statements',
          rowId: 'st1',
          data: { status: value },
        }),
      )
    const list = services.db.listRows.bind(services.db)
    let phase = 0
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (phase === 0 && params.tableId === 'schedules') {
        phase = 1
        await status('finalizing')
      } else if (phase === 1 && params.tableId === 'transactions') {
        phase = 2
        await status('draft')
      }
      return list(params)
    })
    await claim(services)
    expect(phase).toBe(2)
    // g1's template and t1 both still name Sammy: g1 waits whole for the next claim.
    expect(namingSammy(services)).toMatchObject({
      schedules: ['sc1'],
      transactions: ['t1'],
      activity: ['aAdded'],
    })
  })

  it('keeps the merge open when a row of Sammy’s appears outside the groups it walked', async () => {
    const services = house({ groups: [group('g9')] })
    await services.teams.create({ teamId: 'g9', name: 'g9' })
    // An add that found Sammy before step 1 lands while the merge runs (#252 L2 not yet built).
    const { $id, $createdAt, ...row } = placeholderRow('m9', 'g9', 'pP', BEFORE)
    const list = services.db.listRows.bind(services.db)
    let added = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'reminders' && !added) {
        added = true
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'create',
            tableId: 'members',
            rowId: 'm9',
            data: row,
          }),
        )
      }
      return list(params)
    })
    await claim(services)
    expect(added).toBe(true)
    expect(namingSammy(services).identities).toEqual(['iPhone'])
    expect(events(warn)).toContainEqual({
      event: 'merge_left_stray_row',
      personId: 'pP',
      intoPersonId: 'pSam',
      groupId: 'g9',
      table: 'members',
      rowId: 'm9',
    })
    // The next claim walks Sammy's rows too, but step 1 recorded no dates for g9, so the group
    // waits whole (#301) and the merge stays open, logged.
    vi.mocked(services.db.listRows).mockRestore()
    await claim(services)
    expect(namingSammy(services).identities).toEqual(['iPhone'])
    expect(services.db.rows('members').find((member) => member.$id === 'm9')?.personId).toBe('pP')
    expect(events(error)).toContainEqual({
      event: 'merge_no_member_dates',
      personId: 'pP',
      groupId: 'g9',
    })
  })

  it('moves nothing in a group whose finalize ends just after step 2 put it off', async () => {
    const services = house({
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-10-01' }],
    })
    // The finalize ends as soon as step 2 has seen it.
    const list = services.db.listRows.bind(services.db)
    let ended = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const result = await list(params)
      if (params.tableId === 'statements' && !ended) {
        ended = true
        await withTransaction(services.db, (tx) =>
          tx.write({
            action: 'update',
            tableId: 'statements',
            rowId: 'st1',
            data: { status: 'final' },
          }),
        )
      }
      return result
    })
    await claim(services)
    expect(ended).toBe(true)
    // g1 waits whole for the next claim: Sammy's row, input, schedule and share.
    expect(namingSammy(services)).toMatchObject({
      members: ['m1'],
      shares: ['s2'],
      transactions: ['t1'],
      schedules: ['sc1'],
    })
  })

  it('keeps the merge open while a row naming Sammy can’t be read', async () => {
    const unreadable = { ...transaction('t8', 'g1', {}), inputJson: '{"payers":[{"personId":"pP"' }
    const services = house({ transactions: [unreadable] })
    await claim(services)
    expect(namingSammy(services)).toMatchObject({ identities: ['iPhone'], transactions: ['t8'] })
    expect(events(warn)).toContainEqual({
      event: 'merge_left_transaction',
      personId: 'pP',
      intoPersonId: 'pSam',
      transactionId: 't8',
    })
  })

  it('plans a days item as it was before the merge, with the dates step 1 recorded (B2)', async () => {
    // In g2, Alex paid a September bill of 76.00, one item split by days: Sammy was there all 30
    // days, Sam 16 (from the 15th), Alex 30. After the merge, Sam's row starts when Sammy's did.
    const services = house({
      members: [
        placeholderRow('m6', 'g2', 'pX', BEFORE, {
          status: 'active',
          displayName: 'Alex',
          joinedOn: '2026-08-01',
        }),
      ],
      transactions: [
        {
          ...transaction(
            't5',
            'g2',
            {
              payers: [{ personId: 'pX', cents: 7600 }],
              bill: { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
            },
            7600,
          ),
          kind: 'bill',
        },
      ],
      items: [
        {
          $id: 'i5',
          transactionId: 't5',
          position: 0,
          name: 'Power',
          quantity: 1,
          amountCents: 7600,
          category: null,
          splitJson: JSON.stringify({ mode: 'days', personIds: ['pP', 'pSam', 'pX'] }),
        },
      ],
      shares: [
        share('s5', 't5', 'g2', 'pX', 7600, 3000),
        share('s6', 't5', 'g2', 'pP', 0, 3000),
        share('s7', 't5', 'g2', 'pSam', 0, 1600),
      ],
    })
    await claim(services)
    expect(namingSammy(services).identities).toEqual([])
    // Written out from the parts as they were, so an edit keeps every net.
    expect(
      JSON.parse(services.db.rows('items').find((row) => row.$id === 'i5')?.splitJson as string),
    ).toEqual({
      mode: 'exact',
      amounts: [
        { personId: 'pSam', cents: 4600 },
        { personId: 'pX', cents: 3000 },
      ],
    })
  })

  it('puts every group off, and keeps the merge open, when the recorded dates can’t be read', async () => {
    // #301: step 3 never plans a posted row's items without step 1's dates.
    const services = house()
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'persons',
        rowId: 'pP',
        data: { mergedInto: 'pSam', mergeGroupIds: ['g1', 'g2'], mergeMembersJson: '{' },
      }),
    )
    await claim(services)
    // Nothing moved: Sammy keeps both rows, the shares and the key.
    expect(namingSammy(services)).toMatchObject({ identities: ['iPhone'], members: ['m1', 'm3'] })
    expect(events(error)).toContainEqual({ event: 'merge_member_dates_unreadable', personId: 'pP' })
    expect(events(error)).toContainEqual({
      event: 'merge_no_member_dates',
      personId: 'pP',
      groupId: 'g1',
    })
  })

  it('carries each group’s input scan on from its own resume point (#242 G)', async () => {
    const services = house()
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'persons',
        rowId: 'pP',
        data: {
          mergedInto: 'pSam',
          mergeGroupIds: ['g1', 'g2'],
          mergeMembersJson: recorded(services, ['g1', 'g2']),
          mergeCursorsJson: JSON.stringify([
            { groupId: 'g2', after: 't1', left: [] },
            { groupId: 'g1', after: 't0', left: [] },
          ]),
        },
      }),
    )
    const reads = vi.spyOn(services.db, 'listRows')
    await claim(services)
    const resumed = reads.mock.calls.flatMap(([params]) => {
      const queries = (params.queries ?? []).map(
        (query) => JSON.parse(query) as { method: string; attribute?: string; values: string[] },
      )
      const groupId = queries.find((query) => query.attribute === 'groupId')?.values[0]
      const after = queries.find((query) => query.method === 'greaterThan')?.values[0]
      return params.tableId === 'transactions' && after ? [[groupId, after]] : []
    })
    expect(resumed).toEqual([
      ['g1', 't0'],
      ['g2', 't1'],
    ])
    expect(namingSammy(services).identities).toEqual([])
  })

  it('keeps the merge open when step 1 recorded no dates for a group Sammy’s row has left', async () => {
    // An earlier claim's step 2 gave Sammy's g1 row to Sam; the record lists g2 only.
    const services = house()
    await withTransaction(services.db, (tx) =>
      tx.write(
        {
          action: 'update',
          tableId: 'members',
          rowId: 'm1',
          data: { personId: 'pSam', status: 'active' },
        },
        {
          action: 'update',
          tableId: 'persons',
          rowId: 'pP',
          data: {
            mergedInto: 'pSam',
            mergeGroupIds: ['g1', 'g2'],
            mergeMembersJson: recorded(services, ['g2']),
          },
        },
      ),
    )
    await claim(services)
    // g1's input and share wait; g2 is done.
    expect(namingSammy(services)).toMatchObject({
      identities: ['iPhone'],
      shares: ['s2'],
      transactions: ['t1'],
    })
    expect(events(error)).toContainEqual({
      event: 'merge_no_member_dates',
      personId: 'pP',
      groupId: 'g1',
    })
    expect(stopped()).toEqual([])
  })

  it('still logs the user in, and joins their own rows, when a merge stops on an error', async () => {
    const services = house({
      // A row Sam was added to before signing up: the claim joins it whatever the merge does.
      members: [placeholderRow('m9', 'g9', 'pSam', BEFORE, { displayName: 'Sam Lee' })],
      groups: [group('g9')],
    })
    services.teams = new (
      services.teams.constructor as new (
        seed: object,
      ) => typeof services.teams
    )({
      g1: ['u2'],
      g2: ['u1'],
      g9: [],
    })
    const read = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation((async (params) => {
      if (params.tableId === 'schedules') throw new Error('Appwrite is down')
      return read(params)
    }) as typeof services.db.listRows)
    const { status, body } = await claim(services)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { linkedGroupIds: expect.arrayContaining(['g9']) } })
    expect(stopped()).toEqual([{ event: 'merge_stopped', intoPersonId: 'pSam', cause: 'Error' }])
    // The next claim carries on with the merge.
    vi.mocked(services.db.listRows).mockRestore()
    warn.mockClear()
    await claim(services)
    expect(namingSammy(services).identities).toEqual([])
    expect(stopped()).toEqual([])
  })

  it('renames Sammy in a row a final statement locked, and changes nothing else on it (#263)', async () => {
    // g1's statement st1 is final and locks t1, so a void could unlock it later.
    const services = house({
      statements: [{ $id: 'st1', groupId: 'g1', status: 'final', periodStart: '2026-10-01' }],
    })
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'transactions',
        rowId: 't1',
        data: { statementId: 'st1' },
      }),
    )
    const before = services.db.rows('transactions').find((row) => row.$id === 't1')
    await claim(services)
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: [],
      shares: [],
      transactions: [],
      schedules: [],
      reminders: [],
      activity: [],
    })
    const after = services.db.rows('transactions').find((row) => row.$id === 't1')
    expect([after?.statementId, after?.status, after?.totalCents]).toEqual([
      'st1',
      before?.status,
      before?.totalCents,
    ])
    expect(nets(services, 'g1')).toEqual({ pX: 4500, pSam: -4500 })
  })

  it('stops a merge into an account being deleted, and joins it to nothing (#246)', async () => {
    const services = house()
    await withTransaction(services.db, (tx) =>
      tx.write(
        { action: 'update', tableId: 'persons', rowId: 'pP', data: { mergedInto: 'pSam' } },
        {
          action: 'update',
          tableId: 'persons',
          rowId: 'pSam',
          data: { deletedAt: '2026-10-18T00:00:00.000Z' },
        },
      ),
    )
    expect(await finishMerges(services, 'u1', 'pSam', Number.MAX_SAFE_INTEGER)).toEqual({
      joined: [],
      finished: [],
    })
    // Sammy's rows stay Sammy's, and Sam was taken out of g1's team again.
    expect(services.db.rows('members').find((row) => row.$id === 'm1')?.personId).toBe('pP')
    expect(services.teams.members('g1')?.map((member) => member.userId)).toEqual(['u2'])
    expect(events(log)).toContainEqual({
      event: 'merge_stopped_into_deleted',
      personId: 'pP',
      intoPersonId: 'pSam',
    })
  })

  it('stops every merge into an account being deleted, ones with only their identities left too', async () => {
    const services = house()
    // pA0 sorts before Sammy and pZ after; both have nothing left to move but an identity.
    const rest = (id: string) => ({
      userId: null,
      displayName: id,
      claimedAt: null,
      mergedInto: 'pSam',
      mergeGroupIds: [],
      deletedAt: null,
    })
    const key = (id: string) => ({
      action: 'create' as const,
      tableId: 'identities' as const,
      rowId: `i${id}`,
      data: { key: `email:${id.toLowerCase()}@x.test`, type: 'email', personId: id },
    })
    await withTransaction(services.db, (tx) =>
      tx.write(
        { action: 'create', tableId: 'persons', rowId: 'pA0', data: rest('pA0') },
        { action: 'create', tableId: 'persons', rowId: 'pZ', data: rest('pZ') },
        key('pA0'),
        key('pZ'),
        { action: 'update', tableId: 'persons', rowId: 'pP', data: { mergedInto: 'pSam' } },
        {
          action: 'update',
          tableId: 'persons',
          rowId: 'pSam',
          data: { deletedAt: '2026-10-18T00:00:00.000Z' },
        },
      ),
    )
    await finishMerges(services, 'u1', 'pSam', Number.MAX_SAFE_INTEGER)
    const owner = (id: string) =>
      services.db.rows('identities').find((row) => row.$id === id)?.personId
    expect([owner('ipA0'), owner('ipZ')]).toEqual(['pA0', 'pZ'])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('fails the step 2 write a deletion lands on, and takes back the team membership', async () => {
    const services = house()
    await withTransaction(services.db, (tx) =>
      tx.write({
        action: 'update',
        tableId: 'persons',
        rowId: 'pP',
        data: {
          mergedInto: 'pSam',
          mergeGroupIds: ['g1', 'g2'],
          mergeMembersJson: recorded(services, ['g1', 'g2']),
        },
      }),
    )
    // Deletion step 2 marks Sam just before the first member row's commit.
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'persons',
          rowId: 'pSam',
          data: { deletedAt: '2026-10-18T00:00:00.000Z', rev: 'rDeleted' },
        }),
      ),
    )
    await expect(
      finishMerges(services, 'u1', 'pSam', Number.MAX_SAFE_INTEGER),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(services.db.rows('members').filter((row) => row.personId === 'pP')).toHaveLength(2)
    // Tried again, the merge stops before it joins anything.
    expect(await finishMerges(services, 'u1', 'pSam', Number.MAX_SAFE_INTEGER)).toEqual({
      joined: [],
      finished: [],
    })
    expect(services.db.rows('members').filter((row) => row.personId === 'pP')).toHaveLength(2)
  })

  it('never carries on a merge of a person who has an account now, or was deleted', async () => {
    for (const change of [{ userId: 'u9' }, { deletedAt: '2026-10-18T00:00:00.000Z' }]) {
      const services = house({ persons: [] })
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'persons',
          rowId: 'pP',
          data: { mergedInto: 'pSam', ...change },
        }),
      )
      expect(await finishMerges(services, 'u1', 'pSam', Number.MAX_SAFE_INTEGER)).toEqual({
        joined: [],
        finished: [],
      })
      expect(namingSammy(services).members).toEqual(['m1', 'm3'])
    }
  })

  it('ends the same way when two claims run at once', async () => {
    const services = house()
    const answers = await Promise.all([claim(services), claim(services)])
    // One may be told to try again; the next claim finishes whatever is left.
    for (const { body } of answers) {
      if (!body.ok) expect(body.error.code).toBe('CONFLICT')
    }
    await claim(services)
    expect(nets(services, 'g1')).toEqual({ pX: 4500, pSam: -4500 })
    expect(nets(services, 'g2')).toEqual({ pSam: 0 })
    expect(services.db.rows('shares').filter((row) => row.transactionId === 't2')).toHaveLength(1)
    expect(namingSammy(services).identities).toEqual([])
  })
})
