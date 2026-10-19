import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { cleanUpInvites } from '../src/steps/invite-cleanup'
import { beforeCommit, call, type Fakes, fakes, NOW } from './harness'

// scheduling.md#step-5b-invite-clean-up
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

type InviteSeed = { $id: string; acceptedAt?: string | null; expiresAt?: string }

/** A sent invite, expiring in 14 days unless the seed says otherwise. */
function invite({ $id, acceptedAt = null, expiresAt = ago(-14 * DAY) }: InviteSeed) {
  return {
    $id,
    groupId: 'g1',
    memberId: 'mKim',
    identityKey: `email:${$id}@example.com`,
    tokenHash: $id.padEnd(64, '0'),
    channel: 'email',
    invitedBy: 'pAnn',
    sentAt: new Date(Date.parse(expiresAt) - 14 * DAY).toISOString(),
    expiresAt,
    acceptedAt,
  }
}

function old(count: number, prefix = 'old'): InviteSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    $id: `${prefix}${String(index).padStart(3, '0')}`,
    // Accepted before its link expired, and both long enough ago for either query to find it.
    acceptedAt: ago(40 * DAY),
    expiresAt: ago(31 * DAY),
  }))
}

function seeded(invites: InviteSeed[]): Fakes {
  return fakes({ invites: invites.map(invite) })
}

const ids = (services: Fakes) => services.db.rows('invites').map((row) => row.$id)

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('step 5b: invite clean-up', () => {
  it('deletes a row 30 days after it was accepted, or after it expired unaccepted', async () => {
    const services = seeded([
      { $id: 'accepted31', acceptedAt: ago(31 * DAY), expiresAt: ago(20 * DAY) },
      { $id: 'accepted30', acceptedAt: ago(30 * DAY), expiresAt: ago(25 * DAY) },
      { $id: 'accepted29', acceptedAt: ago(29 * DAY), expiresAt: ago(20 * DAY) },
      { $id: 'expired31', expiresAt: ago(31 * DAY) },
      { $id: 'expired30', expiresAt: ago(30 * DAY) },
      { $id: 'expired29', expiresAt: ago(29 * DAY) },
      { $id: 'open', expiresAt: ago(-3 * DAY) },
      { $id: 'acceptedToday', acceptedAt: ago(DAY), expiresAt: ago(-10 * DAY) },
    ])
    expect(await cleanUpInvites(services)).toEqual({ deleted: 4, skipped: 0, failed: 0 })
    expect(ids(services)).toEqual(['accepted29', 'expired29', 'open', 'acceptedToday'])
    expect(errors).not.toHaveBeenCalled()
  })

  it('deletes an accepted row whose link expired 30 days ago, by its acceptedAt', async () => {
    const services = seeded([{ $id: 'both', acceptedAt: ago(40 * DAY), expiresAt: ago(31 * DAY) }])
    expect(await cleanUpInvites(services)).toEqual({ deleted: 1, skipped: 0, failed: 0 })
    expect(ids(services)).toEqual([])
  })

  it('does nothing with no invites', async () => {
    const services = seeded([])
    const begin = vi.spyOn(services.db, 'createTransaction')
    expect(await cleanUpInvites(services)).toEqual({ deleted: 0, skipped: 0, failed: 0 })
    expect(begin).not.toHaveBeenCalled()
  })

  it('deletes in transactions of at most 90, across pages of 100', async () => {
    const services = seeded([
      ...old(150),
      ...old(50, 'exp').map(({ $id }) => ({ $id, expiresAt: ago(31 * DAY) })),
    ])
    const stage = vi.spyOn(services.db, 'createOperations')
    expect(await cleanUpInvites(services)).toEqual({ deleted: 200, skipped: 0, failed: 0 })
    expect(ids(services)).toEqual([])
    const sizes = stage.mock.calls.map(([params]) => params.operations?.length ?? 0)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(90)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(200)
  })

  it('stops when the run is out of time, and the next run deletes the rest', async () => {
    const services = seeded(old(150))
    let read = 0
    const list = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      read += 1
      return list(params)
    })
    // Out of time once the second page is read, before any of its rows.
    services.outOfTime = () => read >= 2
    // The first page's 100: a batch of 90, then the 10 left once time is up.
    expect(await cleanUpInvites(services)).toEqual({ deleted: 100, skipped: 0, failed: 0 })
    expect(ids(services)).toHaveLength(50)
    services.outOfTime = () => false
    expect(await cleanUpInvites(services)).toEqual({ deleted: 50, skipped: 0, failed: 0 })
    expect(ids(services)).toEqual([])
  })

  it.each([
    [59_999, 150],
    [60_000, 100],
  ])(
    'stops a minute after it starts, though the run has time left (page 2 read at %i ms: %i deleted)',
    async (at, deleted) => {
      const services = seeded(old(150))
      let clock = 0
      let read = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const list = services.db.listRows.bind(services.db)
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        read += 1
        if (read === 2) clock = at
        return list(params)
      })
      expect(await cleanUpInvites(services)).toEqual({ deleted, skipped: 0, failed: 0 })
    },
  )

  it('skips a batch that a purge or an account deletion beat, carries on, and the next run deletes the rest', async () => {
    const services = seeded(old(100))
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'delete', tableId: 'invites', rowId: 'old001' }),
      ),
    )
    // The first batch of 90 lost to the purge; the next 10 go. Each row is found once.
    expect(await cleanUpInvites(services)).toEqual({ deleted: 10, skipped: 90, failed: 0 })
    expect(ids(services)).toHaveLength(89)
    expect(errors).not.toHaveBeenCalled()
    expect(await cleanUpInvites(services)).toEqual({ deleted: 89, skipped: 0, failed: 0 })
    expect(ids(services)).toEqual([])
  })

  it('ends the step on any other failure, with one error line of the failed count and the error', async () => {
    const services = seeded([
      ...old(100),
      ...old(3, 'exp').map(({ $id }) => ({ $id, expiresAt: ago(31 * DAY) })),
    ])
    vi.spyOn(services.db, 'updateTransaction').mockRejectedValue(
      new AppwriteException('Server error', 500, 'general_unknown'),
    )
    // The first batch fails: no later batch, and no second query.
    expect(await cleanUpInvites(services)).toEqual({ deleted: 0, skipped: 0, failed: 90 })
    expect(ids(services)).toHaveLength(103)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      fn: 'unknown',
      event: 'invite_cleanup_failed',
      count: 90,
      cause: 'AppwriteException 500 general_unknown',
    })
  })

  it('ends the step when a query fails, and the run goes on to the nightly check', async () => {
    const services = seeded(old(3))
    const invites = vi.fn()
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId !== 'invites') return { total: 0, rows: [] }
      invites()
      throw new AppwriteException('Server error', 500, 'general_unknown')
    })
    const { body } = await call(services, 'POST', '/', { userId: null, scheduled: true })
    expect(body).toMatchObject({
      ok: true,
      // Step 6 still ran.
      data: { invites: { deleted: 0, skipped: 0, failed: 0 }, nightly: expect.any(Object) },
    })
    // The second query never ran, and the step wrote one line.
    expect(invites).toHaveBeenCalledTimes(1)
    const events = errors.mock.calls.map(([text]) => JSON.parse(String(text)).event)
    expect(events.filter((event) => event === 'invite_cleanup_failed')).toHaveLength(1)
  })
})
