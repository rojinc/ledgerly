import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { EmailError } from '@ledgerly/server/email/send-email'
import { describe, expect, it, vi } from 'vitest'
import {
  account,
  beforeCommit,
  beforeStaging,
  call,
  type Fakes,
  failure,
  fakes,
  NOW,
  ok,
  updateRow,
} from './harness'

type Row = Record<string, unknown> & { $id: string }

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

function group(extra: object = {}) {
  return {
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
    rev: 'r0',
    ...extra,
  }
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

/** Alex owes Sam $50.00 in a pair group, and the group holds alex@example.com for Alex. */
function fixture(
  seed: Partial<
    Record<'persons' | 'groups' | 'members' | 'shares' | 'identities' | 'reminders', Row[]>
  > = {},
  options: Parameters<typeof fakes>[1] = {},
): Fakes {
  return fakes(
    {
      persons: seed.persons ?? [SAM, ALEX],
      groups: seed.groups ?? [group()],
      members: seed.members ?? [
        member('m1', 'pSam', 'Sam'),
        member('m2', 'pAlex', 'Alex', { status: 'placeholder', role: 'member' }),
      ],
      shares: seed.shares ?? [share('pSam', 5000, 0), share('pAlex', 0, 5000)],
      identities: seed.identities ?? [
        {
          $id: 'i1',
          key: 'email:alex@example.com',
          type: 'email',
          personId: 'pAlex',
          verified: false,
        },
      ],
      reminders: seed.reminders ?? [],
    },
    { teams: { g1: ['u1'] }, ...options },
  )
}

const BODY = { id: 'r1', groupId: 'g1', email: 'alex@example.com' }

function reminder(id: string, extra: object = {}) {
  return {
    $id: id,
    groupId: 'g1',
    sentBy: 'pSam',
    toPersonId: 'pAlex',
    channel: 'email',
    sentAt: NOW.toISOString(),
    ...extra,
  }
}

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const DAY = 24 * 60 * 60 * 1000

describe('identity POST /reminders', () => {
  it('emails the typed address, and stores the reminder and an activity row that names no one', async () => {
    const services = fixture()
    expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: NOW.toISOString() })
    expect(services.sendEmail).toHaveBeenCalledTimes(1)
    const email = vi.mocked(services.sendEmail).mock.calls[0]?.[0]
    expect(email?.to).toBe('alex@example.com')
    expect(email?.idempotencyKey).toBe('person-reminder-r1')
    expect(email?.subject).toBe('You have a payment reminder')
    expect(email?.text).toContain('Sam sent you a reminder that you owe them $50.00.')
    expect(email?.text).toContain('https://app.example')
    expect(email?.text).not.toContain('Alex')
    expect(email?.replyTo).toBeUndefined()
    expect(services.db.rows('reminders')).toMatchObject([
      { $id: 'r1', groupId: 'g1', sentBy: 'pSam', toPersonId: 'pAlex', channel: 'email' },
    ])
    const [activity] = services.db.rows('activity')
    expect(activity).toMatchObject({
      action: 'reminder.sent',
      actorPersonId: 'pSam',
      subjectPersonId: 'pAlex',
      summary: 'was sent a reminder',
    })
    expect(activity?.changesJson ?? null).toBeNull()
    // The typed address and the amount are stored nowhere.
    expect(JSON.stringify(services.db.rows('reminders'))).not.toMatch(/alex@|5000/)
    // Both persons got a fresh rev: the guard.
    expect(services.db.rows('persons').every((person) => typeof person.rev === 'string')).toBe(true)
  })

  it.each([
    ['a placeholder without an account', ALEX, { status: 'placeholder', role: 'member' }],
    [
      'a placeholder with an account',
      { ...ALEX, userId: 'u2' },
      { status: 'placeholder', role: 'member' },
    ],
    ['a joined member', { ...ALEX, userId: 'u2' }, { status: 'active', role: 'admin' }],
  ])('answers and emails %s the same way', async (_case, alex, alexMember) => {
    const services = fixture({
      persons: [SAM, alex],
      members: [member('m1', 'pSam', 'Sam'), member('m2', 'pAlex', 'Alex', alexMember)],
    })
    expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: NOW.toISOString() })
    expect(vi.mocked(services.sendEmail).mock.calls[0]?.[0]?.text).toContain(
      'Sam sent you a reminder that you owe them $50.00.',
    )
  })

  it('takes the address in any case, and follows a merge to the person it belongs to now', async () => {
    const services = fixture({
      persons: [SAM, { ...ALEX, mergedInto: 'pAlex2' }, { ...ALEX, $id: 'pAlex2', userId: 'u2' }],
      identities: [
        {
          $id: 'i1',
          key: 'email:alex@example.com',
          type: 'email',
          personId: 'pAlex2',
          verified: true,
        },
      ],
    })
    await ok(services, 'POST', '/reminders', { ...BODY, email: 'Alex@Example.COM' })
    expect(services.db.rows('reminders')[0]?.toPersonId).toBe('pAlex2')
    // To the address as stored.
    expect(vi.mocked(services.sendEmail).mock.calls[0]?.[0]).toMatchObject({
      to: 'alex@example.com',
    })
  })

  it('finds a merged person by an identity still on the placeholder, mid-merge', async () => {
    // Step 2 moved Alex's member row to Alex2; the identity moves last, so it's still on Alex.
    const services = fixture({
      persons: [SAM, { ...ALEX, mergedInto: 'pAlex2' }, { ...ALEX, $id: 'pAlex2', userId: 'u2' }],
      members: [member('m1', 'pSam', 'Sam'), member('m2', 'pAlex2', 'Alex', { role: 'member' })],
    })
    await ok(services, 'POST', '/reminders', BODY)
    expect(services.db.rows('reminders')[0]?.toPersonId).toBe('pAlex2')
  })

  describe('refuses, and sends nothing', () => {
    it.each([
      ['a bad body', fixture, { ...BODY, note: 'Pay up' }, 'u1', 'VALIDATION_FAILED'],
      ['someone not in the group', fixture, BODY, 'u9', 'NOT_A_MEMBER'],
      [
        'a viewer',
        () =>
          fixture({
            members: [
              member('m1', 'pSam', 'Sam', { role: 'viewer' }),
              member('m2', 'pAlex', 'Alex'),
            ],
          }),
        BODY,
        'u1',
        'FORBIDDEN',
      ],
      [
        'a caller who hasn’t joined',
        () =>
          fixture({
            members: [
              member('m1', 'pSam', 'Sam', { status: 'placeholder' }),
              member('m2', 'pAlex', 'Alex'),
            ],
          }),
        BODY,
        'u1',
        'NOT_A_MEMBER',
      ],
      [
        'a caller who moved out',
        () =>
          fixture({
            members: [
              member('m1', 'pSam', 'Sam', { status: 'left' }),
              member('m2', 'pAlex', 'Alex'),
            ],
          }),
        BODY,
        'u1',
        'NOT_A_MEMBER',
      ],
      [
        'an unverified caller',
        () => fixture({}, { account: account({ emailVerification: false }) }),
        BODY,
        'u1',
        'FORBIDDEN',
      ],
      [
        'an archived group',
        () => fixture({ groups: [group({ archivedAt: '2026-10-01T00:00:00.000Z' })] }),
        BODY,
        'u1',
        'ARCHIVED',
      ],
      [
        'a house',
        () => fixture({ groups: [group({ type: 'house' })] }),
        BODY,
        'u1',
        'VALIDATION_FAILED',
      ],
    ])('%s', async (_case, make, body, userId, code) => {
      const services = make()
      expect((await failure(services, 'POST', '/reminders', body, userId)).code).toBe(code)
      expect(services.sendEmail).not.toHaveBeenCalled()
      expect(services.db.rows('reminders')).toEqual([])
    })

    it.each([
      ['nothing is owed', [share('pSam', 0, 0), share('pAlex', 0, 0)]],
      ['the caller owes', [share('pSam', 0, 5000), share('pAlex', 5000, 0)]],
    ])('when %s', async (_case, shares) => {
      const services = fixture({ shares })
      const { code, message } = await failure(services, 'POST', '/reminders', BODY)
      expect({ code, message }).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Nothing is owed to you in this group.',
      })
      expect(services.sendEmail).not.toHaveBeenCalled()
    })

    it.each([
      ['an address the group doesn’t hold', fixture, 'stranger@example.com'],
      [
        'someone else’s address',
        () =>
          fixture({
            identities: [
              {
                $id: 'i1',
                key: 'email:alex@example.com',
                type: 'email',
                personId: 'pAlex',
                verified: false,
              },
              {
                $id: 'i2',
                key: 'email:sam@example.com',
                type: 'email',
                personId: 'pSam',
                verified: true,
              },
            ],
          }),
        'sam@example.com',
      ],
      [
        'a deleted person',
        () => fixture({ persons: [SAM, { ...ALEX, deletedAt: '2026-10-10T00:00:00.000Z' }] }),
        'alex@example.com',
      ],
    ])('for %s, with one message that never repeats the address', async (_case, make, email) => {
      const services = make()
      const { code, message } = await failure(services, 'POST', '/reminders', { ...BODY, email })
      expect(code).toBe('VALIDATION_FAILED')
      expect(message).toBe(
        "That isn't an address this group has for them. Use one you added them with.",
      )
      expect(message).not.toContain('@')
      expect(services.sendEmail).not.toHaveBeenCalled()
    })
  })

  describe('rate limits', () => {
    it.each([
      ['1 per sender per group in 3 days', [reminder('old', { sentAt: ago(3 * DAY - 1) })]],
      [
        '3 per recipient in 7 days, from anyone',
        [1, 2, 3].map((n) =>
          reminder(`o${n}`, { sentBy: `p${n}`, groupId: `g${n + 1}`, sentAt: ago(7 * DAY - 1) }),
        ),
      ],
      [
        '20 per sender in 24 hours',
        Array.from({ length: 20 }, (_, n) =>
          reminder(`o${n}`, { groupId: `g${n + 2}`, toPersonId: `p${n}`, sentAt: ago(DAY - 1) }),
        ),
      ],
    ])('%s', async (_case, reminders) => {
      const services = fixture({ reminders })
      const { status, code, message } = await failure(services, 'POST', '/reminders', BODY)
      expect({ status, code, message }).toEqual({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many reminders. Try again in a few days.',
      })
      expect(services.sendEmail).not.toHaveBeenCalled()
    })

    it.each([
      [
        'the last one in this group was over 3 days ago',
        [reminder('old', { sentAt: ago(3 * DAY) })],
      ],
      [
        'the recipient got 2 this week',
        [1, 2].map((n) => reminder(`o${n}`, { sentBy: `p${n}`, groupId: `g${n + 1}` })),
      ],
      [
        'the sender sent 19 today',
        Array.from({ length: 19 }, (_, n) =>
          reminder(`o${n}`, { groupId: `g${n + 2}`, toPersonId: `p${n}` }),
        ),
      ],
      [
        'the recipient got 3 exactly 7 days ago',
        [1, 2, 3].map((n) =>
          reminder(`o${n}`, { sentBy: `p${n}`, groupId: `g${n + 1}`, sentAt: ago(7 * DAY) }),
        ),
      ],
      [
        'the sender sent 20 exactly 24 hours ago',
        Array.from({ length: 20 }, (_, n) =>
          reminder(`o${n}`, { groupId: `g${n + 2}`, toPersonId: `p${n}`, sentAt: ago(DAY) }),
        ),
      ],
    ])('sends when %s', async (_case, reminders) => {
      await ok(fixture({ reminders }), 'POST', '/reminders', BODY)
    })
  })

  describe('retries', () => {
    it('answers the same id with the stored time, and sends again under the same key', async () => {
      const services = fixture()
      const first = await ok(services, 'POST', '/reminders', BODY)
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual(first)
      const keys = vi.mocked(services.sendEmail).mock.calls.map(([email]) => email.idempotencyKey)
      expect(keys).toEqual(['person-reminder-r1', 'person-reminder-r1'])
      expect(services.db.rows('reminders')).toHaveLength(1)
    })

    it.each([
      ['its key has nearly expired (23 hours)', { sentAt: ago(23 * 60 * 60 * 1000) }, BODY, ALEX],
      [
        'the address is one the group doesn’t hold',
        { sentAt: ago(1000) },
        { ...BODY, email: 'stranger@example.com' },
        ALEX,
      ],
      [
        'the recipient has started deleting their account',
        { sentAt: ago(1000) },
        BODY,
        { ...ALEX, deletedAt: ago(500) },
      ],
    ])('answers a retry but sends nothing when %s', async (_case, extra, body, alex) => {
      const services = fixture({ persons: [SAM, alex], reminders: [reminder('r1', extra)] })
      expect(await ok(services, 'POST', '/reminders', body)).toEqual({ sentAt: extra.sentAt })
      expect(services.sendEmail).not.toHaveBeenCalled()
    })

    it('sends a retry again just inside 23 hours', async () => {
      const sentAt = ago(23 * 60 * 60 * 1000 - 1)
      const services = fixture({ reminders: [reminder('r1', { sentAt })] })
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt })
      expect(services.sendEmail).toHaveBeenCalledTimes(1)
    })

    it('sends nothing on a retry once the balance is settled', async () => {
      const services = fixture({
        shares: [share('pSam', 0, 0), share('pAlex', 0, 0)],
        reminders: [reminder('r1', { sentAt: ago(1000) })],
      })
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: ago(1000) })
      expect(services.sendEmail).not.toHaveBeenCalled()
    })

    it.each([
      ['another sender', { sentBy: 'pOther' }],
      ['the same sender in another group', { groupId: 'g9' }],
    ])('refuses an id used by %s', async (_case, extra) => {
      const services = fixture({ reminders: [reminder('r1', extra)] })
      expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe('CONFLICT')
      expect(services.sendEmail).not.toHaveBeenCalled()
    })

    it('answers with the row a parallel call with the same id committed first', async () => {
      const services = fixture()
      const { $id: _id, ...data } = reminder('r1', { sentAt: ago(1000) })
      beforeCommit(services.db, () =>
        withTransaction(services.db, (tx) =>
          tx.write({ action: 'create', tableId: 'reminders', rowId: 'r1', data }),
        ),
      )
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: ago(1000) })
      expect(services.db.rows('activity')).toEqual([])
    })

    it('answers from that row, not RATE_LIMITED, when it committed before the count', async () => {
      const services = fixture()
      const { $id: _id, ...data } = reminder('r1', { sentAt: ago(1000) })
      beforeStaging(
        services.db,
        (operations) => operations.includes('persons'),
        () =>
          withTransaction(services.db, (tx) =>
            tx.write({ action: 'create', tableId: 'reminders', rowId: 'r1', data }),
          ),
      )
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: ago(1000) })
    })
  })

  it('sends exactly one email for a burst of 5 parallel reminders with different ids', async () => {
    const services = fixture()
    const answers = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => call(services, 'POST', '/reminders', { ...BODY, id: `r${n}` })),
    )
    expect(answers.filter(({ status }) => status === 200)).toHaveLength(1)
    expect(services.sendEmail).toHaveBeenCalledTimes(1)
    expect(services.db.rows('reminders')).toHaveLength(1)
  })

  it('answers CONFLICT when someone else’s reminder with the same id commits first', async () => {
    const services = fixture()
    const { $id: _id, ...data } = reminder('r1', { sentBy: 'pOther', groupId: 'g9' })
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({ action: 'create', tableId: 'reminders', rowId: 'r1', data }),
      ),
    )
    expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe('CONFLICT')
    expect(services.sendEmail).not.toHaveBeenCalled()
  })

  it('lets only one of two parallel reminders with different ids through: the guards', async () => {
    const services = fixture()
    // The other request commits its reminder, and its guard, after this one counted.
    const { $id: _id, ...data } = reminder('r2')
    beforeCommit(services.db, async () => {
      await withTransaction(services.db, (tx) =>
        tx.write({ action: 'create', tableId: 'reminders', rowId: 'r2', data }),
      )
      await updateRow(services.db, 'persons', 'pSam', { rev: 'other' })
    })
    expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe('CONFLICT')
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(services.db.rows('reminders').map((row) => row.$id)).toEqual(['r2'])
  })

  it.each([
    ['the recipient', 'pAlex', 'VALIDATION_FAILED'],
    ['the sender', 'pSam', 'UNAUTHENTICATED'],
  ])('refuses when %s started deleting their account meanwhile', async (_case, personId, code) => {
    const services = fixture()
    beforeStaging(
      services.db,
      (operations) => operations.includes('persons'),
      () => updateRow(services.db, 'persons', personId, { deletedAt: ago(1000) }),
    )
    expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe(code)
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(services.db.rows('reminders')).toEqual([])
  })

  it('asks to try again when a merge marks the recipient meanwhile, and the retry reminds who they became', async () => {
    const alexNow = { ...SAM, $id: 'pAlexU', userId: 'u2', displayName: 'Alex' }
    const services = fixture({ persons: [SAM, ALEX, alexNow] })
    // Merge step 1, committed after the recipient was found and before the guards.
    beforeStaging(
      services.db,
      (operations) => operations.includes('persons'),
      () => updateRow(services.db, 'persons', 'pAlex', { mergedInto: 'pAlexU' }),
    )
    expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe('CONFLICT')
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(services.db.rows('reminders')).toEqual([])
    expect(services.db.rows('activity')).toEqual([])
    await ok(services, 'POST', '/reminders', BODY)
    expect(services.db.rows('reminders')[0]?.toPersonId).toBe('pAlexU')
    expect(services.db.rows('activity')[0]?.subjectPersonId).toBe('pAlexU')
  })

  it('finds the other member past a row of someone merged into the sender', async () => {
    const services = fixture({
      persons: [SAM, ALEX, { ...ALEX, $id: 'pOld', mergedInto: 'pSam' }],
      members: [
        member('m0', 'pOld', 'Old Sam', { status: 'left' }),
        member('m1', 'pSam', 'Sam'),
        member('m2', 'pAlex', 'Alex', { status: 'placeholder', role: 'member' }),
      ],
    })
    await ok(services, 'POST', '/reminders', BODY)
    expect(services.db.rows('reminders')[0]?.toPersonId).toBe('pAlex')
  })

  it('refuses a pair with no other member, as a wrong address', async () => {
    const services = fixture({ members: [member('m1', 'pSam', 'Sam')] })
    expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe('VALIDATION_FAILED')
  })

  describe('a failed send', () => {
    it.each([
      [
        'a refusal',
        new EmailError('Resend answered 422 validation_error', 'validation_error', 422),
      ],
      ['a timeout', new EmailError('Resend could not be reached: timeout', 'timeout')],
      ['a 5xx', new EmailError('Resend answered 503 unknown', 'unknown', 503)],
      ['a bug', new Error('boom')],
    ])('answers INTERNAL after %s, and still counts; a retry sends again', async (_case, error) => {
      const services = fixture()
      vi.mocked(services.sendEmail).mockRejectedValueOnce(error)
      const { code, message } = await failure(services, 'POST', '/reminders', BODY)
      expect({ code, message }).toEqual({
        code: 'INTERNAL',
        message: 'We couldn’t send the reminder. Try again later.',
      })
      expect(services.db.rows('reminders')).toHaveLength(1)
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: NOW.toISOString() })
      expect(services.sendEmail).toHaveBeenCalledTimes(2)
    })

    it('counts a key Resend already sent, with other content, as sent', async () => {
      const services = fixture()
      vi.mocked(services.sendEmail).mockRejectedValueOnce(
        new EmailError('Resend 409', 'invalid_idempotent_request', 409),
      )
      expect(await ok(services, 'POST', '/reminders', BODY)).toEqual({ sentAt: NOW.toISOString() })
    })

    it('answers INTERNAL while a parallel call is still sending the same key', async () => {
      const services = fixture()
      vi.mocked(services.sendEmail).mockRejectedValueOnce(
        new EmailError('Resend 409', 'concurrent_idempotent_requests', 409),
      )
      expect((await failure(services, 'POST', '/reminders', BODY)).code).toBe('INTERNAL')
    })
  })

  it('logs no address, name or amount, and a failed send only by its type', async () => {
    const services = fixture()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(services.sendEmail).mockRejectedValueOnce(
      new EmailError('boom alex@example.com', 'application_error', 500),
    )
    const first = await call(services, 'POST', '/reminders', BODY)
    const second = await call(fixture(), 'POST', '/reminders', {
      ...BODY,
      email: 'stranger@example.com',
    })
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({
        event: 'person_reminder_failed',
        reminderId: 'r1',
        cause: 'EmailError application_error 500',
      }),
    ])
    const logged = [...first.logs, ...second.logs, ...errors.mock.calls.map(String)].join('\n')
    expect(logged).not.toMatch(/alex@|stranger@|Sam|Alex|50\.00|5000/)
  })
})
