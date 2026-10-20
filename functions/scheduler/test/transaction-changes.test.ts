import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import type { Email } from '@ledgerly/server/email/send-email'
import { EmailError } from '@ledgerly/server/email/send-email'
import { describe, expect, it, vi } from 'vitest'
import type { AccountUser } from '../src/services'
import { sendTransactionChanges } from '../src/steps/transaction-changes'
import { beforeCommit, type Fakes, fakes, group, member, NOW, person } from './harness'

// NOW (harness) is 20:00 UTC: the window 18:00–19:00 is due, and 19:00–20:00 isn't settled.
const WINDOW = '2026-10-18T18:00:00.000Z'
const NEXT = '2026-10-18T19:00:00.000Z'

const house = (name: string) => ({ type: 'house' as const, name, settingsJson: '{"type":"house"}' })

// Alice paid $90.00 for Elm St's groceries, split with Bob and Cara: $30.00 each.
const thirds = (cents: number) => [
  { personId: 'pAlice', netCents: (cents * 2) / 3 },
  { personId: 'pBob', netCents: -cents / 3 },
  { personId: 'pCara', netCents: -cents / 3 },
]

let activityCount = 0
function edit(extra: Record<string, unknown> = {}, changes: Record<string, unknown> = {}) {
  activityCount += 1
  return {
    $id: `a${activityCount}`,
    groupId: 'elm',
    actorPersonId: 'pBob',
    action: 'transaction.updated',
    transactionId: 't1',
    subjectPersonId: null,
    summary: 'Changed “Groceries”',
    at: '2026-10-18T18:10:00.000Z',
    changesJson: JSON.stringify({
      totalCents: { before: 9000, after: 12000 },
      nets: { before: thirds(9000), after: thirds(12000) },
      ...changes,
    }),
    ...extra,
  }
}

function transaction(id: string, groupId: string, description: string) {
  return {
    $id: id,
    groupId,
    kind: 'expense',
    status: 'posted',
    date: '2026-10-14',
    description,
    totalCents: 12000,
  }
}

function seeded(
  options: {
    activity?: ReturnType<typeof edit>[]
    accounts?: Record<string, Partial<AccountUser>>
    checkpoint?: string | null
    now?: Date
    teams?: Record<string, string[]>
    extra?: Record<string, Record<string, unknown>[]>
  } = {},
) {
  const checkpoint = options.checkpoint === undefined ? WINDOW : options.checkpoint
  return fakes(
    {
      persons: [
        person('pAlice', 'uAlice'),
        person('pBob', 'uBob'),
        person('pCara', 'uCara'),
        person('pDan', null),
      ],
      groups: [group('elm', 'pAlice', house('Elm St'))],
      members: [
        member('elm', 'pAlice', { displayName: 'Alice' }),
        member('elm', 'pBob', { displayName: 'Bob' }),
        member('elm', 'pCara', { displayName: 'Cara' }),
      ],
      transactions: [transaction('t1', 'elm', 'Groceries')],
      activity: options.activity ?? [edit()],
      checkpoints: checkpoint === null ? [] : [{ $id: 'transaction-changes', through: checkpoint }],
      ...options.extra,
    } as never,
    {
      accounts: options.accounts ?? {
        uAlice: { email: 'alice@example.com', emailVerification: true },
        uBob: { email: 'bob@example.com', emailVerification: true },
        uCara: { email: 'cara@example.com', emailVerification: true },
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.teams ? { teams: options.teams } : {}),
    },
  )
}

function sent(services: Fakes): Email[] {
  return services.sendEmail.mock.calls.map(([email]) => email)
}

function through(services: Fakes): string | undefined {
  return services.db.rows('checkpoints').find((row) => row.$id === 'transaction-changes')
    ?.through as string | undefined
}

describe('step 3b: transaction change emails', () => {
  it('emails the others in it once, not the one who changed it, and moves on', async () => {
    const services = seeded()
    expect(await sendTransactionChanges(services)).toEqual({ sent: 2, failed: 0, skipped: 0 })
    expect(sent(services).map((email) => email.to)).toEqual([
      'alice@example.com',
      'cara@example.com',
    ])
    const [alice] = sent(services)
    expect(alice).toMatchObject({
      subject: 'A transaction you’re in was changed',
      idempotencyKey: 'txn-changes-pAlice-2026101818',
    })
    expect(alice?.text).toContain('“Groceries” in Elm St, changed by Bob:')
    expect(alice?.text).toContain('- Your part: you’re owed $60.00 → you’re owed $80.00')
    expect(alice?.text).toContain('https://app.example.com/groups/elm/transactions/t1')
    expect(alice?.text).toContain('Change your email settings: https://app.example.com/profile')
    // Spaced, for Resend's 2 a second.
    expect(services.wait).toHaveBeenCalledWith(500)
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
  })

  it('folds a window’s edits into one email each, and an undone edit into none', async () => {
    const twice = seeded({
      activity: [
        edit(
          { at: '2026-10-18T18:10:00.000Z' },
          {
            nets: { before: thirds(9000), after: thirds(10500) },
            totalCents: { before: 9000, after: 10500 },
          },
        ),
        edit(
          { at: '2026-10-18T18:20:00.000Z' },
          {
            nets: { before: thirds(10500), after: thirds(12000) },
            totalCents: { before: 10500, after: 12000 },
          },
        ),
      ],
    })
    await sendTransactionChanges(twice)
    expect(sent(twice)).toHaveLength(2)
    expect(sent(twice)[0]?.text).toContain('- Total: $90.00 → $120.00')
    const undone = seeded({
      activity: [
        edit(),
        edit(
          { at: '2026-10-18T18:30:00.000Z' },
          {
            nets: { before: thirds(12000), after: thirds(9000) },
            totalCents: { before: 12000, after: 9000 },
          },
        ),
      ],
    })
    expect(await sendTransactionChanges(undone)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    // Nothing to send still finishes the window.
    expect(Date.parse(through(undone) as string)).toBe(Date.parse(NEXT))
  })

  it('puts changes in two groups into one email', async () => {
    const services = seeded({
      activity: [
        edit(),
        edit({ groupId: 'pine', transactionId: 't2', at: '2026-10-18T18:40:00.000Z' }),
      ],
      extra: {
        groups: [
          group('elm', 'pAlice', house('Elm St')),
          group('pine', 'pAlice', house('Pine Rd')),
        ],
        members: [
          member('elm', 'pAlice', { displayName: 'Alice' }),
          member('elm', 'pBob', { displayName: 'Bob' }),
          member('elm', 'pCara', { displayName: 'Cara' }),
          member('pine', 'pAlice', { displayName: 'Alice' }),
          member('pine', 'pBob', { displayName: 'Bobby' }),
          member('pine', 'pCara', { displayName: 'Cara' }),
        ],
        transactions: [transaction('t1', 'elm', 'Groceries'), transaction('t2', 'pine', 'Power')],
      },
    })
    await sendTransactionChanges(services)
    const [alice] = sent(services)
    expect(sent(services)).toHaveLength(2)
    expect(alice?.text).toContain('Someone changed 2 transactions you’re in.')
    expect(alice?.text).toContain('“Power” in Pine Rd, changed by Bobby:')
  })

  it('tells each reader only of the groups they can open', async () => {
    const services = seeded({
      activity: [
        edit(),
        edit({ groupId: 'pine', transactionId: 't2', at: '2026-10-18T18:40:00.000Z' }),
      ],
      // Alice left Pine Rd on her own, so she's no longer in its team.
      teams: { pine: ['uBob'] },
      extra: {
        groups: [
          group('elm', 'pAlice', house('Elm St')),
          group('pine', 'pAlice', house('Pine Rd')),
        ],
        members: [
          member('elm', 'pAlice', { displayName: 'Alice' }),
          member('elm', 'pBob', { displayName: 'Bob' }),
          member('elm', 'pCara', { displayName: 'Cara' }),
          member('pine', 'pAlice', { displayName: 'Alice', status: 'left', role: 'viewer' }),
          member('pine', 'pBob', { displayName: 'Bobby' }),
          member('pine', 'pCara', { displayName: 'Cara', status: 'placeholder' }),
        ],
        transactions: [transaction('t1', 'elm', 'Groceries'), transaction('t2', 'pine', 'Power')],
      },
    })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 2, failed: 0, skipped: 0 })
    for (const email of sent(services)) {
      expect(email.text).toContain('Someone changed a transaction you’re in.')
      expect(email.text).toContain('“Groceries” in Elm St, changed by Bob:')
      for (const shown of [email.text, email.html]) {
        expect(shown).not.toMatch(/Pine|Power|Bobby/)
      }
    }
  })

  it('names a changer with no member row in the group as someone', async () => {
    // Dan, a placeholder with no row in Elm St, changed it.
    const services = seeded({ activity: [edit({ actorPersonId: 'pDan' })] })
    await sendTransactionChanges(services)
    expect(sent(services)[0]?.text).toContain('“Groceries” in Elm St, changed by someone:')
  })

  it('emails only joined people with a verified account that isn’t blocked or deleted', async () => {
    const services = seeded({
      activity: [
        edit(
          {},
          {
            nets: {
              before: [...thirds(9000), { personId: 'pDan', netCents: 0 }].sort((a, b) =>
                a.personId < b.personId ? -1 : 1,
              ),
              after: thirds(12000),
            },
          },
        ),
      ],
      accounts: {
        uAlice: { email: 'alice@example.com', emailVerification: false },
        uCara: { email: 'cara@example.com', emailVerification: true, status: false },
      },
    })
    // Alice isn't verified, Cara is blocked, and Dan is a placeholder.
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
  })

  it('emails someone who moved out while they’re in the team, not someone who left', async () => {
    const membersWith = (status: 'left') => [
      member('elm', 'pAlice', { displayName: 'Alice', status, role: 'viewer' }),
      member('elm', 'pBob', { displayName: 'Bob' }),
      member('elm', 'pCara', { displayName: 'Cara', status, role: 'viewer' }),
    ]
    const services = seeded({
      teams: { elm: ['uAlice', 'uBob'] },
      extra: { members: membersWith('left') },
    })
    await sendTransactionChanges(services)
    // Alice moved out and is still in the team; Cara left on her own.
    expect(sent(services).map((email) => email.to)).toEqual(['alice@example.com'])
  })

  it('emails nobody whose account was deleted', async () => {
    const services = seeded({
      extra: {
        persons: [
          { ...person('pAlice', 'uAlice'), deletedAt: '2026-10-18T18:30:00.000Z' },
          person('pBob', 'uBob'),
          person('pCara', 'uCara'),
        ],
      },
    })
    await sendTransactionChanges(services)
    expect(sent(services).map((email) => email.to)).toEqual(['cara@example.com'])
  })

  it('emails nobody who turned it off on Profile, whatever else they turned off (#431)', async () => {
    const services = seeded({
      extra: {
        profiles: [
          { $id: 'uAlice', personId: 'pAlice', emailOptOuts: ['billDue', 'transactionChanged'] },
          { $id: 'uCara', personId: 'pCara', emailOptOuts: ['billDue', 'statementReady'] },
        ],
      },
    })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 1, failed: 0, skipped: 0 })
    // Alice turned it off. Cara turned off others, and Bob, who has no profile row, changed it.
    expect(sent(services).map((email) => email.to)).toEqual(['cara@example.com'])
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
  })

  it('sends nothing for a row with no actor or no nets', async () => {
    const services = seeded({
      activity: [
        edit({ actorPersonId: null }),
        edit({ changesJson: JSON.stringify({ description: { before: 'a', after: 'b' } }) }),
        edit({ changesJson: 'not json' }),
      ],
    })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
  })

  it('names a voided transaction as voided, and a pair by its other member', async () => {
    const services = seeded({
      activity: [
        edit(
          { action: 'transaction.voided', groupId: 'trip', transactionId: 't3' },
          {
            totalCents: undefined,
            nets: {
              before: [
                { personId: 'pAlice', netCents: 2000 },
                { personId: 'pBob', netCents: -2000 },
              ],
              after: [],
            },
          },
        ),
      ],
      extra: {
        groups: [group('trip', 'pBob', { type: 'pair', name: 'Ally' })],
        members: [
          member('trip', 'pAlice', { displayName: 'Alice' }),
          member('trip', 'pBob', { displayName: 'Bob' }),
        ],
        transactions: [transaction('t3', 'trip', 'Dinner')],
      },
    })
    await sendTransactionChanges(services)
    expect(sent(services)[0]?.text).toContain('“Dinner” in Bob, changed by Bob; it’s now voided:')
  })

  it('follows a merge, so the person merged into gets the email', async () => {
    const services = seeded({
      extra: {
        persons: [
          person('pAlice', 'uAlice'),
          person('pBob', 'uBob'),
          { ...person('pCara', null), mergedInto: 'pCarol' },
          person('pCarol', 'uCarol'),
        ],
        members: [
          member('elm', 'pAlice', { displayName: 'Alice' }),
          member('elm', 'pBob', { displayName: 'Bob' }),
          member('elm', 'pCarol', { displayName: 'Carol' }),
        ],
      },
      accounts: {
        uAlice: { email: 'alice@example.com', emailVerification: true },
        uCarol: { email: 'carol@example.com', emailVerification: true },
      },
    })
    await sendTransactionChanges(services)
    expect(sent(services).map((email) => email.to)).toEqual([
      'alice@example.com',
      'carol@example.com',
    ])
  })

  it('follows a merge two hops on', async () => {
    const services = seeded({
      extra: {
        persons: [
          person('pAlice', 'uAlice'),
          person('pBob', 'uBob'),
          { ...person('pCara', null), mergedInto: 'pCaz' },
          { ...person('pCaz', null), mergedInto: 'pCarol' },
          person('pCarol', 'uCarol'),
        ],
        members: [
          member('elm', 'pAlice', { displayName: 'Alice' }),
          member('elm', 'pBob', { displayName: 'Bob' }),
          member('elm', 'pCarol', { displayName: 'Carol' }),
        ],
      },
      accounts: {
        uAlice: { email: 'alice@example.com', emailVerification: true },
        uCarol: { email: 'carol@example.com', emailVerification: true },
      },
    })
    await sendTransactionChanges(services)
    expect(sent(services).map((email) => email.to)).toEqual([
      'alice@example.com',
      'carol@example.com',
    ])
  })

  it.each([
    ['a placeholder row there', [member('elm', 'pCarol', { status: 'placeholder' })]],
    ['no row there', []],
  ])('tells the person merged into nothing of a group where they have %s', async (_, rows) => {
    const services = seeded({
      extra: {
        persons: [
          person('pAlice', 'uAlice'),
          person('pBob', 'uBob'),
          { ...person('pCara', null), mergedInto: 'pCarol' },
          person('pCarol', 'uCarol'),
        ],
        members: [
          member('elm', 'pAlice', { displayName: 'Alice' }),
          member('elm', 'pBob', { displayName: 'Bob' }),
          member('elm', 'pCara', { displayName: 'Cara' }),
          ...rows,
        ],
      },
      accounts: {
        uAlice: { email: 'alice@example.com', emailVerification: true },
        uCarol: { email: 'carol@example.com', emailVerification: true },
      },
    })
    await sendTransactionChanges(services)
    // Carol never joined Elm St, so Cara's row there isn't hers to read through (D-016).
    expect(sent(services).map((email) => email.to)).toEqual(['alice@example.com'])
  })

  it('leaves a row on the hour to the next window', async () => {
    const services = seeded({ activity: [edit({ at: NEXT })] })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
    // The window it starts is the one that sends it.
    const onTheHour = seeded({ activity: [edit({ at: WINDOW })] })
    expect(await sendTransactionChanges(onTheHour)).toEqual({ sent: 2, failed: 0, skipped: 0 })
  })

  it('stops when another run moved the checkpoint meanwhile', async () => {
    const services = seeded({
      now: new Date('2026-10-18T21:00:00.000Z'),
      activity: [edit(), edit({ at: '2026-10-18T19:10:00.000Z' })],
    })
    services.sendEmail.mockImplementation(async () => {
      await withTransaction(services.db, (tx) =>
        tx.write({
          action: 'update',
          tableId: 'checkpoints',
          rowId: 'transaction-changes',
          data: { through: NEXT },
        }),
      )
      return { id: 'email1' }
    })
    await sendTransactionChanges(services)
    // Only the first window's two: the other run has the checkpoint now.
    expect(services.sendEmail).toHaveBeenCalledTimes(2)
    expect(through(services)).toBe(NEXT)
  })

  it('waits for a window to settle a minute', async () => {
    const services = seeded({ now: new Date('2026-10-18T19:00:30.000Z') })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(through(services)).toBe(WINDOW)
    // A minute on, to the millisecond, it's settled.
    const settled = seeded({ now: new Date('2026-10-18T19:01:00.000Z') })
    expect(await sendTransactionChanges(settled)).toEqual({ sent: 2, failed: 0, skipped: 0 })
  })

  it('makes a missing checkpoint at the start of this hour, so no backlog goes out', async () => {
    // An edit in the hour before, which a checkpoint made an hour early would send.
    const services = seeded({
      checkpoint: null,
      now: new Date('2026-10-18T20:35:00.000Z'),
      activity: [edit({ at: '2026-10-18T19:10:00.000Z' })],
    })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NOW.toISOString()))
  })

  it('takes the checkpoint another run made first', async () => {
    const services = seeded({ checkpoint: null, now: new Date('2026-10-18T20:35:00.000Z') })
    beforeCommit(services.db, () =>
      withTransaction(services.db, (tx) =>
        tx.write({
          action: 'create',
          tableId: 'checkpoints',
          rowId: 'transaction-changes',
          data: { through: WINDOW },
        }),
      ),
    )
    // The other run's checkpoint is 18:00, so this run sends that window.
    expect(await sendTransactionChanges(services)).toEqual({ sent: 2, failed: 0, skipped: 0 })
  })

  it('skips windows older than 23 hours, counted, and sends the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = seeded({
      checkpoint: '2026-10-17T18:00:00.000Z',
      activity: [edit({ at: '2026-10-17T18:10:00.000Z' }), edit()],
    })
    const counts = await sendTransactionChanges(services)
    // The windows from 17 Oct 18:00 and 19:00 ended over 23 hours ago; from 20:00 they're sent,
    // and only 18 Oct 18:00's has edits.
    expect(counts).toEqual({ sent: 2, failed: 0, skipped: 2 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
  })

  it('skips a window that ended 23 hours and 35 minutes ago, but not the next', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = seeded({
      checkpoint: '2026-10-17T20:00:00.000Z',
      now: new Date('2026-10-18T20:35:00.000Z'),
    })
    // 17 Oct 20:00–21:00 ended over 23 hours ago; 21:00–22:00 ended 22 hours 35 minutes ago.
    expect(await sendTransactionChanges(services)).toEqual({ sent: 2, failed: 0, skipped: 1 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NOW.toISOString()))
  })

  it('tries a 429 once more after Resend’s wait, then stops, leaving the window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const services = seeded()
    services.sendEmail.mockRejectedValue(
      new EmailError('Too many', 'rate_limit_exceeded', 429, 2_000),
    )
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(services.wait).toHaveBeenCalledWith(2_000)
    expect(services.sendEmail).toHaveBeenCalledTimes(2)
    expect(through(services)).toBe(WINDOW)
  })

  it('sends after one 429, with the same key', async () => {
    const services = seeded()
    services.sendEmail.mockRejectedValueOnce(new EmailError('Too many', 'rate_limit_exceeded', 429))
    expect(await sendTransactionChanges(services)).toEqual({ sent: 2, failed: 0, skipped: 0 })
    expect(services.wait).toHaveBeenCalledWith(1_000)
    const keys = services.sendEmail.mock.calls.map(([email]) => email.idempotencyKey)
    expect(keys.slice(0, 2)).toEqual([
      'txn-changes-pAlice-2026101818',
      'txn-changes-pAlice-2026101818',
    ])
  })

  it('counts an email Resend will never take as failed, and moves on', async () => {
    const services = seeded()
    services.sendEmail.mockRejectedValueOnce(new EmailError('Bad address', 'validation_error', 422))
    expect(await sendTransactionChanges(services)).toEqual({ sent: 1, failed: 1, skipped: 0 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
  })

  it('stops when out of time, leaving the window for the next run', async () => {
    const services = seeded()
    services.outOfTime = () => services.sendEmail.mock.calls.length > 0
    await sendTransactionChanges(services)
    expect(services.sendEmail).toHaveBeenCalledTimes(1)
    expect(through(services)).toBe(WINDOW)
  })

  it('stops at its own 4 minutes, though the run has time left', async () => {
    // Five windows due, each with an edit, and every clock read 30 seconds on.
    const hours = ['14', '15', '16', '17', '18']
    const services = seeded({
      checkpoint: '2026-10-18T14:00:00.000Z',
      activity: hours.map((hour) => edit({ at: `2026-10-18T${hour}:10:00.000Z` })),
    })
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 30_000))
    try {
      await sendTransactionChanges(services)
    } finally {
      now.mockRestore()
    }
    expect(services.sendEmail.mock.calls.length).toBeLessThan(2 * hours.length)
    expect(Date.parse(through(services) as string)).toBeLessThan(Date.parse(NEXT))
  })

  it('stops rather than wait past its time for a 429', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const services = seeded()
    services.sendEmail.mockRejectedValue(
      new EmailError('Too many', 'rate_limit_exceeded', 429, 999_000_000),
    )
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(services.wait).not.toHaveBeenCalled()
    expect(through(services)).toBe(WINDOW)
  })

  it('counts an email an overlapping run is sending as sent', async () => {
    const services = seeded()
    services.sendEmail.mockRejectedValueOnce(
      new EmailError('In progress', 'concurrent_idempotent_requests', 409),
    )
    expect(await sendTransactionChanges(services)).toEqual({ sent: 2, failed: 0, skipped: 0 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
  })

  it('stops on any other failure to send, leaving the window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const services = seeded()
    services.sendEmail.mockRejectedValueOnce(new EmailError('Down', 'application_error', 500))
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(through(services)).toBe(WINDOW)
  })

  it('spaces emails across windows too', async () => {
    const services = seeded({
      now: new Date('2026-10-18T21:00:00.000Z'),
      activity: [edit(), edit({ at: '2026-10-18T19:10:00.000Z', actorPersonId: 'pAlice' }, {})],
    })
    await sendTransactionChanges(services)
    // Alice and Cara for 18:00; Bob and Cara for 19:00: three waits between four emails.
    expect(services.sendEmail).toHaveBeenCalledTimes(4)
    expect(services.wait).toHaveBeenCalledTimes(3)
  })

  it('stops when time runs out while reading, before sending', async () => {
    const services = seeded()
    let read = false
    const listRows = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      read = true
      return listRows(params)
    })
    services.outOfTime = () => read
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(services.sendEmail).not.toHaveBeenCalled()
    expect(through(services)).toBe(WINDOW)
  })

  it('emails nobody whose member row is a placeholder, or who has none', async () => {
    const services = seeded({
      extra: {
        members: [
          member('elm', 'pAlice', { displayName: 'Alice', status: 'placeholder' }),
          member('elm', 'pBob', { displayName: 'Bob' }),
        ],
      },
    })
    // Alice was added and never joined; Cara was removed from the group.
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
  })

  it('passes over edits to a transaction that’s gone, and finishes the window', async () => {
    const services = seeded({ extra: { transactions: [] } })
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(Date.parse(through(services) as string)).toBe(Date.parse(NEXT))
  })

  it('folds edits in time order, whatever their IDs', async () => {
    const services = seeded({
      activity: [
        edit(
          { $id: 'z-first', at: '2026-10-18T18:10:00.000Z' },
          {
            nets: { before: thirds(9000), after: thirds(10500) },
            totalCents: { before: 9000, after: 10500 },
          },
        ),
        edit(
          { $id: 'a-second', at: '2026-10-18T18:20:00.000Z' },
          {
            nets: { before: thirds(10500), after: thirds(12000) },
            totalCents: { before: 10500, after: 12000 },
          },
        ),
      ],
    })
    await sendTransactionChanges(services)
    expect(sent(services)[0]?.text).toContain('- Total: $90.00 → $120.00')
  })

  it('folds edits made in the same moment in ID order', async () => {
    const at = '2026-10-18T18:10:00.000Z'
    const services = seeded({
      activity: [
        edit(
          { $id: 'b-second', at },
          {
            nets: { before: thirds(10500), after: thirds(12000) },
            totalCents: { before: 10500, after: 12000 },
          },
        ),
        edit(
          { $id: 'a-first', at },
          {
            nets: { before: thirds(9000), after: thirds(10500) },
            totalCents: { before: 9000, after: 10500 },
          },
        ),
      ],
    })
    await sendTransactionChanges(services)
    expect(sent(services)[0]?.text).toContain('- Total: $90.00 → $120.00')
  })

  it('stops, logging, when a read fails, and the run goes on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const services = seeded()
    vi.spyOn(services.db, 'listRows').mockRejectedValueOnce(new Error('down'))
    expect(await sendTransactionChanges(services)).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('transaction_changes_failed'))
    expect(through(services)).toBe(WINDOW)
  })
})
