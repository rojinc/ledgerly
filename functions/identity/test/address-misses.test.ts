import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { AppError } from '@ledgerly/server/http/app-error'
import { AppwriteException } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countCheck } from '../src/address-misses'
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

// #274 (identity-and-invites.md#invites, step 2; #reminders, steps 3, 5 and 6.2): address checks
// typed for invites and reminders, counted together on the sender's persons row before they run,
// with the count of a new invite or reminder that's sent taken back. A reminder retry never takes
// its count back.

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
 * Sam can both invite and remind Alex. Jo holds jo@example.com. `sam` sets Sam's count columns.
 * Sam has a profile, so Sam can edit their own name (PATCH /profile writes persons.displayName).
 */
function fixture(
  sam: object = {},
  seed: Partial<Record<'persons' | 'members' | 'shares' | 'identities' | 'reminders', Row[]>> = {},
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
      identities: seed.identities ?? [
        identity('iAlex', 'email:alex@example.com', 'pAlex'),
        identity('iJo', 'email:jo@example.com', 'pJo'),
      ],
      reminders: seed.reminders ?? [],
      profiles: [
        {
          $id: 'u1',
          personId: 'pSam',
          timezone: 'Australia/Sydney',
          region: 'AU-NSW',
          currency: 'AUD',
          businessJson: null,
          invoicePrefix: 'INV-',
          lastInvoiceNumber: 7,
          summaryFrequency: 'none',
          nextSummaryAt: null,
        },
      ],
    },
    { teams: { g1: ['u1'] } },
  )
}

const RIGHT = 'alex@example.com'
const WRONG = 'stranger@example.com'
const guess = (n: number) => `guess${n}@example.com`

type Route = {
  name: string
  path: string
  body: (email: string, n?: number) => object
  wrongAddress: string
  tooMany: string
}

const INVITE: Route = {
  name: 'an invite',
  path: '/invites',
  body: (email) => ({ groupId: 'g1', memberId: 'm2', email }),
  wrongAddress: "This email address isn't one this person was added with.",
  tooMany: 'Too many invites have been sent. Try again later.',
}
const REMINDER: Route = {
  name: 'a reminder',
  path: '/reminders',
  // A new id each time, unless a test retries one.
  body: (email, n = 0) => ({ id: `r${n}`, groupId: 'g1', email }),
  wrongAddress: "That isn't an address this group has for them. Use one you added them with.",
  tooMany: 'Too many reminders. Try again in a few days.',
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

const CONFLICT = { status: 409, code: 'CONFLICT', message: TRY_AGAIN }

function expectNothingSent(services: Fakes) {
  expect(services.sendEmail).not.toHaveBeenCalled()
  expect(services.db.rows('invites')).toEqual([])
  expect(services.db.rows('reminders')).toEqual([])
  expect(services.db.rows('activity')).toEqual([])
}

/** The count `count` checks leave, in a window that started at `from`. */
const misses = (count: number, from = NOW.toISOString()) => ({
  addressMisses: count,
  addressMissesFrom: from,
})
const NO_MISSES = { addressMisses: undefined, addressMissesFrom: undefined }

/** How many addresses were looked up (identities read) from now on. */
function addressChecks(services: Fakes): () => number {
  const reads = vi.spyOn(services.db, 'listRows')
  return () => reads.mock.calls.filter(([params]) => params.tableId === 'identities').length
}

/** The `addressMisses` values staged on Sam's row from now on, in order. */
function countsStaged(services: Fakes): () => unknown[] {
  const staged = vi.spyOn(services.db, 'createOperations')
  return () =>
    staged.mock.calls
      .flatMap(([params]) => (params.operations ?? []) as { rowId: string; data?: Row }[])
      .filter(
        (operation) => operation.rowId === 'pSam' && operation.data?.addressMisses !== undefined,
      )
      .map((operation) => operation.data?.addressMisses)
}

/** Every commit fails with 409 after the first `passing` ones. */
function conflictsAfter(services: Fakes, passing: number) {
  const commit = services.db.updateTransaction.bind(services.db)
  let commits = 0
  return vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit && commits++ >= passing) {
      throw new AppwriteException('Conflict', 409, 'transaction_conflict')
    }
    return commit(params)
  })
}

/**
 * The sender floods their own row: a PATCH /profile (persons.displayName) commits just before
 * every commit of the request under test, so each of those fails with a 409.
 */
function flood(services: Fakes) {
  const commit = services.db.updateTransaction.bind(services.db)
  let edits = 0
  let editing = false
  return vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit && !editing) {
      editing = true
      try {
        await ok(services, 'PATCH', '/profile', { displayName: `Sam ${edits++}` })
      } finally {
        editing = false
      }
    }
    return commit(params)
  })
}

/** The code of each answer, or `ok`. */
function codes(answers: Awaited<ReturnType<typeof call>>[]): string[] {
  return answers.map(({ body }) => (body.ok ? 'ok' : body.error.code))
}

/**
 * `sendEmail` as Resend answers under an idempotency key it already holds (for 24 hours): the
 * same request again gets the first answer replayed, with no new delivery, and any other payload,
 * such as another `to`, is refused with `invalid_idempotent_request`. `used` maps each key already
 * sent under to its address (a reminder's content doesn't change in these tests). Returns the
 * emails delivered from now on.
 */
function resendHolding(services: Fakes, used: Record<string, string>): Email[] {
  const sentTo = new Map(Object.entries(used))
  const delivered: Email[] = []
  vi.mocked(services.sendEmail).mockImplementation(async (email) => {
    const key = email.idempotencyKey ?? ''
    const first = sentTo.get(key)
    if (first !== undefined && first !== email.to) {
      throw new EmailError(
        'Resend answered 409 invalid_idempotent_request',
        'invalid_idempotent_request',
        409,
      )
    }
    if (first === undefined) {
      sentTo.set(key, String(email.to))
      delivered.push(email)
    }
    return { id: `email-${key}` }
  })
  return delivered
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('address misses (#274)', () => {
  describe.each(ROUTES)('for %s', (_name, route) => {
    it('answers a wrong address as before, and keeps its count on the sender’s row only', async () => {
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

    it('counts a right address before its check and takes it back when it’s sent; a wrong one adds 1', async () => {
      const services = fixture(misses(3, ago(HOUR)))
      const staged = countsStaged(services)
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // +1 under the count's guard, then −1 with the send.
      expect(staged()).toEqual([4, 3])
      expect(missesOf(services)).toEqual(misses(3, ago(HOUR)))
      expect(await failure(services, 'POST', route.path, route.body(WRONG, 2))).toEqual(
        wrongAnswer(route),
      )
      expect(staged()).toEqual([4, 3, 4])
      expect(missesOf(services)).toEqual(misses(4, ago(HOUR)))
    })

    it('answers the 11th RATE_LIMITED, right or wrong, without checking the address or writing', async () => {
      const services = fixture()
      for (let n = 1; n <= 10; n++) {
        const { status, body } = await send(services, route, WRONG, n)
        expect({ status, ...(body.ok ? {} : body.error) }).toEqual(wrongAnswer(route))
      }
      expect(missesOf(services)).toEqual(misses(10))
      const before = sam(services)
      const checks = addressChecks(services)
      const transactions = vi.spyOn(services.db, 'createTransaction')
      for (const email of [WRONG, RIGHT]) {
        expect(await failure(services, 'POST', route.path, route.body(email, 11))).toEqual(
          limitAnswer(route),
        )
      }
      // The cheap check before counting: no identity is looked up, and nothing is staged.
      expect(checks()).toBe(0)
      expect(transactions).not.toHaveBeenCalled()
      expect(sam(services)).toEqual(before)
      expectNothingSent(services)
    })

    it('takes the count back in the send’s own commit, so no conflict after it leaves it up', async () => {
      const services = fixture(misses(3, ago(HOUR)))
      // The count and the send commit; any other commit would conflict.
      const commits = conflictsAfter(services, 2)
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(2)
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(missesOf(services)).toEqual(misses(3, ago(HOUR)))
    })

    it('starts a new window at 1 with a check exactly 24 hours after the last one started', async () => {
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

    it('lets a right address through once the window has ended, in a new window it leaves at 0', async () => {
      const services = fixture(misses(10, ago(24 * HOUR)))
      await ok(services, 'POST', route.path, route.body(RIGHT))
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // Its check started a new window at 1, and the send took that back.
      expect(missesOf(services)).toEqual(misses(0))
    })

    it('reads a row without the columns, or with nulls, as no count', async () => {
      for (const columns of [{}, { addressMisses: null, addressMissesFrom: null }]) {
        const services = fixture(columns)
        expect((await failure(services, 'POST', route.path, route.body(WRONG))).code).toBe(
          'VALIDATION_FAILED',
        )
        expect(missesOf(services)).toEqual(misses(1))
      }
    })

    it('takes back only its own count on a successful send, never earlier misses', async () => {
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

    it('takes its count back in its window, whatever else was counted there meanwhile', async () => {
      const services = fixture(misses(5, ago(HOUR)))
      // Another check commits in the same window after this one's count, before its send.
      const raced = beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"pAlex"'),
        () => failure(services, 'POST', route.path, route.body(WRONG, 2)),
      )
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(raced).toHaveBeenCalled()
      // 5, this one's +1, the other's +1, this one's −1.
      expect(missesOf(services)).toEqual(misses(6, ago(HOUR)))
    })

    it('never takes the count below 0', async () => {
      const services = fixture()
      // The count already at 0 when the send takes its 1 back (a reset, say).
      beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"pAlex"'),
        () => updateRow(services.db, 'persons', 'pSam', { addressMisses: 0 }),
      )
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(missesOf(services)).toEqual(misses(0))
    })

    it('knows its window as stored in another form, as Appwrite gives a datetime back', async () => {
      const services = fixture()
      beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"pAlex"'),
        () =>
          updateRow(services.db, 'persons', 'pSam', {
            addressMissesFrom: NOW.toISOString().replace('Z', '+00:00'),
          }),
      )
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(sam(services).addressMisses).toBe(0)
    })

    it('takes nothing back once another check has started a new window', async () => {
      // The window ends 1 ms after NOW: this request counts in it, and another, 1 ms later,
      // starts the next one before this one's send commits.
      const services = fixture(misses(5, ago(24 * HOUR - 1)))
      const later = { ...services, now: new Date(NOW.getTime() + 1) }
      let other: unknown
      const raced = beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"pAlex"'),
        async () => {
          other = await failure(later, 'POST', route.path, route.body(WRONG, 2))
        },
      )
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      expect(raced).toHaveBeenCalled()
      expect(other).toEqual(wrongAnswer(route))
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // The new window keeps the other's count.
      expect(missesOf(services)).toEqual(misses(1, later.now.toISOString()))
    })

    it('takes its count back from the window its rerun counted in, which a parallel check started', async () => {
      // The sender's window has ended, so this check starts a new one at NOW. Before it commits, a
      // parallel check commits one started 1 ms earlier, so this one reruns and counts in that.
      const services = fixture(misses(5, ago(25 * HOUR)))
      const parallel = new Date(NOW.getTime() - 1)
      const raced = beforeCommit(services.db, () =>
        countCheck(services.db, 'pSam', parallel, () => new AppError('RATE_LIMITED', 'Too many')),
      )
      await ok(services, 'POST', route.path, route.body(RIGHT, 1))
      const commits = raced.mock.calls.flatMap(([params], index) =>
        params.commit ? [raced.mock.settledResults[index]?.type] : [],
      )
      // This count (409), the parallel one, this count's rerun, then the send's commit.
      expect(commits).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // The parallel check's 1: this one's was taken back from the window it was counted in.
      expect(missesOf(services)).toEqual(misses(1, parallel.toISOString()))
    })

    describe('parallel requests', () => {
      it('counts a check committed just before the guard: at the limit, RATE_LIMITED', async () => {
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

      it('counts once more when another commits after the guard', async () => {
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
        // This request's first count fails (409), the other's commits, then this one's again.
        expect(commits).toEqual(['rejected', 'fulfilled', 'fulfilled'])
        expect(other).toEqual(wrongAnswer(route))
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      })

      it.each([WRONG, RIGHT])(
        'answers CONFLICT before any address is looked at when counting conflicts twice (%s)',
        async (email) => {
          const services = fixture(misses(3, ago(HOUR)))
          const before = sam(services)
          const checks = addressChecks(services)
          const commits = conflictsAfter(services, 0)
          expect(await failure(services, 'POST', route.path, route.body(email))).toEqual(CONFLICT)
          expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(2)
          expect(checks()).toBe(0)
          expect(sam(services)).toEqual(before)
          expectNothingSent(services)
        },
      )

      it('refuses a right address once the 10th miss commits before its count', async () => {
        const services = fixture(misses(9, ago(HOUR)))
        const checks = addressChecks(services)
        // After the cheap check read 9, before the count's guard.
        const raced = beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          () => failure(services, 'POST', route.path, route.body(WRONG, 2)),
        )
        expect(await failure(services, 'POST', route.path, route.body(RIGHT, 1))).toEqual(
          limitAnswer(route),
        )
        expect(raced).toHaveBeenCalled()
        // The other's check only.
        expect(checks()).toBe(1)
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
        expectNothingSent(services)
      })

      // S2: no second limit check after the guards; the count answers first.
      it('answers RATE_LIMITED, not as a wrong address, for a deleted target at the limit', async () => {
        const services = fixture(
          {},
          {
            persons: [{ ...SAM, ...misses(9, ago(HOUR)) }, { ...ALEX, deletedAt: ago(HOUR) }, JO],
          },
        )
        const checks = addressChecks(services)
        const raced = beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          () => failure(services, 'POST', route.path, route.body(WRONG, 2)),
        )
        expect(await failure(services, 'POST', route.path, route.body(RIGHT, 1))).toEqual(
          limitAnswer(route),
        )
        expect(raced).toHaveBeenCalled()
        expect(checks()).toBe(1)
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      })

      it('keeps the count of a sender whose deletion starts after it, answering UNAUTHENTICATED', async () => {
        const services = fixture()
        // After the count, before the send's guards.
        beforeStaging(
          services.db,
          (operations) => operations.includes('"rowId":"pAlex"'),
          () => updateRow(services.db, 'persons', 'pSam', { deletedAt: ago(1000) }),
        )
        expect(await failure(services, 'POST', route.path, route.body(RIGHT))).toEqual({
          status: 401,
          code: 'UNAUTHENTICATED',
          message: 'Log in to continue.',
        })
        expect(missesOf(services)).toEqual(misses(1))
        expectNothingSent(services)
      })

      it('never counts past the limit in a burst of 12 wrong addresses', async () => {
        const services = fixture(misses(9, ago(HOUR)))
        const answers = await Promise.all(
          Array.from({ length: 12 }, (_, n) => send(services, route, WRONG, n)),
        )
        const answered = codes(answers)
        // FakeDb runs them interleaved: one count commits, the rest conflict or meet the limit.
        expect(answered.filter((code) => code === 'VALIDATION_FAILED')).toEqual([
          'VALIDATION_FAILED',
        ])
        expect(answered).toContain('RATE_LIMITED')
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
        for (const code of answered) {
          expect(['VALIDATION_FAILED', 'RATE_LIMITED', 'CONFLICT']).toContain(code)
        }
      })

      // S3 and the burst from 0: then wrong guesses one by one until the limit answers.
      it.each([
        ['0, 12 wrong and 1 right', {}, 12],
        ['9, 3 wrong and 1 right', misses(9, NOW.toISOString()), 3],
      ])(
        'checks at most 10 unsent addresses in the window, from %s at once',
        async (_case, start, wrong) => {
          const services = fixture(start)
          const checks = addressChecks(services)
          const emails = [...Array.from({ length: wrong }, (_, n) => guess(n)), RIGHT]
          const answers = await Promise.all(
            emails.map((email, n) => send(services, route, email, n)),
          )
          for (let n = 0; n < 12; n++)
            answers.push(await send(services, route, guess(100 + n), 100 + n))
          for (const code of codes(answers)) {
            expect(['ok', 'VALIDATION_FAILED', 'RATE_LIMITED', 'CONFLICT']).toContain(code)
          }
          const sent = vi.mocked(services.sendEmail).mock.calls.length
          const before = (start as { addressMisses?: number }).addressMisses ?? 0
          // Every check took its count before it ran; only a sent one gave it back.
          expect(checks() - sent).toBe(10 - before)
          expect(missesOf(services)).toEqual(misses(10))
        },
      )
    })

    // A sender editing their own profile (or any write to their row) before every commit.
    describe('under a flood of the sender’s own profile edits', () => {
      it('answers CONFLICT for right and wrong addresses alike, checking none', async () => {
        const services = fixture()
        const checks = addressChecks(services)
        flood(services)
        for (const [n, email] of [guess(1), guess(2), WRONG, RIGHT].entries()) {
          expect(await failure(services, 'POST', route.path, route.body(email, n))).toEqual(
            CONFLICT,
          )
        }
        expect(checks()).toBe(0)
        expect(missesOf(services)).toEqual(NO_MISSES)
        expectNothingSent(services)
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

  it.each([
    [INVITE.name, INVITE, REMINDER],
    [REMINDER.name, REMINDER, INVITE],
  ])(
    'refuses %s whose count meets a 10th miss of the other route on its rerun',
    async (_name, route, other) => {
      const services = fixture(misses(9, ago(HOUR)))
      const raced = beforeCommit(services.db, () =>
        failure(services, 'POST', other.path, other.body(WRONG, 2)),
      )
      expect(await failure(services, 'POST', route.path, route.body(RIGHT, 1))).toEqual(
        limitAnswer(route),
      )
      expect(raced).toHaveBeenCalled()
      expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
      expectNothingSent(services)
    },
  )

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
      // Found by the address, then refused after the guards (6.2), keeping its count.
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
    ])('%s, for %s, as a wrong address', async (_case, route, email, make) => {
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

    it('a right address the reminder limits refuse after its check', async () => {
      const services = fixture(
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
      )
      expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT))).toEqual(
        limitAnswer(REMINDER),
      )
      expect(missesOf(services)).toEqual(misses(1))
    })

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
    ])('not %s, for %s: no address is checked', async (_case, route, body, make) => {
      const services = make()
      const before = sam(services)
      const checks = addressChecks(services)
      expect((await failure(services, 'POST', route.path, body)).message).not.toBe(
        route.wrongAddress,
      )
      expect(checks()).toBe(0)
      expect(sam(services)).toEqual(before)
    })
  })

  // A new reminder refused after its check keeps its count (AI C's review of 49741be): each
  // take-back is in step 7's commit and rolls back with it. A free CONFLICT here would say
  // "right address", which is #274's attack on the reminder route.
  describe('a new reminder refused after its check keeps its count', () => {
    it('loses step 7 to a parallel call with the same id: answers its time, keeps its count', async () => {
      const services = fixture()
      const raced = beforeCommit(
        services.db,
        () => ok(services, 'POST', '/reminders', REMINDER.body(RIGHT, 1)),
        2,
      )
      expect(await ok(services, 'POST', '/reminders', REMINDER.body(RIGHT, 1))).toHaveProperty(
        'sentAt',
      )
      expect(raced).toHaveBeenCalled()
      expect(services.db.rows('reminders')).toHaveLength(1)
      // The parallel call's count was taken back with its reminder; this one's stays.
      expect(missesOf(services)).toEqual(misses(1))
    })

    it('conflicts in step 7 with the sender’s own profile edit: CONFLICT, keeps its count', async () => {
      const services = fixture()
      beforeCommit(
        services.db,
        () => ok(services, 'PATCH', '/profile', { displayName: 'Sam 2' }),
        2,
      )
      expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT, 1))).toEqual(
        CONFLICT,
      )
      expect(missesOf(services)).toEqual(misses(1))
      expectNothingSent(services)
    })

    it('has a recipient marked mergedInto before the guards: CONFLICT, keeps its count', async () => {
      const services = fixture()
      beforeStaging(
        services.db,
        (operations) => operations.includes('"rowId":"pAlex"'),
        () => updateRow(services.db, 'persons', 'pAlex', { mergedInto: 'pJo' }),
      )
      expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT, 1))).toEqual(
        CONFLICT,
      )
      expect(missesOf(services)).toEqual(misses(1))
      expectNothingSent(services)
    })
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
    const retried = { ok: true, data: { sentAt: SENT_AT } }
    // r0 went to the right address under its key, which Resend still holds.
    const USED = { 'person-reminder-r0': RIGHT }

    it('sends again for the right address, counting it first and keeping the count', async () => {
      const services = fixture({}, { reminders: [stored] })
      const staged = countsStaged(services)
      expect(await retry(services, RIGHT)).toEqual({ sentAt: SENT_AT })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // +1 in a new window, and nothing taken back: a retry's send shows nothing was delivered.
      expect(staged()).toEqual([1])
      expect(missesOf(services)).toEqual(misses(1))
    })

    it.each([
      ['a wrong address', WRONG, [SAM, ALEX, JO]],
      ['a recipient whose deletion has started', RIGHT, [SAM, { ...ALEX, deletedAt: ago(1) }, JO]],
    ])(
      'keeps the count of %s, and still answers the stored time',
      async (_case, email, persons) => {
        const services = fixture({}, { persons, reminders: [stored] })
        expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        expect(services.sendEmail).not.toHaveBeenCalled()
        expect(missesOf(services)).toEqual(misses(1))
      },
    )

    it.each([RIGHT, WRONG])(
      'answers the stored time at the limit, checking no address and sending nothing (%s)',
      async (email) => {
        const services = fixture(misses(10, ago(HOUR)), { reminders: [stored] })
        const before = sam(services)
        const checks = addressChecks(services)
        const transactions = vi.spyOn(services.db, 'createTransaction')
        expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        // The cheap check before counting: no transaction, and no identity is looked up.
        expect(transactions).not.toHaveBeenCalled()
        expect(checks()).toBe(0)
        expect(services.sendEmail).not.toHaveBeenCalled()
        expect(sam(services)).toEqual(before)
      },
    )

    it.each([RIGHT, WRONG])(
      'answers the stored time when its count meets the limit reached meanwhile, checking no address (%s)',
      async (email) => {
        const services = fixture(misses(9, ago(HOUR)), { reminders: [stored] })
        const checks = addressChecks(services)
        beforeStaging(
          services.db,
          (operations) => operations.includes('"tableId":"persons"'),
          () => failure(services, 'POST', '/invites', INVITE.body(WRONG)),
        )
        expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        // The invite's check only.
        expect(checks()).toBe(1)
        expect(missesOf(services)).toEqual(misses(10, ago(HOUR)))
        expect(services.sendEmail).not.toHaveBeenCalled()
      },
    )

    // S1.
    it.each([RIGHT, WRONG])(
      'answers the stored time when counting conflicts twice, checking no address and sending nothing (%s)',
      async (email) => {
        const services = fixture(misses(3, ago(HOUR)), { reminders: [stored] })
        const before = sam(services)
        const checks = addressChecks(services)
        const commits = conflictsAfter(services, 0)
        expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(2)
        expect(checks()).toBe(0)
        expect(services.sendEmail).not.toHaveBeenCalled()
        expect(sam(services)).toEqual(before)
      },
    )

    it('answers INTERNAL, not the stored time, when counting fails for another reason', async () => {
      const services = fixture(misses(3, ago(HOUR)), { reminders: [stored] })
      const before = sam(services)
      const checks = addressChecks(services)
      // The count's commit: Appwrite fails, not with a conflict.
      vi.spyOn(services.db, 'updateTransaction').mockRejectedValueOnce(
        new AppwriteException('Server Error', 500, 'general_unknown'),
      )
      expect(await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT))).toEqual({
        status: 500,
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Try again.',
      })
      expect(checks()).toBe(0)
      expect(services.sendEmail).not.toHaveBeenCalled()
      expect(sam(services)).toEqual(before)
    })

    it('commits its count and nothing more, and still sends', async () => {
      const services = fixture(misses(3, ago(HOUR)), { reminders: [stored] })
      // The count commits; any other commit would conflict.
      const commits = conflictsAfter(services, 1)
      expect(await retry(services, RIGHT)).toEqual({ sentAt: SENT_AT })
      expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(1)
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(missesOf(services)).toEqual(misses(4, ago(HOUR)))
    })

    it('keeps its count in the window it was taken in, after another check starts a new one', async () => {
      // The window ends 1 ms after NOW: the retry counts in it, and another check, 1 ms later,
      // starts the next one before the retry's send.
      const services = fixture(misses(5, ago(24 * HOUR - 1)), { reminders: [stored] })
      const later = { ...services, now: new Date(NOW.getTime() + 1) }
      const staged = countsStaged(services)
      vi.mocked(services.sendEmail).mockImplementationOnce(async () => {
        await failure(later, 'POST', '/invites', INVITE.body(WRONG))
        return { id: 'email-1' }
      })
      expect(await retry(services, RIGHT)).toEqual({ sentAt: SENT_AT })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      // The retry's 6 stays in the window that ended; the new one holds only the other's 1.
      expect(staged()).toEqual([6, 1])
      expect(missesOf(services)).toEqual(misses(1, later.now.toISOString()))
    })

    it('keeps the count of a right address whose send meets a parallel one, as of a wrong one', async () => {
      const services = fixture(misses(3, ago(HOUR)), { reminders: [stored] })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(services.sendEmail).mockRejectedValueOnce(
        new EmailError('Resend 409', 'concurrent_idempotent_requests', 409),
      )
      expect((await failure(services, 'POST', '/reminders', REMINDER.body(RIGHT))).code).toBe(
        'INTERNAL',
      )
      expect(missesOf(services)).toEqual(misses(4, ago(HOUR)))
      expect(await retry(services, WRONG)).toEqual({ sentAt: SENT_AT })
      expect(missesOf(services)).toEqual(misses(5, ago(HOUR)))
    })

    // The self-review's repro: under r0's key, a retry to another of Alex's addresses delivers
    // nothing, so a take-back would only tell Sam, from their own row, that the guess was right.
    it('takes nothing back from a retry to another of the recipient’s addresses, so it tests no more of them', async () => {
      const alexKey = (id: string, key: string) => ({
        ...identity(id, key, 'pAlex'),
        verified: true,
        verifiedAt: ago(48 * HOUR),
      })
      const services = fixture(
        {},
        {
          persons: [{ ...SAM, ...misses(9, ago(HOUR)) }, { ...ALEX, userId: 'u2' }, JO],
          members: [member('m1', 'pSam', 'Sam'), member('m2', 'pAlex', 'Alex', { role: 'member' })],
          identities: [
            alexKey('iAlex', 'email:alex@example.com'),
            alexKey('iWork', 'email:alex.work@example.com'),
            alexKey('iHome', 'email:alex.home@example.com'),
            identity('iJo', 'email:jo@example.com', 'pJo'),
          ],
          reminders: [stored],
        },
      )
      const delivered = resendHolding(services, USED)
      const checks = addressChecks(services)
      const counts = []
      for (const email of ['alex.work@example.com', 'alex.home@example.com', 'guess@example.com']) {
        expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        counts.push(sam(services).addressMisses)
      }
      // 10 after the first, which kept its count; the second and third found the limit.
      expect(counts).toEqual([10, 10, 10])
      expect(checks()).toBe(1)
      // Resend refused the first's send, to another address under r0's key.
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
      expect(delivered).toEqual([])
    })

    it.each([
      ['its key has expired', [{ ...stored, sentAt: ago(23 * HOUR) }], undefined],
      ['nothing is owed', [stored], [share('pSam', 0, 0), share('pAlex', 0, 0)]],
    ])('checks no address when %s, so counts nothing', async (_case, reminders, shares) => {
      const services = fixture({}, { reminders, shares })
      const checks = addressChecks(services)
      expect(await retry(services, WRONG)).toEqual({ sentAt: reminders[0]?.sentAt })
      expect(checks()).toBe(0)
      expect(missesOf(services)).toEqual(NO_MISSES)
    })

    it.each([
      ['0, 12 wrong and the right one', {}, 12],
      ['9, 3 wrong and the right one', misses(9, NOW.toISOString()), 3],
    ])(
      'answers a burst of retries from %s with the stored time, checking at most 10 addresses',
      async (_case, start, wrong) => {
        const services = fixture(start, { reminders: [stored] })
        const delivered = resendHolding(services, USED)
        const checks = addressChecks(services)
        const emails = [...Array.from({ length: wrong }, (_, n) => guess(n)), RIGHT]
        const answers = await Promise.all(
          emails.map((email) => call(services, 'POST', '/reminders', REMINDER.body(email))),
        )
        for (let n = 0; n < 12; n++) {
          answers.push(await call(services, 'POST', '/reminders', REMINDER.body(guess(100 + n))))
        }
        // No CONFLICT to tell a wrong address by: the stored time, every time.
        for (const { body } of answers) expect(body).toEqual(retried)
        // Every address checked kept its count, right or wrong, so the window's 10 bound them;
        // from the 11th on, the stored time with no identity read.
        const before = (start as { addressMisses?: number }).addressMisses ?? 0
        expect(checks()).toBe(10 - before)
        expect(missesOf(services)).toEqual(misses(10))
        // Any retry to the right address that sent was replayed under r0's key: no new delivery.
        expect(delivered).toEqual([])
      },
    )

    it.each([RIGHT, WRONG])(
      'answers the stored time under a flood of the sender’s profile edits, checking no address and sending nothing (%s)',
      async (email) => {
        const services = fixture({}, { reminders: [stored] })
        const checks = addressChecks(services)
        flood(services)
        for (let n = 0; n < 3; n++)
          expect(await retry(services, email)).toEqual({ sentAt: SENT_AT })
        expect(checks()).toBe(0)
        expect(services.sendEmail).not.toHaveBeenCalled()
        expect(missesOf(services)).toEqual(NO_MISSES)
      },
    )
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
