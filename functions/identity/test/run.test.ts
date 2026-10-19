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
      groups: [GROUP],
      members: [placeholderRow('m1', 'g1', 'pP', BEFORE), ...(more.members ?? [])],
    } as Parameters<typeof fakes>[0],
    { teams: { g1: [] } },
  )
  // Sam's account has verified the phone the claim came through.
  services.users.get = async () => account({ phone: '+61412345678', phoneVerification: true })
  return services
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
      'identity: merges 1 unfinished, 1 finished, 0 skipped, 0 cut off',
    )
    // Finished: the next run finds nothing.
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
      const services = fakes(
        {
          persons: [{ ...SAM, ...into }, SAMMY],
          identities: [PHONE],
          groups: [GROUP],
          members: [placeholderRow('m1', 'g1', 'pP', BEFORE)],
        } as Parameters<typeof fakes>[0],
        { teams: { g1: [] } },
      )
      expect((await hourly(services)).body).toEqual({
        ok: true,
        data: { unfinished: 1, finished: 0, skipped: 1, cutOff: 0 },
      })
      expect(identity(services, 'iPhone')?.personId).toBe('pP')
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
    const start = Date.now()
    // Out of time once the merges are found.
    let reads = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (++reads > 3 ? start + 60_000 : start))
    expect((await hourly(services)).body).toEqual({
      ok: true,
      data: { unfinished: 1, finished: 0, skipped: 0, cutOff: 1 },
    })
    vi.mocked(Date.now).mockRestore()
    expect((await hourly(services)).body).toMatchObject({ ok: true, data: { finished: 1 } })
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

  it('goes on to the next U when one U’s merges stop on an error', async () => {
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
