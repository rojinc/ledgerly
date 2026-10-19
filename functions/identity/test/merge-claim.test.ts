import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishMerges } from '../src/run-merge'
import { account, BEFORE, call, type Fakes, fakes, placeholderRow } from './harness'

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

function transaction(id: string, groupId: string, input: object) {
  return {
    $id: id,
    groupId,
    kind: 'expense',
    status: 'posted',
    statementId: null,
    date: '2026-10-01',
    description: 'Groceries',
    totalCents: 0,
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
  return { $id: id, type: 'house', name: 'Flat', rev: 'r0' }
}

/**
 * g1: Alex paid 90 for Sammy and Alex. g2: Sam and Sammy are both in (Sammy since earlier), and
 * Sam paid 60 for both. `more` adds rows to any table.
 */
function house(more: Record<string, object[]> = {}): Fakes {
  const services = fakes(
    {
      persons: [SAM, SAMMY, ALEX],
      identities: [EMAIL, PHONE],
      groups: [
        group('g1'),
        group('g2'),
        { ...group('gMe'), type: 'personal' },
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
        transaction('t1', 'g1', {
          payers: [{ personId: 'pX', cents: 9000 }],
          split: { mode: 'equal', personIds: ['pP', 'pX'] },
        }),
        transaction('t2', 'g2', {
          payers: [{ personId: 'pSam', cents: 6000 }],
          split: { mode: 'equal', personIds: ['pP', 'pSam'] },
        }),
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
      activity: more.activity ?? [],
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
  const tables = ['identities', 'members', 'shares', 'transactions', 'schedules'] as const
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
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  // No personal data in logs: IDs and counts only.
  for (const args of [...log.mock.calls, ...warn.mock.calls]) {
    expect(String(args)).not.toMatch(/@|\d{6,}|Sam Lee|Sammy|Alex/)
  }
  vi.restoreAllMocks()
})

/** The merges that stopped on an error: none, unless a test makes one. */
function stopped() {
  return warn.mock.calls.filter(([line]: unknown[]) => /stopped/.test(String(line)))
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
      ],
    })
    expect((await claim(services)).body).toEqual({ ok: true, data: { linkedGroupIds: ['g1'] } })
    expect(namingSammy(services)).toEqual({
      identities: [],
      members: ['m6'],
      shares: ['s6'],
      transactions: ['t3'],
      schedules: [],
    })
    expect(services.teams.members('g3')?.map((member) => member.userId)).toEqual(['u2'])
    expect(nets(services, 'g3')).toEqual({ pX: 1000, pP: -1000 })
  })

  it('puts off a group being finalized, keeps the merge open, and a later claim finishes it', async () => {
    const services = house({
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-10-01' }],
    })
    await claim(services)
    // g2 is done; g1's shares, input and schedule wait, and so does the phone.
    expect(namingSammy(services)).toEqual({
      identities: ['iPhone'],
      members: [],
      shares: ['s2'],
      transactions: ['t1'],
      schedules: ['sc1'],
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
    })
    expect(nets(services, 'g1')).toEqual({ pX: 4500, pSam: -4500 })
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
      members: [],
      shares: [],
      transactions: ['t3'],
      schedules: [],
    })
  })

  // Cut off after every step and batch in turn: each read of the clock is one place it can stop.
  // A whole merge of this house reads it 9 times, so the 10th run isn't cut at all.
  it.each(Array.from({ length: 10 }, (_, n) => n + 1))(
    'carries on a merge cut off at clock read %i, and adds nothing twice',
    async (cutAt) => {
      const services = house()
      // Marked as a claim would; then time runs out partway through.
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'persons',
          rowId: 'pP',
          data: { mergedInto: 'pSam' },
        }),
      )
      const start = Date.now()
      let reads = 0
      vi.spyOn(Date, 'now').mockImplementation(() => (++reads > cutAt ? start + 60_000 : start))
      await finishMerges(services, 'u1', 'pSam', start + 1000)
      vi.mocked(Date.now).mockRestore()

      await claim(services)
      expect(namingSammy(services)).toEqual({
        identities: [],
        members: [],
        shares: [],
        transactions: [],
        schedules: [],
      })
      expect(nets(services, 'g1')).toEqual({ pX: 4500, pSam: -4500 })
      expect(nets(services, 'g2')).toEqual({ pSam: 0 })
      expect(services.db.rows('shares').filter((row) => row.transactionId === 't2')).toHaveLength(1)
    },
  )

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
    expect(stopped()).toEqual([['merge into pSam stopped: Error']])
    // The next claim carries on with the merge.
    vi.mocked(services.db.listRows).mockRestore()
    warn.mockClear()
    await claim(services)
    expect(namingSammy(services).identities).toEqual([])
    expect(stopped()).toEqual([])
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
        finished: 0,
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
