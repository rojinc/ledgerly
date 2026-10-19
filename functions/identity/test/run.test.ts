import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { account, BEFORE, call, type Fakes, fakes, placeholderRow } from './harness'

// The hourly run (identity-and-invites.md#finishing-merges). Sammy (pP), a placeholder, was
// merged into Sam (pSam) by a claim that was cut off: Sammy's row in g1 and the phone wait.
const SAM = {
  $id: 'pSam',
  userId: 'u1',
  displayName: 'Sam Lee',
  claimedAt: '2026-10-10T00:00:00.000Z',
  mergedInto: null,
  deletedAt: null,
}
const SAMMY = {
  ...SAM,
  $id: 'pP',
  userId: null,
  displayName: 'Sammy',
  claimedAt: null,
  mergedInto: 'pSam',
  mergeGroupIds: ['g1'],
}
const PHONE = {
  $id: 'iPhone',
  key: 'phone:+61412345678',
  type: 'phone',
  personId: 'pP',
  verified: false,
}
const GROUP = {
  $id: 'g1',
  type: 'house',
  name: 'Flat',
  rev: 'r0',
  settingsJson: '{"type":"house","autoFinalize":false,"defaultBillSplit":"equal"}',
}

function seeded(more: Record<string, object[]> = {}): Fakes {
  const services = fakes(
    {
      persons: [SAM, SAMMY, ...(more.persons ?? [])],
      identities: [PHONE, ...(more.identities ?? [])],
      groups: [GROUP, ...(more.groups ?? [])],
      members: [placeholderRow('m1', 'g1', 'pP', BEFORE), ...(more.members ?? [])],
      statements: more.statements ?? [],
    } as Parameters<typeof fakes>[0],
    { teams: { g1: [], g2: [] } },
  )
  // Sam's account has verified the phone the claim came through.
  services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
  return services
}

/**
 * Sammy's twin pP2, also merged into Sam, whose group g2 has a statement being finalized: step 2
 * puts g2 off, so that merge can't finish this run whatever the time.
 */
const PUT_OFF = {
  persons: [{ ...SAMMY, $id: 'pP2', mergeGroupIds: ['g2'] }],
  identities: [
    { ...PHONE, $id: 'iP2', key: 'email:twin@example.com', type: 'email', personId: 'pP2' },
  ],
  groups: [{ ...GROUP, $id: 'g2' }],
  members: [placeholderRow('m2', 'g2', 'pP2', BEFORE)],
  statements: [{ $id: 'st1', groupId: 'g2', status: 'finalizing', periodStart: '2026-10-01' }],
}

/** Date.now() as `clock.now`, which a test moves past the run's budget when it likes. */
function stoppedClock() {
  const clock = { now: Date.now() }
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
  return {
    clock,
    outOfTime: () => {
      clock.now += 60_000
    },
  }
}

/** Runs `then` once, right after the first `listRows` of `tableId` returns. */
function afterFirstRead(services: Fakes, tableId: string, then: () => unknown) {
  const list = services.db.listRows.bind(services.db)
  let done = false
  vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
    const result = await list(params)
    if (!done && params.tableId === tableId) {
      done = true
      await then()
    }
    return result
  })
}

/** A scheduled run, as Appwrite sends it: no JWT, the `schedule` trigger. */
async function hourly(services: Fakes) {
  return call(services, 'POST', '/', undefined, null, 'schedule')
}

function identity(services: Fakes, id: string) {
  return services.db.rows('identities').find((row) => row.$id === id)
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
    expect(String(args)).not.toMatch(/@|\d{6,}|Sam Lee|Sammy/)
  }
  vi.restoreAllMocks()
})

describe('POST / (the hourly run)', () => {
  it('finishes a merge a claim left unfinished, and marks the moved key verified', async () => {
    const services = seeded()
    const { status, body } = await hourly(services)
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      data: { unfinished: 1, finished: 1, skipped: 0, cutOff: 0 },
    })
    expect(services.db.rows('members')[0]).toMatchObject({ personId: 'pSam', status: 'active' })
    expect(identity(services, 'iPhone')).toMatchObject({ personId: 'pSam', verified: true })
    expect(log).toHaveBeenCalledWith(
      'identity: merges 1 unfinished, 1 finished, 0 skipped, 0 cut off (mergedInto rows read: 1)',
    )
    // Finished: the next run finds nothing.
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 0, finished: 0, skipped: 0, cutOff: 0 },
    })
  })

  it('with no merged persons, reads nothing more and counts nothing', async () => {
    // Appwrite refuses an `equal` with no values, so the identities read must not run.
    const services = fakes({ persons: [SAM] } as Parameters<typeof fakes>[0])
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 0, finished: 0, skipped: 0, cutOff: 0 },
    })
  })

  it('is refused to a signed-in caller, and to a call without the schedule trigger', async () => {
    const services = seeded()
    expect((await call(services, 'POST', '/', undefined, 'u1', 'schedule')).body).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect((await call(services, 'POST', '/', undefined, null)).body).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    })
    expect(identity(services, 'iPhone')?.personId).toBe('pP')
  })

  it('skips a U being deleted, or with no account, and never starts a merge', async () => {
    for (const into of [{ deletedAt: '2026-10-18T00:00:00.000Z' }, { userId: null }]) {
      // Two merges into that U, both skipped.
      const twin = { ...SAMMY, $id: 'pP2', mergeGroupIds: [] }
      const services = fakes(
        {
          persons: [{ ...SAM, ...into }, SAMMY, twin],
          identities: [
            PHONE,
            { ...PHONE, $id: 'iP2', key: 'email:twin@x.test', type: 'email', personId: 'pP2' },
          ],
          groups: [GROUP],
          members: [placeholderRow('m1', 'g1', 'pP', BEFORE)],
        } as Parameters<typeof fakes>[0],
        { teams: { g1: [] } },
      )
      expect((await hourly(services)).body).toEqual({
        ok: true,
        data: { unfinished: 2, finished: 0, skipped: 2, cutOff: 0 },
      })
      expect(identity(services, 'iPhone')?.personId).toBe('pP')
      expect(identity(services, 'iP2')?.personId).toBe('pP2')
      expect(services.db.rows('members')[0]?.personId).toBe('pP')
    }
  })

  it('counts only merges with an identity left, through every page of both reads', async () => {
    // 150 finished merges into Sam (no identity left) around the unfinished one, and 120
    // identities on one other unfinished merge, so both reads take more than a page.
    const done = Array.from({ length: 150 }, (_, n) => ({
      ...SAMMY,
      $id: `pDone${String(n).padStart(3, '0')}`,
      mergeGroupIds: [],
    }))
    const many = { ...SAMMY, $id: 'pMany', mergeGroupIds: [] }
    const keys = Array.from({ length: 120 }, (_, n) => ({
      ...PHONE,
      $id: `iMany${String(n).padStart(3, '0')}`,
      key: `email:many${n}@example.com`,
      type: 'email',
      personId: 'pMany',
    }))
    const services = seeded({ persons: [...done, many], identities: keys })
    expect((await hourly(services)).body).toMatchObject({ ok: true, data: { unfinished: 2 } })
  })

  it('counts merges the budget cut off, and the next run carries them on', async () => {
    const services = seeded()
    const { outOfTime } = stoppedClock()
    // Out of time once the walk has found the merges.
    afterFirstRead(services, 'identities', outOfTime)
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 1, finished: 0, skipped: 0, cutOff: 1 },
    })
    expect(identity(services, 'iPhone')?.personId).toBe('pP')
    vi.mocked(Date.now).mockRestore()
    vi.mocked(services.db.listRows).mockRestore()
    expect((await hourly(services)).body).toMatchObject({ ok: true, data: { finished: 1 } })
  })

  it('stops the walk at the budget, and counts only the merges it found', async () => {
    // 101 unfinished merges into Sam, so the walk takes two pages of persons.
    const ids = Array.from({ length: 101 }, (_, n) => String(n).padStart(3, '0'))
    const services = seeded({
      persons: ids.map((n) => ({ ...SAMMY, $id: `pM${n}`, mergeGroupIds: [] })),
      identities: ids.map((n) => ({
        ...PHONE,
        $id: `iM${n}`,
        key: `email:m${n}@example.com`,
        type: 'email',
        personId: `pM${n}`,
      })),
    })
    const { outOfTime } = stoppedClock()
    afterFirstRead(services, 'persons', outOfTime)
    // The first page: pM000 to pM099 (pP sorts after them). The walk stops before the second.
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 100, finished: 0, skipped: 0, cutOff: 100 },
    })
    expect(log).toHaveBeenCalledWith(
      'identity: merges 100 unfinished, 0 finished, 0 skipped, 100 cut off (mergedInto rows read: 100)',
    )
  })

  it('doesn’t count a merge put off with time left as cut off, and waits to verify U’s keys', async () => {
    const services = seeded(PUT_OFF)
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 2, finished: 1, skipped: 0, cutOff: 0 },
    })
    // Sammy's merge finished and moved the phone, but Sam's other merge is still open.
    expect(identity(services, 'iPhone')).toMatchObject({ personId: 'pSam', verified: false })
    expect(identity(services, 'iP2')?.personId).toBe('pP2')
  })

  it('counts as cut off only the merges the budget stopped', async () => {
    const services = seeded({ ...PUT_OFF, statements: [] })
    const { outOfTime } = stoppedClock()
    // Out of time as soon as Sammy's merge has moved the phone, its last step.
    const commit = services.db.updateTransaction.bind(services.db)
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      const result = await commit(params)
      if (identity(services, 'iPhone')?.personId === 'pSam') outOfTime()
      return result
    })
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 2, finished: 1, skipped: 0, cutOff: 1 },
    })
  })

  it('leaves a merge marked during the run to the next run’s count', async () => {
    const services = seeded(PUT_OFF)
    // pNew is merged into Sam after the walk; this run's carry-on finishes it anyway.
    afterFirstRead(services, 'identities', () =>
      withTransaction(services.db, (tx) =>
        tx.write(
          {
            action: 'create',
            tableId: 'persons',
            rowId: 'pNew',
            data: { displayName: 'New', mergedInto: 'pSam', mergeGroupIds: [] },
          },
          {
            action: 'create',
            tableId: 'identities',
            rowId: 'iNew',
            data: { key: 'email:new@example.com', type: 'email', personId: 'pNew' },
          },
        ),
      ),
    )
    // The walk found Sammy's merge, which finished, and pP2's, put off; pNew's isn't counted.
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 2, finished: 1, skipped: 0, cutOff: 0 },
    })
    expect(identity(services, 'iNew')?.personId).toBe('pSam')
  })

  it('leaves out a P marked as merged that has an account, or was deleted', async () => {
    const services = seeded({
      persons: [
        { ...SAMMY, $id: 'pAcc', userId: 'u9' },
        { ...SAMMY, $id: 'pDel', deletedAt: '2026-10-18T00:00:00.000Z' },
      ],
      identities: [
        { ...PHONE, $id: 'iAcc', key: 'email:acc@example.com', type: 'email', personId: 'pAcc' },
        { ...PHONE, $id: 'iDel', key: 'email:del@example.com', type: 'email', personId: 'pDel' },
      ],
    })
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 1, finished: 1, skipped: 0, cutOff: 0 },
    })
    // So Sam's merges count as finished, and the moved phone is verified.
    expect(identity(services, 'iPhone')).toMatchObject({ personId: 'pSam', verified: true })
    expect(identity(services, 'iAcc')?.personId).toBe('pAcc')
  })

  it('never marks verified a key of U’s account that sits on someone else’s person', async () => {
    // Sam's verified email is a key of Pat, a placeholder nobody has merged.
    const services = seeded({
      persons: [{ ...SAMMY, $id: 'pPat', mergedInto: null, mergeGroupIds: [] }],
      identities: [
        { ...PHONE, $id: 'iPat', key: 'email:sam@example.com', type: 'email', personId: 'pPat' },
      ],
    })
    expect((await hourly(services)).body).toMatchObject({ ok: true, data: { finished: 1 } })
    expect(identity(services, 'iPat')).toMatchObject({ personId: 'pPat', verified: false })
    expect(services.db.rows('persons').find((row) => row.$id === 'pPat')?.mergedInto).toBeNull()
  })

  it('leaves the keys alone for a user who is gone or labelled deleted, and finishes anyway', async () => {
    for (const user of [
      async () => {
        throw new AppwriteException('User not found', 404, 'user_not_found')
      },
      async () => account({ phone: '+61412345678', phoneVerification: true, labels: ['deleted'] }),
    ]) {
      const services = seeded()
      services.users.get = user
      expect((await hourly(services)).body).toMatchObject({ ok: true, data: { finished: 1 } })
      expect(identity(services, 'iPhone')).toMatchObject({ personId: 'pSam', verified: false })
    }
    // Neither is an error.
    expect(warn).not.toHaveBeenCalled()
  })

  it('goes on to the next U when one U’s person row can’t be read', async () => {
    const ALEX = { ...SAM, $id: 'pAlex', userId: 'u2', displayName: 'Alex' }
    const ALEXS = { ...SAMMY, $id: 'pA2', mergedInto: 'pAlex', mergeGroupIds: [] }
    const services = seeded({
      persons: [ALEX, ALEXS],
      identities: [
        { ...PHONE, $id: 'iAlex', key: 'email:alex@example.com', type: 'email', personId: 'pA2' },
      ],
    })
    const get = services.db.getRow.bind(services.db)
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      if (params.tableId === 'persons' && params.rowId === 'pSam') {
        throw new AppwriteException('Server error', 500, 'general_unknown')
      }
      return get(params)
    })
    expect((await hourly(services)).body).toMatchObject({
      ok: true,
      data: { unfinished: 2, finished: 1 },
    })
    expect(warn).toHaveBeenCalledWith('identity: merges into pSam stopped: AppwriteException')
    expect(identity(services, 'iAlex')?.personId).toBe('pAlex')
    expect(identity(services, 'iPhone')?.personId).toBe('pP')
  })

  it('goes on to the next U when reading one U’s user fails', async () => {
    const ALEX = { ...SAM, $id: 'pAlex', userId: 'u2', displayName: 'Alex' }
    const ALEXS = { ...SAMMY, $id: 'pA2', mergedInto: 'pAlex', mergeGroupIds: [] }
    const services = seeded({
      persons: [ALEX, ALEXS],
      identities: [
        { ...PHONE, $id: 'iAlex', key: 'email:alex@example.com', type: 'email', personId: 'pA2' },
      ],
    })
    // Sam's user can't be read: a server error, not a 404.
    services.users.get = async ({ userId }) => {
      if (userId === 'u1') throw new AppwriteException('Server error', 500, 'general_unknown')
      return account({ $id: 'u2', email: 'alex@example.com' })
    }
    expect((await hourly(services)).body).toMatchObject({
      ok: true,
      data: { unfinished: 2, finished: 2 },
    })
    expect(warn).toHaveBeenCalledWith('identity: merges into pSam stopped: AppwriteException')
    expect(identity(services, 'iAlex')).toMatchObject({ personId: 'pAlex', verified: true })
  })
})
