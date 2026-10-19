import { createHash } from 'node:crypto'
import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { AppwriteException } from 'node-appwrite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_URL,
  account,
  BEFORE,
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  NOW,
  placeholderRow,
  TRY_AGAIN,
} from './harness'

type Row = Record<string, unknown> & { $id: string }
type InviteResult = { sentAt: string; expiresAt: string }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const BODY = { groupId: 'g1', memberId: 'mSam', email: 'sam@example.com' }
const TO_KIM = { groupId: 'g1', memberId: 'mKim', email: 'kim@example.com' }
const NOT_THEIR_EMAIL = "This email address isn't one this person was added with."
const TOO_MANY = 'Too many invites have been sent. Try again later.'

function person(id: string, userId: string | null, displayName: string) {
  return {
    $id: id,
    userId,
    displayName,
    claimedAt: userId ? BEFORE : null,
    mergedInto: null,
    deletedAt: null,
    rev: null,
  }
}

function group(id: string, type: string, name: string, extra: object = {}) {
  return {
    $id: id,
    type,
    name,
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

function member(
  id: string,
  groupId: string,
  personId: string,
  displayName: string,
  role: string,
  status: string,
) {
  return placeholderRow(id, groupId, personId, BEFORE, { displayName, role, status })
}

function identity(id: string, key: string, personId: string) {
  return { $id: id, key, type: 'email', personId, verified: false, verifiedAt: null }
}

/** `count` invites already sent, with distinct tokens (uniq_tokenHash). */
function sentInvites(prefix: string, count: number, extra: Partial<Row>): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    $id: `${prefix}${index}`,
    groupId: 'g1',
    memberId: 'mKim',
    identityKey: `email:someone${index}@example.com`,
    tokenHash: `${prefix}-hash-${index}`,
    channel: 'email',
    invitedBy: 'pVic',
    sentAt: ago(HOUR_MS),
    expiresAt: NOW.toISOString(),
    acceptedAt: null,
    ...extra,
  }))
}

/**
 * House g1 "Flat 2": u1 (Ann, admin, "Annie" there), u2 (Ben, member) and u3 (Vic, viewer) have
 * joined; Sam and Kim were added and haven't, nor has u4 (Zoe). Pair g2: Ann and Sam. Employer
 * g4: Ben as a member, and Sam. Archived house g3: Ann and Sam. `samUserId` gives Sam an account.
 */
function fixture(options: { samUserId?: string; invites?: Row[]; verified?: boolean } = {}): Fakes {
  return fakes(
    {
      persons: [
        person('pAnn', 'u1', 'Ann Cho-Smith'),
        person('pBen', 'u2', 'Ben Ng'),
        person('pVic', 'u3', 'Vic Li'),
        person('pZoe', 'u4', 'Zoe Quinn'),
        person('pSam', options.samUserId ?? null, 'Sam Lee'),
        person('pKim', null, 'Kim'),
        person('pJo', null, 'Jo'),
      ],
      identities: [
        identity('iSam', 'email:sam@example.com', 'pSam'),
        identity('iKim', 'email:kim@example.com', 'pKim'),
        identity('iJo', 'email:jo@example.com', 'pJo'),
      ],
      groups: [
        group('g1', 'house', 'Flat 2'),
        group('g2', 'pair', 'Sam'),
        group('g3', 'house', 'Old flat', { archivedAt: BEFORE }),
        group('g4', 'employer', 'Zed Cafe', { ownerPersonId: 'pBen' }),
      ],
      members: [
        member('mAnn', 'g1', 'pAnn', 'Annie', 'admin', 'active'),
        member('mBen', 'g1', 'pBen', 'Ben', 'member', 'active'),
        member('mVic', 'g1', 'pVic', 'Vic', 'viewer', 'active'),
        member('mZoe', 'g1', 'pZoe', 'Zoe', 'member', 'placeholder'),
        member('mSam', 'g1', 'pSam', 'Sammy', 'member', 'placeholder'),
        member('mKim', 'g1', 'pKim', 'Kim', 'member', 'placeholder'),
        member('mAnn2', 'g2', 'pAnn', 'Ann', 'admin', 'active'),
        member('mSam2', 'g2', 'pSam', 'Sam', 'admin', 'placeholder'),
        member('mAnn3', 'g3', 'pAnn', 'Ann', 'admin', 'active'),
        member('mSam3', 'g3', 'pSam', 'Sam', 'member', 'placeholder'),
        member('mBen4', 'g4', 'pBen', 'Ben', 'member', 'active'),
        member('mSam4', 'g4', 'pSam', 'Sam', 'viewer', 'placeholder'),
      ],
      invites: options.invites ?? [],
    },
    {
      account: account({ emailVerification: options.verified ?? true }),
      teams: { g1: ['u1', 'u2', 'u3'], g2: ['u1'], g3: ['u1'], g4: ['u2'] },
    },
  )
}

async function sends(services: Fakes, body: object = BODY, userId = 'u1'): Promise<InviteResult> {
  const { status, body: envelope } = await call(services, 'POST', '/invites', body, userId)
  if (!envelope.ok) throw new Error(`${status} ${JSON.stringify(envelope.error)}`)
  return envelope.data as InviteResult
}

function refused(services: Fakes, body: object = BODY, userId: string | null = 'u1') {
  return failure(services, 'POST', '/invites', body, userId)
}

function tokenOf(email: Email | undefined): string {
  const token = email?.text.match(/\/invite#([^\s]+)/)?.[1]
  if (!token) throw new Error('The email has no invite link')
  return token
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function revs(services: Fakes): Record<string, unknown> {
  return Object.fromEntries(services.db.rows('persons').map((row) => [row.$id, row.rev]))
}

const UNTOUCHED = {
  pAnn: null,
  pBen: null,
  pVic: null,
  pZoe: null,
  pSam: null,
  pKim: null,
  pJo: null,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /invites', () => {
  it('stores only the hash of a random token and emails the link to the typed address', async () => {
    const services = fixture()
    expect(await sends(services)).toEqual({
      sentAt: NOW.toISOString(),
      expiresAt: '2026-11-01T20:00:00.000Z',
    })
    const [row] = services.db.rows('invites')
    const [email] = services.sent
    const token = tokenOf(email)
    // 32 random bytes, base64url.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(services.db.rows('invites')).toEqual([
      expect.objectContaining({
        groupId: 'g1',
        memberId: 'mSam',
        identityKey: 'email:sam@example.com',
        tokenHash: sha256(token),
        channel: 'email',
        invitedBy: 'pAnn',
        sentAt: NOW.toISOString(),
        expiresAt: '2026-11-01T20:00:00.000Z',
        acceptedAt: null,
        $permissions: [],
      }),
    ])
    expect(JSON.stringify(services.db.rows('invites'))).not.toContain(token)
    expect(services.sent).toHaveLength(1)
    expect(email).toMatchObject({ to: 'sam@example.com', idempotencyKey: `invite/${row?.$id}` })
    expect(email?.text).toContain(`Accept the invite: ${APP_URL}/invite#${token}`)
    // The inviter as the group calls them, and the group; nothing else.
    expect(email?.subject).toBe('Annie invited you to a group on Ledgerly')
    expect(email?.text).toContain('Annie added you to the group “Flat 2” on Ledgerly')
    expect(`${email?.subject} ${email?.text} ${email?.html}`).not.toMatch(/Cho-Smith|Sammy|Sam Lee/)
    // The guard writes: a fresh rev on the inviter's and the target's persons rows.
    expect(revs(services)).toEqual({
      ...UNTOUCHED,
      pAnn: expect.stringMatching(/^[a-z0-9]{20}$/),
      pSam: expect.stringMatching(/^[a-z0-9]{20}$/),
    })
  })

  it('gives every invite its own token', async () => {
    const services = fixture()
    await sends(services)
    await sends(services)
    const [first, second] = services.sent.map(tokenOf)
    expect(first).not.toBe(second)
    expect(new Set(services.db.rows('invites').map((row) => row.tokenHash)).size).toBe(2)
  })

  it('normalises the typed address before matching it and sends to the normalised one', async () => {
    const services = fixture()
    await sends(services, { ...BODY, email: '  Sam@Example.COM ' })
    expect(services.sent[0]?.to).toBe('sam@example.com')
    expect(services.db.rows('invites')[0]?.identityKey).toBe('email:sam@example.com')
  })

  it('lets a house member invite, and an admin outside a house', async () => {
    const services = fixture()
    await sends(services, BODY, 'u2')
    await sends(services, { groupId: 'g2', memberId: 'mSam2', email: 'sam@example.com' }, 'u1')
    expect(services.db.rows('invites')).toEqual([
      expect.objectContaining({ groupId: 'g1', invitedBy: 'pBen' }),
      expect.objectContaining({ groupId: 'g2', memberId: 'mSam2', invitedBy: 'pAnn' }),
    ])
    expect(services.sent.map((email) => email.subject)).toEqual([
      'Ben invited you to a group on Ledgerly',
      'Ann invited you to a group on Ledgerly',
    ])
  })

  it('writes, sends and answers the same whether or not the person has an account', async () => {
    async function trace(samUserId?: string) {
      const services = fixture({ samUserId })
      const staged: unknown[] = []
      const stage = services.db.createOperations.bind(services.db)
      vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
        staged.push(params.operations)
        return stage(params)
      })
      const response = await call(services, 'POST', '/invites', BODY, 'u1')
      const [row] = services.db.rows('invites')
      if (!row) throw new Error('No invite was written')
      const { $createdAt, $updatedAt, ...invite } = row
      const token = tokenOf(services.sent[0])
      // The token, its hash, the row ID and the revs are random; everything else must match.
      const masked = JSON.stringify({
        status: response.status,
        body: response.body,
        staged,
        sent: services.sent,
        invite,
      })
        .replaceAll(token, 'TOKEN')
        .replaceAll(sha256(token), 'HASH')
        .replaceAll(row.$id, 'ID')
        .replace(/"rev":"[a-z0-9]{20}"/g, '"rev":"REV"')
      return JSON.parse(masked)
    }
    const registered = await trace('u9')
    expect(registered).toEqual(await trace())
    expect(registered.status).toBe(200)
  })

  it('commits the row before sending', async () => {
    const services = fixture()
    let storedAtSend: unknown[] = []
    services.sendEmail = async (email) => {
      storedAtSend = services.db.rows('invites').map((row) => row.tokenHash)
      services.sent.push(email)
      return {}
    }
    await sends(services)
    expect(storedAtSend).toEqual([sha256(tokenOf(services.sent[0]))])
  })

  it('is INTERNAL when the email fails, and the row it committed still counts', async () => {
    const services = fixture({ invites: sentInvites('old', 19, { invitedBy: 'pAnn' }) })
    services.sendEmail = async () => {
      throw new EmailError('Resend answered 500 internal_server_error', 'internal_server_error')
    }
    const { status, body, logs } = await call(services, 'POST', '/invites', BODY, 'u1')
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(logs).toEqual([expect.stringContaining('"cause":"EmailError"')])
    expect(services.db.rows('invites')).toHaveLength(20)
    expect(services.db.rows('invites')[19]).toMatchObject({ memberId: 'mSam', invitedBy: 'pAnn' })

    services.sendEmail = async (email) => {
      services.sent.push(email)
      return {}
    }
    expect(await refused(services, TO_KIM)).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
      message: TOO_MANY,
    })
  })

  it('writes nothing without APP_URL, and builds the link with or without a trailing slash', async () => {
    const services = fixture()
    services.appUrl = ''
    expect((await refused(services)).code).toBe('INTERNAL')
    expect(services.db.rows('invites')).toEqual([])
    expect(revs(services)).toEqual(UNTOUCHED)
    expect(services.sent).toEqual([])

    services.appUrl = `${APP_URL}/`
    await sends(services)
    expect(services.sent[0]?.text).toContain(`${APP_URL}/invite#${tokenOf(services.sent[0])}`)
  })

  describe('refuses, writing and sending nothing,', () => {
    it.each([
      [
        'a phone number, until SMS ships',
        { groupId: 'g1', memberId: 'mSam', phone: '0412 345 678' },
        'u1',
        {
          status: 400,
          code: 'VALIDATION_FAILED',
          message: 'Invites by text message are not available yet.',
        },
      ],
      [
        'both an email and a phone',
        { ...BODY, phone: '0412 345 678' },
        'u1',
        { status: 400, code: 'VALIDATION_FAILED' },
      ],
      ['neither', { groupId: 'g1', memberId: 'mSam' }, 'u1', { code: 'VALIDATION_FAILED' }],
      ['an unknown field', { ...BODY, name: 'Sam' }, 'u1', { code: 'VALIDATION_FAILED' }],
      ['an invalid email', { ...BODY, email: 'sam@' }, 'u1', { code: 'VALIDATION_FAILED' }],
      ['a caller without a JWT', BODY, null, { status: 401, code: 'UNAUTHENTICATED' }],
      [
        'someone with no row in the group',
        { ...BODY, groupId: 'g2', memberId: 'mSam2' },
        'u2',
        { status: 403, code: 'NOT_A_MEMBER' },
      ],
      ['someone who has not joined the group', BODY, 'u4', { status: 403, code: 'NOT_A_MEMBER' }],
      [
        'a viewer',
        BODY,
        'u3',
        { status: 403, code: 'FORBIDDEN', message: "Your role in this group can't do this." },
      ],
      [
        'a member who is not an admin, outside a house',
        { ...BODY, groupId: 'g4', memberId: 'mSam4' },
        'u2',
        { status: 403, code: 'FORBIDDEN', message: "Your role in this group can't do this." },
      ],
      [
        'an archived group',
        { ...BODY, groupId: 'g3', memberId: 'mSam3' },
        'u1',
        { status: 409, code: 'ARCHIVED' },
      ],
      [
        'a member ID that does not exist',
        { ...BODY, memberId: 'mNobody' },
        'u1',
        { status: 404, code: 'NOT_FOUND', message: 'This member is not in the group.' },
      ],
      [
        "another group's member",
        { ...BODY, memberId: 'mSam2' },
        'u1',
        { status: 404, code: 'NOT_FOUND', message: 'This member is not in the group.' },
      ],
      [
        'someone who has joined',
        { ...BODY, memberId: 'mBen', email: 'ben@example.com' },
        'u1',
        {
          status: 400,
          code: 'VALIDATION_FAILED',
          message: 'Only someone who has not joined the group yet can be invited.',
        },
      ],
      [
        'an address nobody has',
        { ...BODY, email: 'nobody@example.com' },
        'u1',
        { status: 400, code: 'VALIDATION_FAILED', message: NOT_THEIR_EMAIL },
      ],
      [
        "someone else's address",
        { ...BODY, email: 'jo@example.com' },
        'u1',
        { status: 400, code: 'VALIDATION_FAILED', message: NOT_THEIR_EMAIL },
      ],
      [
        "another member's address in the same group",
        { ...BODY, email: 'kim@example.com' },
        'u1',
        { status: 400, code: 'VALIDATION_FAILED', message: NOT_THEIR_EMAIL },
      ],
    ])('%s', async (_name, body, userId, expected) => {
      const services = fixture()
      expect(await refused(services, body, userId)).toMatchObject(expected)
      expect(services.db.rows('invites')).toEqual([])
      expect(revs(services)).toEqual(UNTOUCHED)
      expect(services.sent).toEqual([])
    })

    it('an inviter whose email is not verified', async () => {
      const services = fixture({ verified: false })
      expect(await refused(services)).toEqual({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Verify your email address before you send invites.',
      })
      expect(services.db.rows('invites')).toEqual([])
      expect(services.sent).toEqual([])
    })
  })

  describe('rate limits', () => {
    it('refuses the 21st invite by one inviter in 24 hours, before anything is committed', async () => {
      const services = fixture({ invites: sentInvites('a', 20, { invitedBy: 'pAnn' }) })
      expect(await refused(services)).toEqual({
        status: 429,
        code: 'RATE_LIMITED',
        message: TOO_MANY,
      })
      expect(services.db.rows('invites')).toHaveLength(20)
      expect(revs(services)).toEqual(UNTOUCHED)
      expect(services.sent).toEqual([])
      // The limit is the inviter's: someone else in the group can still invite Sam.
      await sends(services, BODY, 'u2')
    })

    it('counts the last 24 hours only, so an invite exactly a day old no longer counts', async () => {
      const services = fixture({
        invites: [
          ...sentInvites('old', 20, { invitedBy: 'pAnn', sentAt: ago(DAY_MS) }),
          ...sentInvites('new', 19, { invitedBy: 'pAnn', sentAt: ago(DAY_MS - 1000) }),
        ],
      })
      await sends(services)
      expect((await refused(services, TO_KIM)).code).toBe('RATE_LIMITED')
    })

    it('refuses the 4th invite to one address in 7 days, whoever sends it', async () => {
      const services = fixture({
        invites: sentInvites('s', 3, {
          identityKey: 'email:sam@example.com',
          invitedBy: 'pBen',
          sentAt: ago(7 * DAY_MS - 1000),
        }),
      })
      expect(await refused(services)).toEqual({
        status: 429,
        code: 'RATE_LIMITED',
        message: TOO_MANY,
      })
      expect(services.db.rows('invites')).toHaveLength(3)
      expect(services.sent).toEqual([])
      // Kim's address has its own limit.
      await sends(services, TO_KIM)
    })

    it('counts the last 7 days only for one address', async () => {
      const services = fixture({
        invites: [
          ...sentInvites('old', 3, {
            identityKey: 'email:sam@example.com',
            sentAt: ago(7 * DAY_MS),
          }),
          ...sentInvites('new', 2, { identityKey: 'email:sam@example.com', sentAt: ago(DAY_MS) }),
        ],
      })
      await sends(services)
      expect((await refused(services)).code).toBe('RATE_LIMITED')
    })

    it('refuses the 21st when two invites by one inviter are sent at once', async () => {
      const services = fixture({ invites: sentInvites('a', 19, { invitedBy: 'pAnn' }) })
      let other: InviteResult | undefined
      // To Kim, committed after this request staged its guard on Ann's row and counted 19.
      const raced = beforeCommit(services.db, async () => {
        other = await sends(services, TO_KIM)
      })
      expect(await refused(services)).toEqual({
        status: 429,
        code: 'RATE_LIMITED',
        message: TOO_MANY,
      })
      expect(raced).toHaveBeenCalled()
      expect(other).toEqual({ sentAt: NOW.toISOString(), expiresAt: '2026-11-01T20:00:00.000Z' })
      expect(services.db.rows('invites')).toHaveLength(20)
      expect(services.sent.map((email) => email.to)).toEqual(['kim@example.com'])
    })

    it('refuses the 4th to one address when two inviters send at once', async () => {
      const services = fixture({
        invites: sentInvites('s', 2, { identityKey: 'email:sam@example.com', invitedBy: 'pVic' }),
      })
      // Ben's invite to Sam commits after Ann's request staged its guard on Sam's row.
      const raced = beforeCommit(services.db, () => sends(services, BODY, 'u2'))
      expect((await refused(services)).code).toBe('RATE_LIMITED')
      expect(raced).toHaveBeenCalled()
      expect(services.db.rows('invites').map((row) => row.invitedBy)).toEqual([
        'pVic',
        'pVic',
        'pBen',
      ])
      expect(services.sent).toHaveLength(1)
    })

    it('stages its guard before counting, so an invite committed just before the guard counts', async () => {
      const services = fixture({ invites: sentInvites('a', 19, { invitedBy: 'pAnn' }) })
      // To Kim, committed after this request's checks but before it staged its guards.
      const raced = beforeStaging(
        services.db,
        (operations) => operations.includes('"tableId":"persons"'),
        () => sends(services, TO_KIM),
      )
      expect((await refused(services)).code).toBe('RATE_LIMITED')
      expect(raced).toHaveBeenCalled()
      expect(services.db.rows('invites')).toHaveLength(20)
      expect(services.sent.map((email) => email.to)).toEqual(['kim@example.com'])
    })

    it('counts again after losing a race, and sends when there is still room', async () => {
      const services = fixture()
      beforeCommit(services.db, () => sends(services, TO_KIM))
      await sends(services)
      expect(services.db.rows('invites').map((row) => row.memberId)).toEqual(['mKim', 'mSam'])
      expect(services.sent.map((email) => email.to)).toEqual(['kim@example.com', 'sam@example.com'])
    })

    it('says CONFLICT, try again, when the commit conflicts twice', async () => {
      const services = fixture()
      const commit = services.db.updateTransaction.bind(services.db)
      const commits = vi
        .spyOn(services.db, 'updateTransaction')
        .mockImplementation(async (params) => {
          if (params.commit) throw new AppwriteException('Conflict', 409, 'transaction_conflict')
          return commit(params)
        })
      expect(await refused(services)).toEqual({ status: 409, code: 'CONFLICT', message: TRY_AGAIN })
      expect(commits.mock.calls.filter(([params]) => params.commit)).toHaveLength(2)
      expect(services.db.rows('invites')).toEqual([])
      expect(services.sent).toEqual([])
    })
  })

  it('logs no token, hash, address or name', async () => {
    const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = CONSOLE.map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const services = fixture({ invites: sentInvites('a', 18, { invitedBy: 'pAnn' }) })
    const logs: string[] = []
    const send = async (body: object) => {
      logs.push(...(await call(services, 'POST', '/invites', body, 'u1')).logs)
    }
    await send({ ...BODY, email: ' Sam@Example.com ' })
    await send({ ...BODY, email: 'jo@example.com' })
    services.sendEmail = async () => {
      throw new EmailError('Resend answered 422 validation_error', 'validation_error', 422)
    }
    await send(TO_KIM)
    await send(BODY)
    const secrets = [
      ...services.sent.map(tokenOf),
      ...services.db.rows('invites').map((row) => String(row.tokenHash)),
      'sam@example.com',
      'Sam@Example.com',
      'kim@example.com',
      'jo@example.com',
      'Annie',
      'Flat 2',
    ]
    const output = [...logs, ...spies.flatMap((spy) => spy.mock.calls.map(String))].join('\n')
    expect(logs).toHaveLength(4)
    expect(output).toContain('"route":"POST /invites"')
    for (const secret of secrets) expect(output).not.toContain(secret)
    expect(output).not.toMatch(/@|invite#/)
  })
})
