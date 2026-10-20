import { AppError } from '@ledgerly/server/http/app-error'
import { AppwriteException } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countingMisses } from '../src/address-misses'
import {
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  NOW,
  ok,
  TRY_AGAIN,
  updateRow,
} from './harness'

// #274 (identity-and-invites.md#invites, step 2; #reminders, steps 3, 5 and 6.2): wrong addresses
// typed for invites and reminders, counted together on the sender's persons row.

type Row = Record<string, unknown> & { $id: string }

const HOUR = 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const SAM = {
  $id: 'pSam',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: null,
  mergedInto: null,
  deletedAt: null,
  rev: null,
}
const ALEX = { ...SAM, $id: 'pAlex', userId: null, displayName: 'Alex' }
const JO = { ...SAM, $id: 'pJo', userId: 'u2', displayName: 'Jo' }

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: 'email', personId, verified: false, verifiedAt: null }
}

function member(id: string, personId: string, displayName: string, extra: object = {}) {
  return {
    $id: id,
    groupId: 'g1',
    personId,
    displayName,
    role: 'admin',
    status: 'active',
    joinedOn: '2026-09-01',
    leftOn: null,
    ...extra,
  }
}

function share(personId: string, givenCents: number, receivedCents: number) {
  return {
    $id: `s-${personId}`,
    transactionId: 't1',
    groupId: 'g1',
    personId,
    givenCents,
    receivedCents,
  }
}

/**
 * Pair g1: Sam (u1, an admin) and Alex, a placeholder at alex@example.com who owes Sam $50.00, so
 * Sam can both invite and remind Alex. Jo holds jo@example.com. `sam` sets Sam's miss columns.
 */
function fixture(
  sam: object = {},
  seed: Partial<Record<'persons' | 'members' | 'shares' | 'reminders', Row[]>> = {},
): Fakes {
  return fakes(
    {
      persons: seed.persons ?? [{ ...SAM, ...sam }, ALEX, JO],
      groups: [
        {
          $id: 'g1',
          type: 'pair',
          name: 'Alex',
          ownerPersonId: 'pSam',
          currency: 'AUD',
          timezone: 'Australia/Sydney',
          region: 'AU-NSW',
          statementCycle: 'none',
          cycleAnchor: null,
          nextCloseAt: null,
          settingsJson: '{}',
          archivedAt: null,
        },
      ],
      members: seed.members ?? [
        member('m1', 'pSam', 'Sam'),
        member('m2', 'pAlex', 'Alex', { status: 'placeholder', role: 'member' }),
      ],
      shares: seed.shares ?? [share('pSam', 5000, 0), share('pAlex', 0, 5000)],
      identities: [
        identity('iAlex', 'email:alex@example.com', 'pAlex'),
        identity('iJo', 'email:jo@example.com', 'pJo'),
      ],
      reminders: seed.reminders ?? [],
    },
    { teams: { g1: ['u1'] } },
  )
}

const RIGHT = 'alex@example.com'
const WRONG = 'stranger@example.com'

type Route = {
  name: string
  path: string
  body: (email: string, n?: number) => object
  wrongAddress: string
  tooMany: string
  /** The rows a send writes: nothing in them means nothing was sent. */
  table: 'invites' | 'reminders'
}

const INVITE: Route = {
  name: 'an invite',
  path: '/invites',
  body: (email) => ({ groupId: 'g1', memberId: 'm2', email }),
  wrongAddress: "This email address isn't one this person was added with.",
  tooMany: 'Too many invites have been sent. Try again later.',
  table: 'invites',
}
const REMINDER: Route = {
  name: 'a reminder',
  path: '/reminders',
  // A new id each time, unless a test retries one.
  body: (email, n = 0) => ({ id: `r${n}`, groupId: 'g1', email }),
  wrongAddress: "That isn't an address this group has for them. Use one you added them with.",
  tooMany: 'Too many reminders. Try again in a few days.',
  table: 'reminders',
}
const ROUTES = [
  [INVITE.name, INVITE],
  [REMINDER.name, REMINDER],
] as const

function send(services: Fakes, route: Route, email: string, n?: number) {
  return call(services, 'POST', route.path, route.body(email, n))
}

function sam(services: Fakes): Row {
  const row = services.db.rows('persons').find((person) => person.$id === 'pSam')
  if (!row) throw new Error('No row for Sam')
  return row
}

function missesOf(services: Fakes) {
  const { addressMisses, addressMissesFrom } = sam(services)
  return { addressMisses, addressMissesFrom }
}

function wrongAnswer(route: Route) {
  return { status: 400, code: 'VALIDATION_FAILED', message: route.wrongAddress }
}

function limitAnswer(route: Route) {
  return { status: 429, code: 'RATE_LIMITED', message: route.tooMany }
}

function expectNothingSent(services: Fakes) {
  expect(services.sendEmail).not.toHaveBeenCalled()
  expect(services.db.rows('invites')).toEqual([])
  expect(services.db.rows('reminders')).toEqual([])
  expect(services.db.rows('activity')).toEqual([])
}

/** The misses `count` wrong addresses leave, in a window that started at `from`. */
const misses = (count: number, from = NOW.toISOString()) => ({
  addressMisses: count,
  addressMissesFrom: from,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('address misses (#274)', () => {
  describe.each(ROUTES)('for %s', (_name, route) => {
    it('answers a wrong address as before, and records one miss on the sender’s row only', async () => {
      const services = fixture()
      const before = services.db.rows('persons')
      const { status, body } = await send(services, route, WRONG)
      expect({ status, ...(body.ok ? {} : body.error) }).toEqual(wrongAnswer(route))
      // A count, a time and a fresh rev: no address, target or route.
      const after = sam(services)
      expect(after.rev).toMatch(/^[a-z0-9]{20}$/)
      expect(after).toEqual({
        ...before[0],
        $updatedAt: after.$updatedAt,
        rev: after.rev,
        ...misses(1),
      })
      expect(services.db.rows('persons').slice(1)).toEqual(before.slice(1))
      expect(JSON.stringify(services.db.rows('persons'))).not.toMatch(/stranger|@/)
      expectNothingSent(services)
    })

    it('answers the 11th RATE_LIMITED, right or wrong, without checking the address or writing', async () => {
      const services = fixture()
      for (let n = 1; n <= 10; n++) {
        const { status, body } = await send(services, route, WRONG, n)
        expect({ status, ...(body.ok ? {} : body.error) }).toEqual(wrongAnswer(route))
      }
      expect(missesOf(services)).toEqual(misses(10))
      const before = sam(services)
      const reads = vi.spyOn(services.db, 'listRows')
      const transactions = vi.spyOn(services.db, 'createTransaction')
      for (const email of [WRONG, RIGHT]) {
        expect(await failure(services, 'POST', route.path, route.body(email, 11))).toEqual(
          limitAnswer(route),
        )
      }
      // Before the address check: no identity is looked up, and nothing is staged.
      const tables = reads.mock.calls.map(([params]) => params.tableId)
      expect(tables).not.toContain('identities')
      expect(transactions).not.toHaveBeenCalled()
      expect(sam(services)).toEqual(before)
      expectNothingSent(services)
    })

    it('starts a new window at 1 with a miss exactly 24 hours after the last one started', async () => {
      const services = fixture(misses(10, ago(24 * HOUR)))
      expect(await failure(services, 'POST', route.path, route.body(WRONG))).toEqual(
        wrongAnswer(route),
      )
      expect(missesOf(services)).toEqual(misses(1))
    })

    it('counts on in the window just before it ends, and refuses at the limit', async () => {
      const from = ago(24 * HOUR - 1)
      const services = fixture(misses(9, from))
      expect(await failure(services, 'POST', route.path, route.body(WRONG, 1))).toEqual(
        wrongAnswer(route),
      )
      expect(missesOf(services)).toEqual(misses(10, from))
      expect(await failure(services, 'POST', route.path, route.body(RIGHT, 2))).toEqual(
        limitAnswer(route),
      )
    })

    it('lets a right address through once the window has ended', async () => {
      const services = fixture(misses(10, ago(24 * HOUR)))
      await ok(services, 'POST', route.path, route.body(RIGHT))
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // A send doesn't touch the count.
      expect(missesOf(services)).toEqual(misses(10, ago(24 * HOUR)))
    })

    it('reads a row without the columns, or with nulls, as no misses', async () => {
      for (const columns of [{}, { addressMisses: null, addressMissesFrom: null }]) {
        const services = fixture(columns)
        expect((await failure(services, 'POST', route.path, route.body(WRONG))).code).toBe(
          'VALIDATION_FAILED',
        )
        expect(missesOf(services)).toEqual(misses(1))
      }
    })

    it('doesn’t reset the count on a successful send', async () => {
      const services = fixture(misses(9, ago(HOUR)))
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(missesOf(services)).toEqual(misses(9, ago(HOUR)))
      expect((await failure(services, 'POST', route.path, route.body(WRONG, 2))).code).toBe(
        'VALIDATION_FAILED',
      )
      expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      expect(await failure(services, 'POST', route.path, route.body(RIGHT, 3))).toEqual(
        limitAnswer(route),
      )
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
    })

    describe('parallel requests', () => {
      it('counts a miss committed just before the guard: at the limit, RATE_LIMITED', async () => {
        const services = fixture(misses(9, ago(HOUR)))
        let other: unknown
        const raced = beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          async () => {
            other = await failure(services, 'POST', route.path, route.body(WRONG, 2))
          },
        )
        expect(await failure(services, 'POST', route.path, route.body(WRONG, 1))).toEqual(
          limitAnswer(route),
        )
        expect(raced).toHaveBeenCalled()
        expect(other).toEqual(wrongAnswer(route))
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      })

      it('records a miss once more when another commits after the guard', async () => {
        const services = fixture(misses(8, ago(HOUR)))
        let other: unknown
        const raced = beforeCommit(services.db, async () => {
          other = await failure(services, 'POST', route.path, route.body(WRONG, 2))
        })
        expect(await failure(services, 'POST', route.path, route.body(WRONG, 1))).toEqual(
          wrongAnswer(route),
        )
        const commits = raced.mock.calls.flatMap(([params], index) =>
          params.commit ? [raced.mock.settledResults[index]?.type] : [],
        )
        // This request's first commit fails (409), the other's commits, then this one's again.
        expect(commits).toEqual(['rejected', 'fulfilled', 'fulfilled'])
        expect(other).toEqual(wrongAnswer(route))
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      })

      it('answers CONFLICT, writing nothing, when recording a miss conflicts twice', async () => {
        const services = fixture(misses(3, ago(HOUR)))
        const before = sam(services)
        const commit = services.db.updateTransaction.bind(services.db)
        const commits = vi
          .spyOn(services.db, 'updateTransaction')
          .mockImplementation(async (params) => {
            if (params.commit) throw new AppwriteException('Conflict', 409, 'transaction_conflict')
            return commit(params)
          })
        expect(await failure(services, 'POST', route.path, route.body(WRONG))).toEqual({
          status: 409,
          code: 'CONFLICT',
          message: TRY_AGAIN,
        })
        expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(2)
        expect(sam(services)).toEqual(before)
      })

      it('refuses a right address once the 10th miss commits before its guards', async () => {
        const services = fixture(misses(9, ago(HOUR)))
        // After the pre-check read 9, before the send path stages its guards.
        const raced = beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          () => failure(services, 'POST', route.path, route.body(WRONG, 2)),
        )
        expect(await failure(services, 'POST', route.path, route.body(RIGHT, 1))).toEqual(
          limitAnswer(route),
        )
        expect(raced).toHaveBeenCalled()
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
        expectNothingSent(services)
      })

      it('answers a deletion started meanwhile before the limit, after the guards', async () => {
        const services = fixture(misses(9, ago(HOUR)))
        beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          () =>
            updateRow(services.db, 'persons', 'pSam', { addressMisses: 10, deletedAt: ago(1000) }),
        )
        expect(await failure(services, 'POST', route.path, route.body(RIGHT))).toEqual({
          status: 401,
          code: 'UNAUTHENTICATED',
          message: 'Log in to continue.',
        })
        expectNothingSent(services)
      })

      it('never counts past the limit in a burst of 12 wrong addresses', async () => {
        const services = fixture(misses(9, ago(HOUR)))
        const answers = await Promise.all(
          Array.from({ length: 12 }, (_, n) => send(services, route, WRONG, n)),
        )
        const codes = answers.map(({ body }) => (body.ok ? 'ok' : body.error.code))
        // FakeDb runs them interleaved: the first commits, the rest conflict or meet the limit.
        expect(codes.filter((code) => code === 'VALIDATION_FAILED')).toEqual(['VALIDATION_FAILED'])
        expect(codes).toContain('RATE_LIMITED')
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
        for (const code of codes) {
          expect(['VALIDATION_FAILED', 'RATE_LIMITED', 'CONFLICT']).toContain(code)
        }
      })
    })
  })

  it('counts invites and reminders together, per sender', async () => {
    const services = fixture()
    for (let n = 0; n < 6; n++) await send(services, INVITE, WRONG)
    for (let n = 0; n < 4; n++) await send(services, REMINDER, WRONG, n)
    expect(missesOf(services)).toEqual(misses(10))
    expect(await failure(services, 'POST', '/invites', INVITE.body(RIGHT))).toEqual(
      limitAnswer(INVITE),
    )
    expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT, 9))).toEqual(
      limitAnswer(REMINDER),
    )
    expectNothingSent(services)
  })

  it('refuses an invite whose 10th miss commits after its guards, on the retry', async () => {
    const services = fixture(misses(9, ago(HOUR)))
    const raced = beforeCommit(services.db, () =>
      failure(services, 'POST', '/reminders', REMINDER.body(WRONG)),
    )
    expect(await failure(services, 'POST', '/invites', INVITE.body(RIGHT))).toEqual(
      limitAnswer(INVITE),
    )
    expect(raced).toHaveBeenCalled()
    expectNothingSent(services)
  })

  it('asks for a retry of a reminder whose 10th miss commits after its guards, then refuses it', async () => {
    const services = fixture(misses(9, ago(HOUR)))
    beforeCommit(services.db, () => failure(services, 'POST', '/invites', INVITE.body(WRONG)))
    expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: TRY_AGAIN,
    })
    // The app's retry, with the same id, meets the limit before the address check.
    expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT))).toEqual(
      limitAnswer(REMINDER),
    )
    expectNothingSent(services)
  })

  describe('what counts', () => {
    it.each([
      ['an address nobody has', INVITE, WRONG, fixture],
      ['someone else’s address', INVITE, 'jo@example.com', fixture],
      ['a wrong address', REMINDER, WRONG, fixture],
      ['someone else’s address', REMINDER, 'jo@example.com', fixture],
      [
        'no other member',
        REMINDER,
        RIGHT,
        () => fixture({}, { members: [member('m1', 'pSam', 'Sam')] }),
      ],
      // Found by the address, then refused after the guards (6.2), and counted on its own.
      [
        'a recipient whose deletion has started',
        REMINDER,
        RIGHT,
        () => fixture({}, { persons: [SAM, { ...ALEX, deletedAt: ago(HOUR) }, JO] }),
      ],
      // Invites step 3.1.
      [
        'a person whose deletion has started',
        INVITE,
        RIGHT,
        () => fixture({}, { persons: [SAM, { ...ALEX, deletedAt: ago(HOUR) }, JO] }),
      ],
    ])('%s, for %s', async (_case, route, email, make) => {
      const services = make()
      expect(await failure(services, 'POST', route.path, route.body(email))).toEqual(
        wrongAnswer(route),
      )
      expect(missesOf(services)).toEqual(misses(1))
      expectNothingSent(services)
    })

    it.each(ROUTES)(
      'a deletion that commits just before the guards, for %s',
      async (_name, route) => {
        const services = fixture()
        beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          () => updateRow(services.db, 'persons', 'pAlex', { deletedAt: ago(1000) }),
        )
        expect(await failure(services, 'POST', route.path, route.body(RIGHT))).toEqual(
          wrongAnswer(route),
        )
        expect(missesOf(services)).toEqual(misses(1))
        expectNothingSent(services)
      },
    )

    it.each([
      [
        'a member who isn’t in the group',
        INVITE,
        { groupId: 'g1', memberId: 'mNobody', email: WRONG },
        fixture,
      ],
      ['someone who has joined', INVITE, { groupId: 'g1', memberId: 'm1', email: WRONG }, fixture],
      [
        'nothing owed',
        REMINDER,
        REMINDER.body(WRONG),
        () => fixture({}, { shares: [share('pSam', 0, 0), share('pAlex', 0, 0)] }),
      ],
      [
        'the reminder limits',
        REMINDER,
        REMINDER.body(RIGHT),
        () =>
          fixture(
            {},
            {
              reminders: [
                {
                  $id: 'old',
                  groupId: 'g1',
                  sentBy: 'pSam',
                  toPersonId: 'pAlex',
                  channel: 'email',
                  sentAt: ago(HOUR),
                },
              ],
            },
          ),
      ],
    ])('not %s, for %s', async (_case, route, body, make) => {
      const services = make()
      const before = sam(services)
      expect((await failure(services, 'POST', route.path, body)).message).not.toBe(
        route.wrongAddress,
      )
      expect(sam(services)).toEqual(before)
    })
  })

  it('counts only the route’s wrong-address answer, not another with its code or message', async () => {
    const services = fixture()
    const misses = {
      db: services.db,
      senderId: 'pSam',
      now: NOW,
      wrongAddress: REMINDER.wrongAddress,
      tooMany: () => new AppError('RATE_LIMITED', REMINDER.tooMany),
    }
    for (const error of [
      new AppError('VALIDATION_FAILED', 'Nothing is owed to you in this group.'),
      new AppError('CONFLICT', REMINDER.wrongAddress),
    ]) {
      await expect(countingMisses(misses, () => Promise.reject(error))).rejects.toBe(error)
    }
    expect(await countingMisses(misses, async () => 'sent')).toBe('sent')
    expect(missesOf(services)).toEqual({ addressMisses: undefined, addressMissesFrom: undefined })
  })

  describe('a reminder retry with the same id (step 3)', () => {
    const SENT_AT = ago(HOUR)
    const stored = {
      $id: 'r0',
      groupId: 'g1',
      sentBy: 'pSam',
      toPersonId: 'pAlex',
      channel: 'email',
      sentAt: SENT_AT,
    }
    const retry = (services: Fakes, email: string) =>
      ok(services, 'POST', '/reminders', REMINDER.body(email))

    it('sends again for the right address, and counts nothing', async () => {
      const services = fixture({}, { reminders: [stored] })
      expect(await retry(services, RIGHT)).toEqual({ sentAt: SENT_AT })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(missesOf(services)).toEqual({ addressMisses: undefined, addressMissesFrom: undefined })
    })

    it.each([
      ['a wrong address', WRONG, [SAM, ALEX, JO]],
      ['a recipient whose deletion has started', RIGHT, [SAM, { ...ALEX, deletedAt: ago(1) }, JO]],
    ])('counts %s, and still answers the stored time', async (_case, email, persons) => {
      const services = fixture({}, { persons, reminders: [stored] })
      expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
      expect(services.sendEmail).not.toHaveBeenCalled()
      expect(missesOf(services)).toEqual(misses(1))
    })

    it.each([RIGHT, WRONG])(
      'answers the stored time at the limit, checking no address and sending nothing (%s)',
      async (email) => {
        const services = fixture(misses(10, ago(HOUR)), { reminders: [stored] })
        const before = sam(services)
        const reads = vi.spyOn(services.db, 'listRows')
        expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        expect(reads.mock.calls.map(([params]) => params.tableId)).not.toContain('identities')
        expect(services.sendEmail).not.toHaveBeenCalled()
        expect(sam(services)).toEqual(before)
      },
    )

    it('answers the stored time when its miss meets the limit reached meanwhile', async () => {
      const services = fixture(misses(9, ago(HOUR)), { reminders: [stored] })
      beforeStaging(
        services.db,
        (operations) => operations.includes('"tableId":"persons"'),
        () => failure(services, 'POST', '/invites', INVITE.body(WRONG)),
      )
      expect(await retry(services, WRONG)).toEqual({ sentAt: SENT_AT })
      expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      expect(services.sendEmail).not.toHaveBeenCalled()
    })

    it('checks no address once its key has expired, so counts nothing', async () => {
      const services = fixture({}, { reminders: [{ ...stored, sentAt: ago(23 * HOUR) }] })
      expect(await retry(services, WRONG)).toEqual({ sentAt: ago(23 * HOUR) })
      expect(missesOf(services)).toEqual({ addressMisses: undefined, addressMissesFrom: undefined })
    })
  })

  it('logs no address, and no answer repeats one', async () => {
    const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = CONSOLE.map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const services = fixture(misses(8, ago(HOUR)))
    const answers = []
    for (const [route, email, n] of [
      [INVITE, 'Stranger@Example.com', 0],
      [REMINDER, 'jo@example.com', 1],
      [INVITE, 'nobody@example.com', 2],
      [REMINDER, 'alex@example.com', 3],
    ] as const) {
      answers.push(await send(services, route, email, n))
    }
    expect(answers.map(({ status }) => status)).toEqual([400, 400, 429, 429])
    const output = [
      ...answers.flatMap(({ body, logs }) => [JSON.stringify(body), ...logs]),
      ...spies.flatMap((spy) => spy.mock.calls.map(String)),
    ].join('\n')
    expect(output).toContain('"route":"POST /invites"')
    expect(output).not.toMatch(/@|stranger|nobody|alex@|jo@/i)
  })
})
