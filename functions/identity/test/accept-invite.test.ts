import { createHash } from 'node:crypto'
import type { FakeDb } from '@ledgerly/server/appwrite/fake'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUser, Services } from '../src/services'
import {
  account,
  BEFORE,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  NOW,
  ok,
  placeholderRow,
  TRY_AGAIN,
} from './harness'

type Row = Record<string, unknown> & { $id: string }
type Accepted = { groupId: string } | { needsVerification: 'email' | 'phone' }

const DAY_MS = 86_400_000
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
// Sam signed up on 10 October; rows added on 15 October came after, so claim leaves them.
const CLAIMED_AT = '2026-10-10T00:00:00.000Z'
const ADDED = '2026-10-15T00:00:00.000Z'
// A second accept's clock, so the stored acceptedAt shows which accept wrote it.
const LATER = new Date(NOW.getTime() + 1000)

const INVALID = "This invite link isn't valid. It may have expired or been used already."

/** 32 bytes, base64url, like a real token; `n` tells them apart. */
const token = (n: number) => Buffer.alloc(32, n).toString('base64url')
const TOKEN = token(1)

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function person(id: string, userId: string | null, displayName: string): Row {
  return {
    $id: id,
    userId,
    displayName,
    claimedAt: userId ? CLAIMED_AT : null,
    mergedInto: null,
    deletedAt: null,
    rev: null,
  }
}

function identity(id: string, key: string, personId: string, verified = false): Row {
  const type = key.split(':')[0]
  return { $id: id, key, type, personId, verified, verifiedAt: verified ? CLAIMED_AT : null }
}

function group(id: string, extra: object = {}): Row {
  return {
    $id: id,
    type: 'house',
    name: 'Flat 2',
    ownerPersonId: 'pAnn',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: 'none',
    cycleAnchor: null,
    nextCloseAt: null,
    settingsJson: '{}',
    archivedAt: null,
    ...extra,
  }
}

/** An open invite from Ann to Sam's row in g1, sent yesterday, with `tokenText` as its token. */
function invite(id: string, tokenText: string, extra: object = {}): Row {
  return {
    $id: id,
    groupId: 'g1',
    memberId: 'mSam',
    identityKey: 'email:sam@example.com',
    tokenHash: sha256(tokenText),
    channel: 'email',
    invitedBy: 'pAnn',
    sentAt: at(-DAY_MS),
    expiresAt: at(13 * DAY_MS),
    acceptedAt: null,
    ...extra,
  }
}

const ANN = person('pAnn', 'u2', 'Ann Cho')
const SAM = person('pSam', 'u1', 'Sam Lee')
const KIM = person('pKim', null, 'Kim Ho')
const BEN = person('pBen', 'u3', 'Ben Ng')
const SAM_EMAIL = identity('iSam', 'email:sam@example.com', 'pSam', true)
const KIM_EMAIL = identity('iKim', 'email:kim@example.com', 'pKim')
const BEN_EMAIL = identity('iBen', 'email:ben@example.com', 'pBen', true)
const TO_KIM = { memberId: 'mKim', identityKey: 'email:kim@example.com' }
const SMS = { identityKey: 'phone:+61412345678', channel: 'sms' }

type Setup = {
  persons?: Row[]
  identities?: Row[]
  members?: Row[]
  invites?: Row[]
  activity?: Row[]
  statements?: Row[]
  account?: AccountUser
  teams?: Record<string, string[]>
}

/**
 * House g1 "Flat 2" and archived house g2, both Ann's (u2). By default Sam (u1, signed up)
 * was added to g1 after signing up, so has a `placeholder` row there, and Ann invited Sam.
 */
function setup(options: Setup = {}): Fakes {
  return fakes(
    {
      persons: [ANN, ...(options.persons ?? [SAM])],
      identities: options.identities ?? [SAM_EMAIL],
      groups: [group('g1'), group('g2', { name: 'Old flat', archivedAt: BEFORE })],
      members: [
        placeholderRow('mAnn', 'g1', 'pAnn', BEFORE, { role: 'admin', status: 'active' }),
        placeholderRow('mAnn2', 'g2', 'pAnn', BEFORE, { role: 'admin', status: 'active' }),
        ...(options.members ?? [placeholderRow('mSam', 'g1', 'pSam', ADDED)]),
      ],
      invites: options.invites ?? [invite('inv1', TOKEN)],
      activity: options.activity ?? [],
      statements: options.statements ?? [],
    },
    { account: options.account ?? account(), teams: options.teams ?? { g1: ['u2'], g2: ['u2'] } },
  )
}

function accept(services: Services, tokenText = TOKEN): Promise<Accepted> {
  return ok<Accepted>(services, 'POST', '/invites/accept', { token: tokenText })
}

function refused(services: Services, body: unknown = { token: TOKEN }, userId?: string | null) {
  return failure(services, 'POST', '/invites/accept', body, userId)
}

function rowOf(services: Fakes, table: string, id: string): Row | undefined {
  return services.db.rows(table).find((row) => row.$id === id)
}

function teamUsers(services: Fakes, groupId: string): string[] | undefined {
  return services.teams.members(groupId)?.map((membership) => membership.userId)
}

/** Everything a refusal must leave as it was. */
function state(services: Fakes) {
  const tables = ['persons', 'identities', 'members', 'invites', 'activity'] as const
  return {
    ...Object.fromEntries(tables.map((table) => [table, services.db.rows(table)])),
    teams: { g1: teamUsers(services, 'g1'), g2: teamUsers(services, 'g2') },
  }
}

/**
 * Runs `before` once, just before the commit of the first transaction that staged an operation
 * matching `when`: another request getting there first, or (if it throws) the commit failing.
 */
function beforeCommitOf(
  db: FakeDb,
  when: (operations: string) => boolean,
  before: () => Promise<unknown>,
) {
  const marked = new Set<string>()
  const stage = db.createOperations.bind(db)
  vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    if (when(JSON.stringify(params.operations))) marked.add(params.transactionId)
    return stage(params)
  })
  const commit = db.updateTransaction.bind(db)
  let done = false
  return vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
    if (!done && params.commit && marked.has(params.transactionId)) {
      done = true
      await before()
    }
    return commit(params)
  })
}

const setsAcceptedAt = (operations: string) => operations.includes('acceptedAt')

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []
beforeEach(() => {
  consoleSpies = CONSOLE.map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
})
afterEach(() => {
  // No address, token or hash in any test's logs.
  const output = consoleSpies.flatMap((spy) => spy.mock.calls.map(String)).join('\n')
  expect(output).not.toMatch(/@|\+614|invite#/)
  for (const n of [1, 2, 3, 9]) {
    expect(output).not.toContain(token(n))
    expect(output).not.toContain(sha256(token(n)))
  }
  vi.restoreAllMocks()
})

describe('POST /invites/accept', () => {
  it('joins the caller’s own placeholder row, then sets acceptedAt, last', async () => {
    const services = setup()
    const staged: string[] = []
    const stage = services.db.createOperations.bind(services.db)
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      staged.push(...(params.operations as Array<{ tableId: string }>).map((op) => op.tableId))
      return stage(params)
    })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
    expect(rowOf(services, 'members', 'mSam')).toMatchObject({ personId: 'pSam', status: 'active' })
    expect(teamUsers(services, 'g1')).toEqual(['u2', 'u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({ groupId: 'g1', actorPersonId: 'pSam', action: 'member.joined' }),
    ])
    expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
    // The join stages a guard write on the person (guardPerson, identity-and-invites.md#order).
    expect(staged).toEqual(['members', 'persons', 'activity', 'invites'])
  })

  it('adopts: a new user who signed up with the invited email joins through bootstrap', async () => {
    const services = setup({
      persons: [KIM],
      identities: [KIM_EMAIL],
      members: [placeholderRow('mKim', 'g1', 'pKim', BEFORE, { displayName: 'Kim' })],
      invites: [invite('inv1', TOKEN, TO_KIM)],
      account: account({ name: 'Kim Ho', email: 'kim@example.com' }),
    })
    // Before bootstrap there is no person to claim with, and nothing is written.
    const before = state(services)
    expect(await refused(services)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Set up your account first.',
    })
    expect(state(services)).toEqual(before)

    await ok(services, 'POST', '/bootstrap', { timezone: 'Australia/Sydney' })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ userId: 'u1', mergedInto: null })
    expect(rowOf(services, 'members', 'mKim')).toMatchObject({ personId: 'pKim', status: 'active' })
    expect(teamUsers(services, 'g1')).toEqual(['u2', 'u1'])
    expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
  })

  it('merges: an existing user who verified the invited email gets the placeholder’s row', async () => {
    const services = setup({
      persons: [SAM, KIM],
      identities: [SAM_EMAIL, KIM_EMAIL],
      members: [placeholderRow('mKim', 'g1', 'pKim', BEFORE, { displayName: 'Kim' })],
      invites: [invite('inv1', TOKEN, TO_KIM)],
      account: account({ email: 'kim@example.com' }),
    })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ userId: null, mergedInto: 'pSam' })
    expect(rowOf(services, 'identities', 'iKim')).toMatchObject({
      personId: 'pSam',
      verified: true,
    })
    expect(services.db.rows('members').filter((row) => row.groupId === 'g1')).toEqual([
      expect.objectContaining({ $id: 'mAnn' }),
      expect.objectContaining({ $id: 'mKim', personId: 'pSam', status: 'active' }),
    ])
    expect(teamUsers(services, 'g1')).toEqual(['u2', 'u1'])
    expect(services.db.rows('activity')).toEqual([
      expect.objectContaining({ actorPersonId: 'pSam', action: 'member.joined' }),
    ])
    expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
  })

  it('answers the group, then a retry the same, when a finalizing statement puts off the merge', async () => {
    // Merge step 2 leaves g1 for a later run, so Kim's row and email stay on pKim, merged into
    // Sam: the email is Sam's only through mergedInto.
    const services = setup({
      persons: [SAM, KIM],
      identities: [SAM_EMAIL, KIM_EMAIL],
      members: [placeholderRow('mKim', 'g1', 'pKim', BEFORE, { displayName: 'Kim' })],
      invites: [invite('inv1', TOKEN, TO_KIM)],
      statements: [{ $id: 'st1', groupId: 'g1', status: 'finalizing', periodStart: '2026-10-01' }],
      account: account({ email: 'kim@example.com' }),
    })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ mergedInto: 'pSam' })
    expect(rowOf(services, 'identities', 'iKim')).toMatchObject({ personId: 'pKim' })
    expect(rowOf(services, 'members', 'mKim')).toMatchObject({
      personId: 'pKim',
      status: 'placeholder',
    })
    expect(teamUsers(services, 'g1')).toEqual(['u2'])
    expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })

    const writes = vi.spyOn(services.db, 'createOperations')
    expect(await accept({ ...services, now: LATER })).toEqual({ groupId: 'g1' })
    expect(writes).not.toHaveBeenCalled()
    expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
  })

  it('joins the caller’s current row, not the invited one, after they were removed and added again', async () => {
    const services = setup({
      members: [placeholderRow('mSamAgain', 'g1', 'pSam', ADDED)],
      invites: [invite('inv1', TOKEN, { memberId: 'mSamRemoved' })],
    })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
    expect(rowOf(services, 'members', 'mSamAgain')).toMatchObject({ status: 'active' })
    expect(teamUsers(services, 'g1')).toEqual(['u2', 'u1'])
  })

  it('still claims, joins nothing and answers the group when the invited row was removed', async () => {
    const services = setup({
      members: [],
      invites: [invite('inv1', TOKEN, { memberId: 'mSamRemoved' })],
      account: account({ phone: '+61412345678', phoneVerification: true }),
    })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
    // Claim ran: the newly verified phone is Sam's.
    expect(services.db.rows('identities')).toEqual([
      expect.objectContaining({ $id: 'iSam' }),
      expect.objectContaining({ key: 'phone:+61412345678', personId: 'pSam', verified: true }),
    ])
    expect(services.db.rows('members').map((row) => row.$id)).toEqual(['mAnn', 'mAnn2'])
    expect(teamUsers(services, 'g1')).toEqual(['u2'])
    expect(services.db.rows('activity')).toEqual([])
    expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
  })

  describe('never touches a row the caller left on their own', () => {
    const LEFT = placeholderRow('mSam', 'g1', 'pSam', ADDED, {
      status: 'left',
      role: 'viewer',
      leftOn: '2026-10-17',
    })
    const LEFT_ON_THEIR_OWN = {
      $id: 'a1',
      $createdAt: '2026-10-17T00:00:00.000Z',
      at: '2026-10-17T00:00:00.000Z',
      groupId: 'g1',
      actorPersonId: 'pSam',
      action: 'member.left',
      summary: 'Sam left',
    }

    it('when the invited row is that row', async () => {
      const services = setup({ members: [LEFT], activity: [LEFT_ON_THEIR_OWN] })
      expect(await accept(services)).toEqual({ groupId: 'g1' })
      expect(rowOf(services, 'members', 'mSam')).toEqual(
        expect.objectContaining({ status: 'left', role: 'viewer', leftOn: '2026-10-17' }),
      )
      // Not back in the team, and no member.joined.
      expect(teamUsers(services, 'g1')).toEqual(['u2'])
      expect(services.db.rows('activity')).toEqual([expect.objectContaining(LEFT_ON_THEIR_OWN)])
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
    })

    it('when the invite was to a placeholder merged into the caller (a kept group)', async () => {
      const services = setup({
        persons: [SAM, KIM],
        identities: [SAM_EMAIL, KIM_EMAIL],
        members: [LEFT, placeholderRow('mKim', 'g1', 'pKim', BEFORE, { displayName: 'Kim' })],
        activity: [LEFT_ON_THEIR_OWN],
        invites: [invite('inv1', TOKEN, TO_KIM)],
        account: account({ email: 'kim@example.com' }),
      })
      expect(await accept(services)).toEqual({ groupId: 'g1' })
      expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ mergedInto: 'pSam' })
      expect(rowOf(services, 'members', 'mSam')).toMatchObject({ status: 'left', role: 'viewer' })
      expect(rowOf(services, 'members', 'mKim')).toMatchObject({
        personId: 'pKim',
        status: 'placeholder',
      })
      expect(teamUsers(services, 'g1')).toEqual(['u2'])
      expect(services.db.rows('activity')).toHaveLength(1)
    })
  })

  it('works in an archived group', async () => {
    const services = setup({
      members: [placeholderRow('mSam2', 'g2', 'pSam', ADDED)],
      invites: [invite('inv1', TOKEN, { groupId: 'g2', memberId: 'mSam2' })],
    })
    expect(await accept(services)).toEqual({ groupId: 'g2' })
    expect(rowOf(services, 'members', 'mSam2')).toMatchObject({ status: 'active' })
    expect(teamUsers(services, 'g2')).toEqual(['u2', 'u1'])
  })

  it('accepts a text-message invite once the phone is verified, and an email in any case', async () => {
    const phone = setup({
      identities: [SAM_EMAIL, identity('iPhone', 'phone:+61412345678', 'pSam')],
      invites: [invite('inv1', TOKEN, SMS)],
      account: account({
        emailVerification: false,
        phone: '+61412345678',
        phoneVerification: true,
      }),
    })
    expect(await accept(phone)).toEqual({ groupId: 'g1' })
    expect(rowOf(phone, 'members', 'mSam')).toMatchObject({ status: 'active' })

    const email = setup({ account: account({ email: 'Sam@Example.COM' }) })
    expect(await accept(email)).toEqual({ groupId: 'g1' })
  })

  it('accepts until just before expiresAt', async () => {
    const services = setup({ invites: [invite('inv1', TOKEN, { expiresAt: at(1) })] })
    expect(await accept(services)).toEqual({ groupId: 'g1' })
  })

  describe('answers needsVerification, writing nothing,', () => {
    // The account has a verified phone that claim would record, and Sam a row claim would join,
    // so a claim run too early would show.
    const PHONE = { phone: '+61400000000', phoneVerification: true }
    const EARLY = placeholderRow('mSam2', 'g2', 'pSam', BEFORE)

    it.each([
      ['email, when the account’s email isn’t verified', {}, { emailVerification: false }, 'email'],
      ['email, when another email is verified', {}, { email: 'sam.lee@example.com' }, 'email'],
      ['phone, for a text-message invite and another phone', SMS, {}, 'phone'],
    ])('%s', async (_name, inviteExtra, accountExtra, expected) => {
      const services = setup({
        members: [placeholderRow('mSam', 'g1', 'pSam', ADDED), EARLY],
        invites: [invite('inv1', TOKEN, inviteExtra)],
        account: account({ ...PHONE, ...accountExtra }),
      })
      const before = state(services)
      const transactions = vi.spyOn(services.db, 'createTransaction')
      expect(await accept(services)).toEqual({ needsVerification: expected })
      expect(transactions).not.toHaveBeenCalled()
      expect(state(services)).toEqual(before)
    })
  })

  it('refuses a caller whose account deletion has started, as claim does, writing nothing', async () => {
    const services = setup({ persons: [{ ...SAM, deletedAt: BEFORE }] })
    const before = state(services)
    const writes = vi.spyOn(services.db, 'createOperations')
    expect(await refused(services)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Set up your account first.',
    })
    expect(writes).not.toHaveBeenCalled()
    expect(state(services)).toEqual(before)
  })

  describe('refuses with INVITE_INVALID and one message, writing nothing,', () => {
    const USED_BY_KIM = invite('inv1', TOKEN, { ...TO_KIM, acceptedAt: BEFORE })
    const TO_BEN = { memberId: 'mBen', identityKey: 'email:ben@example.com' }
    const BEN_ROW = placeholderRow('mBen', 'g1', 'pBen', BEFORE, { displayName: 'Ben' })
    const AS_BEN = account({ email: 'ben@example.com' })

    it.each<[string, Setup, string]>([
      ['an unknown token', {}, token(9)],
      ['a malformed token', {}, 'not a token!'],
      ['an empty token', {}, ''],
      ['a 128-character token', {}, 'é'.repeat(128)],
      [
        'an invite at its expiresAt',
        { invites: [invite('inv1', TOKEN, { expiresAt: at(0) })] },
        TOKEN,
      ],
      ['an expired invite', { invites: [invite('inv1', TOKEN, { expiresAt: at(-1) })] }, TOKEN],
      [
        'an invite someone else accepted',
        { persons: [SAM, { ...KIM, userId: 'u4' }], invites: [USED_BY_KIM] },
        TOKEN,
      ],
      [
        'a used invite to the caller’s address that their account no longer has verified',
        {
          invites: [invite('inv1', TOKEN, { acceptedAt: BEFORE })],
          account: account({ emailVerification: false }),
        },
        TOKEN,
      ],
      [
        'a used invite whose identity row is gone',
        { identities: [], invites: [invite('inv1', TOKEN, { acceptedAt: BEFORE })] },
        TOKEN,
      ],
      [
        'a used invite to an address the caller verified that another registered person holds',
        {
          persons: [SAM, BEN],
          identities: [SAM_EMAIL, BEN_EMAIL],
          invites: [invite('inv1', TOKEN, { ...TO_BEN, acceptedAt: BEFORE })],
          account: AS_BEN,
        },
        TOKEN,
      ],
      // A person with deletedAt is never resolved from a userId (identity-and-invites.md#order).
      [
        'a used invite to a caller whose account deletion has started',
        {
          persons: [{ ...SAM, deletedAt: BEFORE }],
          invites: [invite('inv1', TOKEN, { acceptedAt: BEFORE })],
        },
        TOKEN,
      ],
      [
        'an open invite to an address the caller verified that another registered person holds',
        {
          persons: [SAM, BEN],
          identities: [SAM_EMAIL, BEN_EMAIL],
          members: [BEN_ROW],
          invites: [invite('inv1', TOKEN, TO_BEN)],
          account: AS_BEN,
        },
        TOKEN,
      ],
    ])('%s', async (_name, options, tokenText) => {
      const services = setup(options)
      const before = state(services)
      const writes = vi.spyOn(services.db, 'createOperations')
      expect(await refused(services, { token: tokenText })).toEqual({
        status: 400,
        code: 'INVITE_INVALID',
        message: INVALID,
      })
      expect(writes).not.toHaveBeenCalled()
      expect(state(services)).toEqual(before)
    })
  })

  describe('refuses a request that fails the schema', () => {
    it.each([
      ['a 129-character token', { token: 'x'.repeat(129) }],
      ['no token', {}],
      ['a token that is not text', { token: 42 }],
      ['an unknown field', { token: TOKEN, groupId: 'g1' }],
      ['no body', undefined],
    ])('%s', async (_name, body) => {
      const services = setup()
      const { status, body: envelope } = await call(services, 'POST', '/invites/accept', body)
      expect(status).toBe(400)
      expect(envelope).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
      // The response never repeats the token.
      expect(JSON.stringify(envelope)).not.toContain('x'.repeat(129))
      expect(rowOf(services, 'invites', 'inv1')?.acceptedAt).toBeNull()
    })

    it('and a caller without a JWT', async () => {
      expect(await refused(setup(), { token: TOKEN }, null)).toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      })
    })
  })

  describe('acceptedAt, set once and last', () => {
    it('answers a retry by the same person with the group, writing nothing', async () => {
      const services = setup()
      await accept(services)
      const writes = vi.spyOn(services.db, 'createOperations')
      expect(await accept({ ...services, now: LATER })).toEqual({ groupId: 'g1' })
      expect(writes).not.toHaveBeenCalled()
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
    })

    it('refuses a retry once the invite has expired', async () => {
      const services = setup()
      await accept(services)
      const expired = { ...services, now: new Date(NOW.getTime() + 13 * DAY_MS) }
      expect((await refused(expired)).code).toBe('INVITE_INVALID')
    })

    it('leaves the invite open when cut off after the join, and a retry finishes it', async () => {
      const services = setup()
      beforeCommitOf(services.db, setsAcceptedAt, async () => {
        throw new Error('Appwrite is down')
      })
      expect((await refused(services)).code).toBe('INTERNAL')
      expect(rowOf(services, 'members', 'mSam')).toMatchObject({ status: 'active' })
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: null })

      expect(await accept({ ...services, now: LATER })).toEqual({ groupId: 'g1' })
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: LATER.toISOString() })
      expect(services.db.rows('activity')).toHaveLength(1)
    })

    it('says CONFLICT, try again, when its commit conflicts and acceptedAt is still unset', async () => {
      const services = setup()
      beforeCommitOf(services.db, setsAcceptedAt, async () => {
        throw new AppwriteException('Conflict', 409, 'transaction_conflict')
      })
      expect(await refused(services)).toEqual({ status: 409, code: 'CONFLICT', message: TRY_AGAIN })
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: null })
      expect(await accept(services)).toEqual({ groupId: 'g1' })
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: NOW.toISOString() })
    })

    // The other accept (clock LATER) runs to the end at the given point in this one (NOW).
    it.each<[string, (db: FakeDb, other: () => Promise<unknown>) => unknown]>([
      [
        'just before this one stages its join',
        (db, other) =>
          beforeStaging(db, (operations) => operations.includes('"tableId":"members"'), other),
      ],
      [
        'just before this one stages acceptedAt',
        (db, other) => beforeStaging(db, setsAcceptedAt, other),
      ],
      [
        'after this one staged acceptedAt, before its commit',
        (db, other) => beforeCommitOf(db, setsAcceptedAt, other),
      ],
    ])('two accepts at once both answer the group when the other ends %s', async (_name, hook) => {
      const services = setup()
      let other: Accepted | undefined
      const raced = hook(services.db, async () => {
        other = await accept({ ...services, now: LATER })
      })
      expect(await accept(services)).toEqual({ groupId: 'g1' })
      expect(raced).toHaveBeenCalled()
      expect(other).toEqual({ groupId: 'g1' })
      // Written once, by the accept that committed first, and never overwritten.
      expect(rowOf(services, 'invites', 'inv1')).toMatchObject({ acceptedAt: LATER.toISOString() })
      expect(rowOf(services, 'members', 'mSam')).toMatchObject({ status: 'active' })
      expect(services.db.rows('activity')).toHaveLength(1)
      expect(teamUsers(services, 'g1')).toEqual(['u2', 'u1'])
    })
  })

  it('logs no token, hash, address or name', async () => {
    const tokens = [TOKEN, token(2), token(3), token(9), 'x'.repeat(129)]
    const services = setup({
      persons: [SAM, KIM],
      identities: [SAM_EMAIL, KIM_EMAIL],
      members: [placeholderRow('mKim', 'g1', 'pKim', BEFORE, { displayName: 'Kim' })],
      invites: [
        invite('inv1', TOKEN, TO_KIM),
        invite('inv2', token(2), { ...SMS, memberId: 'mKim' }),
        invite('inv3', token(3), { ...TO_KIM, expiresAt: at(0) }),
      ],
      account: account({
        email: 'Kim@Example.com',
        phone: '+61400000000',
        phoneVerification: true,
      }),
    })
    const logs: string[] = []
    for (const tokenText of tokens) {
      // A merge, a needsVerification, an expired, an unknown and an invalid token.
      logs.push(...(await call(services, 'POST', '/invites/accept', { token: tokenText })).logs)
    }
    expect(rowOf(services, 'persons', 'pKim')).toMatchObject({ mergedInto: 'pSam' })
    const output = [...logs, ...consoleSpies.flatMap((spy) => spy.mock.calls.map(String))].join(
      '\n',
    )
    expect(logs).toHaveLength(5)
    expect(output).toContain('"route":"POST /invites/accept"')
    const secrets = [
      ...tokens,
      ...tokens.map(sha256),
      'kim@example.com',
      'Kim@Example.com',
      'sam@example.com',
      '61412345678',
      '61400000000',
      'Kim Ho',
      'Sam Lee',
      'Ann Cho',
    ]
    for (const secret of secrets) expect(output).not.toContain(secret)
  })
})
