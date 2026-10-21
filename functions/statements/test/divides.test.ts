import type { Statements } from '@ledgerly/core/generated/rows'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statementName } from '../src/shared'
import {
  beforeCommits,
  beforeStaging,
  call,
  commitNow,
  expectHiddenFromDan,
  type Fakes,
  failure,
  fakes,
  job,
  leftOnTheirOwn,
  member,
  NOVEMBER_CLOSE,
  NOW,
  OCTOBER_CLOSE,
  ok,
  op,
  statement,
} from './harness'

let logs: string[]
beforeEach(() => {
  logs = []
  const keep = (...parts: unknown[]) => {
    logs.push(parts.join(' '))
  }
  vi.spyOn(console, 'error').mockImplementation(keep)
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
})
afterEach(() => {
  // security-and-privacy.md: IDs and error names only, whatever the test did.
  expect(logs.join('\n')).not.toMatch(/Alice|Bob|Cara|Erin|Smith|@/)
  vi.restoreAllMocks()
})

type Row = Record<string, unknown> & { $id: string }

const SETTINGS = { type: 'house', autoFinalize: false, defaultBillSplit: 'days' }

const houseRow = (extra: object = {}): Row => ({
  $id: 'house',
  type: 'house',
  name: '12 Smith St',
  ownerPersonId: 'alice',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  statementCycle: 'monthly',
  cycleAnchor: null,
  nextCloseAt: OCTOBER_CLOSE,
  settingsJson: JSON.stringify(SETTINGS),
  archivedAt: null,
  ...extra,
})

const verified = (personId: string, address = `${personId}@example.com`, isVerified = true) => ({
  $id: `i-${address}`,
  key: `email:${address}`,
  type: 'email',
  personId,
  verified: isVerified,
  verifiedAt: isVerified ? '2026-01-01T00:00:00.000Z' : null,
})

const tx = (
  $id: string,
  date: string,
  totalCents: number,
  shares: [personId: string, given: number, received: number][],
  extra: object = {},
) => {
  const row: Row = {
    $id,
    groupId: 'house',
    kind: 'expense',
    status: 'posted',
    date,
    description: `Expense ${$id}`,
    category: null,
    totalCents,
    inputJson: '{}',
    dueOn: null,
    scheduleId: null,
    overridden: false,
    statementId: null,
    receiptFileIds: null,
    startedAt: null,
    remindedAt: null,
    voidReason: null,
    createdBy: 'alice',
    updatedBy: 'alice',
    ...extra,
  }
  return {
    transactions: [row],
    shares: shares.map(([personId, givenCents, receivedCents]) => ({
      $id: `${$id}-${personId}`,
      transactionId: $id,
      personId,
      givenCents,
      receivedCents,
      groupId: 'house',
      date,
      kind: 'expense',
      category: null,
    })),
  }
}

// September: Erin paid $3.00 for Bob, so he opens October owing her $3.00. Locked to st-sep.
const september = () =>
  tx(
    'sep1',
    '2026-09-12',
    300,
    [
      ['erin', 300, 0],
      ['bob', 0, 300],
    ],
    {
      statementId: 'st-sep',
    },
  )
// The golden divide (core's snapshot test): electricity $270, Alice paid, split by days present.
const electricity = () =>
  tx(
    'oct1',
    '2026-10-10',
    27000,
    [
      ['alice', 27000, 10139],
      ['bob', 0, 10139],
      ['cara', 0, 6722],
    ],
    { kind: 'bill', description: 'Electricity' },
  )

/** A final house snapshot whose people close on these balances (backed by locked shares). */
function finalSnapshot(period: { start: string; end: string }, closings: Record<string, number>) {
  return JSON.stringify({
    version: 1,
    group: {
      id: 'house',
      name: '12 Smith St',
      type: 'house',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
    },
    period,
    people: Object.entries(closings).map(([personId, closingCents]) => ({
      personId,
      name: personId,
      openingCents: 0,
      givenCents: Math.max(closingCents, 0),
      receivedCents: Math.max(-closingCents, 0),
      closingCents,
    })),
    lines: [],
    transfers: [],
    generatedAt: '2026-10-01T00:00:00.000Z',
  })
}

const septemberFinal = (closings: Record<string, number> = { bob: -300, erin: 300 }) =>
  statement('st-sep', {
    groupId: 'house',
    type: 'divide',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status: 'final',
    issuedOn: '2026-10-02',
    pdfFileId: 'st-sep',
    snapshotJson: finalSnapshot({ start: '2026-09-01', end: '2026-09-30' }, closings),
  })

const octoberDraft = (extra: object = {}) =>
  statement('st-oct', { groupId: 'house', type: 'divide', ...extra })

/**
 * 12 Smith St (monthly divides): Alice (admin), Bob and Cara (members) live there; Erin moved
 * out (`left`, still in the team); Pat is a placeholder; Lee left on their own. Everyone has a
 * verified email, and Bob an unverified one too. September's divide is final.
 */
function house(
  parts: { transactions?: Row[]; shares?: Row[]; statements?: Row[] }[] = [
    september(),
    electricity(),
    { statements: [septemberFinal(), octoberDraft()] },
  ],
  extra: { group?: object; members?: Row[] } = {},
): Fakes {
  const services = fakes({
    persons: [
      { $id: 'sam', userId: 'u-sam', displayName: 'Sam' },
      { $id: 'acme', userId: null, displayName: 'Acme' },
      ...['alice', 'bob', 'cara', 'dan', 'erin', 'lee'].map((id) => ({
        $id: id,
        userId: `u-${id}`,
        displayName: id,
      })),
      { $id: 'pat', userId: null, displayName: 'Pat' },
    ],
    identities: [
      verified('sam'),
      ...['alice', 'bob', 'cara', 'erin', 'pat', 'lee'].map((id) => verified(id)),
      verified('bob', 'bob-old@example.com', false),
    ],
    groups: [job(), houseRow(extra.group)],
    members: [
      member('m-sam', 'job', 'sam', 'admin'),
      member('m-acme', 'job', 'acme', 'viewer', 'placeholder'),
      member('m-alice', 'house', 'alice', 'admin'),
      member('m-bob', 'house', 'bob', 'member'),
      member('m-cara', 'house', 'cara', 'member'),
      { ...member('m-erin', 'house', 'erin', 'viewer', 'left'), leftOn: '2026-09-30' },
      member('m-pat', 'house', 'pat', 'member', 'placeholder'),
      member('m-lee', 'house', 'lee', 'viewer', 'left'),
      ...(extra.members ?? []),
    ],
    transactions: parts.flatMap((part) => part.transactions ?? []),
    shares: parts.flatMap((part) => part.shares ?? []),
    statements: parts.flatMap((part) => part.statements ?? []),
  })
  leftOnTheirOwn(services, 'u-lee')
  return services
}

const runJob = (services: Fakes) =>
  ok<{ drafted: number; failed: number }>(services, 'POST', '/', undefined, null)
const finalize = (services: Fakes, send = false, id = 'st-oct', user = 'u-alice') =>
  ok<Statements>(services, 'POST', `/statements/${id}/finalize`, { send }, user)
const discard = (services: Fakes, id = 'st-oct', user = 'u-alice') =>
  call(services, 'POST', `/statements/${id}/discard`, undefined, user)
const reissue = (services: Fakes, periodStart: string, periodEnd: string) =>
  call(
    services,
    'POST',
    '/statements/reissue',
    { groupId: 'house', periodStart, periodEnd },
    'u-alice',
  )

const row = (services: Fakes, id: string) =>
  services.db.rows('statements').find((found) => found.$id === id) as unknown as
    | Statements
    | undefined
const houseStatements = (services: Fakes) =>
  services.db.rows('statements').filter((found) => found.groupId === 'house')
const lastActivity = (services: Fakes) => services.db.rows('activity').at(-1)
const sentTo = (services: Fakes) => services.sent.map((email) => email.to)

describe('the statements job, for houses', () => {
  it('drafts a divide and an invoice in one run, and tells the house admins', async () => {
    const services = house([september(), electricity(), { statements: [septemberFinal()] }])
    expect(await runJob(services)).toEqual({ drafted: 2, failed: 0 })
    const divide = houseStatements(services).find((found) => found.$id !== 'st-sep')
    expect(divide).toMatchObject({
      type: 'divide',
      status: 'draft',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      number: null,
    })
    expect(
      services.db
        .rows('statements')
        .map((found) => found.type)
        .sort(),
    ).toEqual(['divide', 'divide', 'invoice'])
    expect(services.db.rows('groups').find((g) => g.$id === 'house')?.nextCloseAt).toBe(
      NOVEMBER_CLOSE,
    )
    const ready = services.sent.find((email) => email.subject.includes('divide'))
    expect(ready).toMatchObject({
      to: ['alice@example.com'],
      subject: 'Your October divide for 12 Smith St is ready to review',
      idempotencyKey: `ready/${divide?.$id}/alice`,
    })
  })

  it('drafts nothing for an empty period, and the next divide covers it too', async () => {
    const services = house([{ statements: [septemberFinal({})] }])
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    expect(houseStatements(services).map((found) => found.$id)).toEqual(['st-sep'])
    expect(services.sent.filter((email) => email.subject.includes('divide'))).toEqual([])
    const group = () => services.db.rows('groups').find((g) => g.$id === 'house')
    expect(group()?.nextCloseAt).toBe(NOVEMBER_CLOSE)
    // November has a line.
    await commitNow(services.db, [
      op(
        'transactions',
        'nov1',
        tx('nov1', '2026-11-05', 1000, []).transactions[0] as object,
        'create',
      ),
      op(
        'shares',
        'nov1-alice',
        {
          transactionId: 'nov1',
          personId: 'alice',
          givenCents: 1000,
          receivedCents: 500,
          groupId: 'house',
          date: '2026-11-05',
          kind: 'expense',
          category: null,
        },
        'create',
      ),
      op(
        'shares',
        'nov1-bob',
        {
          transactionId: 'nov1',
          personId: 'bob',
          givenCents: 0,
          receivedCents: 500,
          groupId: 'house',
          date: '2026-11-05',
          kind: 'expense',
          category: null,
        },
        'create',
      ),
    ])
    services.now = new Date('2026-12-01T20:00:00.000Z')
    await runJob(services)
    expect(houseStatements(services).find((found) => found.$id !== 'st-sep')).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-11-30',
    })
  })

  it('drafts a divide with no lines when someone still owes from before', async () => {
    const services = house([september(), { statements: [septemberFinal()] }])
    await runJob(services)
    const divide = houseStatements(services).find((found) => found.$id !== 'st-sep')
    expect(divide).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31' })
    const people = JSON.parse(String(divide?.snapshotJson)).people
    expect(
      people.map((p: { personId: string; openingCents: number }) => [p.personId, p.openingCents]),
    ).toEqual([
      ['bob', -300],
      ['erin', 300],
    ])
  })

  it('counts an auto-finalize of a draft an admin discarded meanwhile as no failure', async () => {
    const services = house([september(), electricity(), { statements: [septemberFinal()] }], {
      group: { settingsJson: JSON.stringify({ ...SETTINGS, autoFinalize: true }) },
    })
    const send = services.sendEmail
    services.sendEmail = async (email) => {
      // While the "ready" email goes out, Alice discards the new divide.
      const draft = houseStatements(services).find((found) => found.$id !== 'st-sep')
      if (draft && email.subject.includes('divide')) {
        await commitNow(services.db, [op('statements', draft.$id, {}, 'delete')])
      }
      return send(email)
    }
    expect(await runJob(services)).toEqual({ drafted: 2, failed: 0 })
    expect(houseStatements(services).map((found) => found.$id)).toEqual(['st-sep'])
  })

  it('finalizes a house that asks for it at once, and sends nothing', async () => {
    const services = house([september(), electricity(), { statements: [septemberFinal()] }], {
      group: { settingsJson: JSON.stringify({ ...SETTINGS, autoFinalize: true }) },
    })
    await runJob(services)
    const divide = houseStatements(services).find((found) => found.$id !== 'st-sep')
    expect(divide).toMatchObject({ status: 'final', sentAt: null, finalizedBy: null })
    // Only the "ready" emails: none of the divide itself.
    expect(services.sent.every((email) => email.subject.includes('ready to review'))).toBe(true)
    // The divide's says it's final, not to finalize it (#523).
    const ready = services.sent.find((email) => email.subject.includes('divide'))
    expect(ready?.text).toContain('has been finalized.')
    expect(ready?.text).not.toContain('Check it before you finalize it.')
  })

  it('leaves the period for the next run when a discard moved its start meanwhile', async () => {
    // October's draft exists, and the job drafts November: Alice discards October just after
    // the job read the period, so November would start on 1 November and leave October out.
    const services = house(
      [
        september(),
        electricity(),
        { statements: [septemberFinal(), octoberDraft({ status: 'draft' })] },
      ],
      { group: { nextCloseAt: NOVEMBER_CLOSE } },
    )
    services.now = new Date('2026-12-01T20:00:00.000Z')
    beforeStaging(services.db, [op('statements', 'st-oct', {}, 'delete')])
    expect((await runJob(services)).drafted).toBe(1) // the invoice only
    expect(houseStatements(services).map((found) => found.$id)).toEqual(['st-sep'])
    // The next run drafts October and November together.
    await runJob(services)
    expect(houseStatements(services).find((found) => found.$id !== 'st-sep')).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-11-30',
    })
  })
})

describe('finalizing a divide', () => {
  it('locks the period, stores the PDF and leaves the number and due date empty', async () => {
    const services = house()
    const final = await finalize(services)
    expect(final).toMatchObject({
      status: 'final',
      number: null,
      displayNumber: null,
      issuedOn: '2026-11-02',
      dueOn: null,
      pdfFileId: 'st-oct',
      finalizedBy: 'alice',
    })
    expect(services.files.stored.get('st-oct')).toMatchObject({
      name: 'divide-2026-10-31.pdf',
      permissions: ['read("team:house")'],
    })
    expect(services.db.rows('transactions').find((t) => t.$id === 'oct1')?.statementId).toBe(
      'st-oct',
    )
    expect(lastActivity(services)).toMatchObject({
      action: 'statement.finalized',
      summary: 'Divide for October finalized',
    })
    // The worker's invoice numbers aren't touched.
    expect(services.db.rows('profiles')[0]?.lastInvoiceNumber).toBe(9)
  })

  it('finishes a stopped finalize without reading or writing any profile', async () => {
    const services = house([
      september(),
      electricity(),
      { statements: [septemberFinal(), octoberDraft({ status: 'finalizing' })] },
    ])
    const getRow = vi.spyOn(services.db, 'getRow')
    expect(await finalize(services)).toMatchObject({ status: 'final', number: null })
    const tables = getRow.mock.calls.map(([params]) => params.tableId)
    expect(tables).not.toContain('profiles')
    expect(tables).not.toContain('persons')
  })

  it('finishes a stopped finalize whose rows were already locked to it', async () => {
    const lockedOct = electricity()
    lockedOct.transactions = lockedOct.transactions.map((t) => ({ ...t, statementId: 'st-oct' }))
    const services = house([
      september(),
      lockedOct,
      { statements: [septemberFinal(), octoberDraft({ status: 'finalizing' })] },
    ])
    expect(await finalize(services)).toMatchObject({ status: 'final' })
    expect(services.db.rows('transactions').find((t) => t.$id === 'oct1')?.statementId).toBe(
      'st-oct',
    )
  })

  it('never locks a row to a draft that was discarded under a run that read it as finalizing', async () => {
    // Run A's check failed, it set the statement back to draft, and Alice discarded it. Run B
    // read it while it was finalizing and goes on to lock.
    const services = house([
      september(),
      electricity(),
      { statements: [septemberFinal(), octoberDraft({ status: 'finalizing' })] },
    ])
    beforeStaging(services.db, [op('statements', 'st-oct', {}, 'delete')])
    const late = await failure(
      services,
      'POST',
      '/statements/st-oct/finalize',
      { send: false },
      'u-alice',
    )
    expect(late.code).toBe('CONFLICT')
    expect(services.db.rows('transactions').some((t) => t.statementId === 'st-oct')).toBe(false)
  })

  describe('step 4, the lock batches', () => {
    // A run resuming October's finalize: its first commit is the first lock batch.
    const resuming = () =>
      house([
        september(),
        electricity(),
        { statements: [septemberFinal(), octoberDraft({ status: 'finalizing' })] },
      ])
    const finalizeLate = (services: Fakes) =>
      failure(services, 'POST', '/statements/st-oct/finalize', { send: false }, 'u-alice')
    const lockedToOctober = (services: Fakes) =>
      services.db.rows('transactions').filter((t) => t.statementId === 'st-oct')
    // Another write in the house each time: it guards the group row too.
    const groupWrite = (time = 1) => [op('groups', 'house', { rev: `another${time}` })]

    it('locks nothing to a draft discarded between a batch’s check and its commit', async () => {
      const services = resuming()
      // The discard: the delete, with its own guard write to the group row.
      beforeCommits(services.db, [op('statements', 'st-oct', {}, 'delete'), ...groupWrite()])
      expect((await finalizeLate(services)).code).toBe('CONFLICT')
      expect(lockedToOctober(services)).toEqual([])
    })

    it('locks nothing when the statement went back to draft before the batch staged', async () => {
      const services = resuming()
      beforeStaging(services.db, [op('statements', 'st-oct', { status: 'draft' })])
      expect((await finalizeLate(services)).code).toBe('CONFLICT')
      expect(lockedToOctober(services)).toEqual([])
    })

    it('locks nothing when another run stored issuedOn before the batch staged', async () => {
      const services = resuming()
      beforeStaging(services.db, [op('statements', 'st-oct', { issuedOn: '2026-11-02' })])
      expect((await finalizeLate(services)).code).toBe('CONFLICT')
      expect(lockedToOctober(services)).toEqual([])
    })

    it('stages a batch again up to 3 times after losing its commit to another write', async () => {
      const services = resuming()
      beforeCommits(services.db, groupWrite, 3)
      expect(await finalize(services)).toMatchObject({ status: 'final' })
      expect(lockedToOctober(services).length).toBeGreaterThan(0)
    })

    it('gives up with CONFLICT after a fourth lost commit, and stays finalizing', async () => {
      const services = resuming()
      beforeCommits(services.db, groupWrite, 4)
      expect((await finalizeLate(services)).code).toBe('CONFLICT')
      expect(row(services, 'st-oct')?.status).toBe('finalizing')
    })
  })

  it('finishes a finalize stopped after the upload, with one PDF and the same issue date', async () => {
    const services = house()
    const upload = services.files.upload.bind(services.files)
    vi.spyOn(services.files, 'upload').mockImplementationOnce(async (...args) => {
      await upload(...args)
      throw new Error('timed out')
    })
    expect(
      (await failure(services, 'POST', '/statements/st-oct/finalize', { send: false }, 'u-alice'))
        .code,
    ).toBe('INTERNAL')
    expect(row(services, 'st-oct')).toMatchObject({
      status: 'finalizing',
      pdfFileId: null,
      issuedOn: '2026-11-02',
    })
    services.now = new Date('2026-11-03T20:00:00.000Z')
    expect(await finalize(services)).toMatchObject({ status: 'final', issuedOn: '2026-11-02' })
    expect(services.files.stored.size).toBe(1)
  })

  it('locks 200 transactions with no database transaction over 90 writes', async () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      tx(`t${String(index).padStart(3, '0')}`, '2026-10-15', 200, [
        ['alice', 200, 100],
        ['bob', 0, 100],
      ]),
    )
    const services = house([...many, { statements: [octoberDraft()] }])
    const stage = vi.spyOn(services.db, 'createOperations')
    await finalize(services)
    const biggest = Math.max(...stage.mock.calls.map(([params]) => params.operations?.length ?? 0))
    expect(biggest).toBeLessThanOrEqual(90)
    expect(services.db.rows('transactions').every((t) => t.statementId === 'st-oct')).toBe(true)
  })

  it('goes back to draft, renders nothing and sends nothing when the check fails', async () => {
    // September says Erin is owed $3.00, but no locked share backs that up.
    const services = house([electricity(), { statements: [septemberFinal(), octoberDraft()] }])
    const failed = await failure(
      services,
      'POST',
      '/statements/st-oct/finalize',
      { send: true },
      'u-alice',
    )
    expect(failed.code).toBe('INVARIANT_VIOLATION')
    expect(row(services, 'st-oct')).toMatchObject({ status: 'draft', pdfFileId: null })
    expect(services.db.rows('transactions').find((t) => t.$id === 'oct1')?.statementId).toBeNull()
    expect(services.files.stored.size).toBe(0)
    expect(services.sent).toEqual([])
  })

  it('refuses a member, an outsider (as a missing statement), an archived house and a later draft', async () => {
    const services = house([
      september(),
      electricity(),
      {
        statements: [
          septemberFinal(),
          octoberDraft(),
          statement('st-nov', {
            groupId: 'house',
            type: 'divide',
            periodStart: '2026-11-01',
            periodEnd: '2026-11-30',
          }),
        ],
      },
    ])
    const ask = (id: string, user: string) =>
      call(services, 'POST', `/statements/${id}/finalize`, { send: false }, user)
    expect((await ask('st-oct', 'u-bob')).status).toBe(403)
    expect(await ask('st-oct', 'u-dan')).toEqual(await ask('nope', 'u-dan'))
    expect(
      (await failure(services, 'POST', '/statements/st-nov/finalize', { send: false }, 'u-alice'))
        .code,
    ).toBe('CONFLICT')
    await commitNow(services.db, [
      op('groups', 'house', { archivedAt: NOW.toISOString(), nextCloseAt: null }),
    ])
    expect(
      (await failure(services, 'POST', '/statements/st-oct/finalize', { send: false }, 'u-alice'))
        .code,
    ).toBe('ARCHIVED')
  })
})

describe('openings', () => {
  it('opens November from October’s closings, and from September’s after October is voided', async () => {
    const november = tx('nov1', '2026-11-05', 1000, [
      ['alice', 1000, 500],
      ['bob', 0, 500],
    ])
    const services = house(
      [
        september(),
        electricity(),
        november,
        {
          statements: [
            septemberFinal(),
            octoberDraft(),
            statement('st-nov', {
              groupId: 'house',
              type: 'divide',
              periodStart: '2026-11-01',
              periodEnd: '2026-11-30',
            }),
          ],
        },
      ],
      { group: { nextCloseAt: '2026-12-31T13:00:00.000Z' } },
    )
    await finalize(services)
    const novemberFinal = await finalize(services, false, 'st-nov')
    const openings = (found: Statements) =>
      Object.fromEntries(
        JSON.parse(found.snapshotJson).people.map(
          (p: { personId: string; openingCents: number }) => [p.personId, p.openingCents],
        ),
      )
    // Erin has only her opening: she's carried forward.
    expect(openings(novemberFinal)).toEqual({ alice: 16861, bob: -10439, cara: -6722, erin: 300 })
    // Void November, then October: a redone October opens from September again.
    await ok(services, 'POST', '/statements/st-nov/void', { reason: 'Wrong' }, 'u-alice')
    await ok(services, 'POST', '/statements/st-oct/void', { reason: 'Wrong' }, 'u-alice')
    expect(lastActivity(services)).toMatchObject({
      action: 'statement.voided',
      summary: 'Divide for October voided',
    })
    const redone = await reissue(services, '2026-10-01', '2026-10-31')
    expect(redone.status).toBe(200)
    const draft = (redone.body as { ok: true; data: Statements }).data
    expect(draft.type).toBe('divide')
    expect(openings(draft)).toEqual({ alice: 0, bob: -300, cara: 0, erin: 300 })
  })

  // #354 (a'): rule 2 counts a merged person's opening as the person they were merged into even
  // where that person left on their own afterwards, since step 3 moved the locked shares to them.
  it('opens a merged person on the one they were merged into, who has since left on their own', async () => {
    // September: Erin paid $3.00 for lee-old, a placeholder later merged into Lee. Step 3 moved
    // the locked shares to Lee; in October Lee paid Erin back, then left on their own.
    const september = tx(
      'sep1',
      '2026-09-12',
      300,
      [
        ['erin', 300, 0],
        ['lee', 0, 300],
      ],
      { statementId: 'st-sep' },
    )
    const repaid = tx(
      'oct2',
      '2026-10-03',
      300,
      [
        ['lee', 300, 0],
        ['erin', 0, 300],
      ],
      { kind: 'payment', description: 'Paid back' },
    )
    const services = house([
      september,
      repaid,
      { statements: [septemberFinal({ 'lee-old': -300, erin: 300 }), octoberDraft()] },
    ])
    await commitNow(services.db, [
      op('persons', 'lee-old', { displayName: 'Lee', mergedInto: 'lee' }, 'create'),
    ])
    const final = await finalize(services)
    expect(final.status).toBe('final')
    expect(JSON.parse(final.snapshotJson).people).toMatchObject([
      { personId: 'erin', openingCents: 300, closingCents: 0 },
      { personId: 'lee', openingCents: -300, closingCents: 0 },
    ])
  })

  it('voids only the latest final divide', async () => {
    const services = house([
      september(),
      electricity(),
      { statements: [septemberFinal(), octoberDraft()] },
    ])
    await finalize(services)
    expect(
      (await failure(services, 'POST', '/statements/st-sep/void', { reason: 'Old' }, 'u-alice'))
        .code,
    ).toBe('VALIDATION_FAILED')
  })
})

describe('sending a divide', () => {
  it('emails each housemate their own figures, and nobody else’s address', async () => {
    const services = house()
    const final = await finalize(services, true)
    expect(final.sentAt).toBe(NOW.toISOString())
    // Active members and Erin, who moved out and is still owed; not Pat (placeholder) or Lee
    // (left on their own). Only verified addresses.
    expect(sentTo(services)).toEqual([
      ['alice@example.com'],
      ['bob@example.com'],
      ['cara@example.com'],
      ['erin@example.com'],
    ])
    const byPerson = Object.fromEntries(
      services.sent.map((email) => [email.idempotencyKey?.split('/').at(-1), email]),
    )
    expect(Object.keys(byPerson)).toEqual(['alice', 'bob', 'cara', 'erin'])
    expect(services.sent.map((email) => email.idempotencyKey)).toEqual(
      ['alice', 'bob', 'cara', 'erin'].map((id) => `divide/st-oct/first/${id}`),
    )
    expect(byPerson.alice?.text).toContain(
      "You're owed $168.61.\n\nBob pays you $104.39.\n\nCara pays you $64.22.",
    )
    expect(byPerson.bob?.text).toContain('You owe $104.39.\n\nPay Alice $104.39.')
    expect(byPerson.cara?.text).toContain('You owe $67.22.\n\nPay Alice $64.22.\n\nPay Erin $3.00.')
    expect(byPerson.erin?.text).toContain("You're owed $3.00.\n\nCara pays you $3.00.")
    for (const email of services.sent) {
      expect(email.subject).toBe('Your October divide for 12 Smith St')
      expect(email.replyTo).toBeUndefined()
      expect(email.attachments?.[0]?.filename).toBe('divide-2026-10-31.pdf')
      expect(email.text).toContain('https://app.example.com/groups/house/statements/st-oct')
      expect(email.html).not.toMatch(/@example\.com/)
    }
    expect(lastActivity(services)).toMatchObject({
      action: 'statement.sent',
      summary: 'Divide for October sent',
    })
  })

  it('sends nothing to someone who moved out and has nothing in the divide', async () => {
    // No September: Erin opens at 0 and has no share in October, so she isn't in `people`.
    const services = house([electricity(), { statements: [octoberDraft()] }])
    await finalize(services, true)
    expect(sentTo(services)).toEqual([
      ['alice@example.com'],
      ['bob@example.com'],
      ['cara@example.com'],
    ])
  })

  it('sends nothing to someone who moved out and then left the team', async () => {
    const services = house()
    leftOnTheirOwn(services, 'u-erin')
    await finalize(services, true)
    expect(sentTo(services)).not.toContainEqual(['erin@example.com'])
  })

  it('reuses the keys on a retry before sentAt is stored, and a resend gets new ones', async () => {
    const services = house()
    await finalize(services)
    const send = services.sendEmail
    let calls = 0
    services.sendEmail = async (email) => {
      calls += 1
      if (calls === 3) throw new Error('network')
      return send(email)
    }
    const failed = await call(services, 'POST', '/statements/st-oct/send', undefined, 'u-alice')
    expect(failed.status).toBe(500)
    expect(row(services, 'st-oct')?.sentAt).toBeNull()
    services.sendEmail = send
    const { sentAt } = await ok<{ sentAt: string }>(
      services,
      'POST',
      '/statements/st-oct/send',
      undefined,
      'u-alice',
    )
    expect(sentAt).toBe(NOW.toISOString())
    const keys = services.sent.map((email) => email.idempotencyKey)
    expect(new Set(keys)).toEqual(
      new Set(['alice', 'bob', 'cara', 'erin'].map((id) => `divide/st-oct/first/${id}`)),
    )
    services.sent.length = 0
    await ok(services, 'POST', '/statements/st-oct/send', undefined, 'u-alice')
    expect(services.sent.map((email) => email.idempotencyKey)).toEqual(
      ['alice', 'bob', 'cara', 'erin'].map((id) => `divide/st-oct/${sentAt}/${id}`),
    )
  })

  it('refuses a draft, a member, and a house with nobody verified', async () => {
    const services = house()
    expect(
      (await failure(services, 'POST', '/statements/st-oct/send', undefined, 'u-alice')).code,
    ).toBe('VALIDATION_FAILED')
    await finalize(services)
    expect(
      (await failure(services, 'POST', '/statements/st-oct/send', undefined, 'u-bob')).code,
    ).toBe('FORBIDDEN')
    await commitNow(
      services.db,
      services.db
        .rows('identities')
        .filter((i) => i.personId !== 'sam')
        .map((i) => op('identities', i.$id, { verified: false })),
    )
    const nobody = await failure(services, 'POST', '/statements/st-oct/send', undefined, 'u-alice')
    expect(nobody.code).toBe('VALIDATION_FAILED')
    expect(row(services, 'st-oct')?.sentAt).toBeNull()
  })

  it('sends to 15 housemates a few at a time', async () => {
    const extra = Array.from({ length: 12 }, (_, index) => `h${String(index).padStart(2, '0')}`)
    const services = house(undefined, {
      members: extra.map((id) => member(`m-${id}`, 'house', id, 'member')),
    })
    await commitNow(services.db, [
      ...extra.map((id) => op('persons', id, { userId: `u-${id}`, displayName: id }, 'create')),
      ...extra.map((id) =>
        op(
          'identities',
          `i-${id}`,
          {
            key: `email:${id}@example.com`,
            type: 'email',
            personId: id,
            verified: true,
            verifiedAt: '2026-01-01T00:00:00.000Z',
          },
          'create',
        ),
      ),
    ])
    await finalize(services)
    const send = services.sendEmail
    let inFlight = 0
    let most = 0
    services.sendEmail = async (email) => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return send(email)
    }
    await ok(services, 'POST', '/statements/st-oct/send', undefined, 'u-alice')
    // Alice, Bob, Cara, Erin and 12 more (Erin moved out): 16 emails, at most 5 at once.
    expect(services.sent).toHaveLength(16)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(5)
  })
})

describe('POST /statements/{id}/discard', () => {
  it('deletes the draft, guards the group, records it and leaves nextCloseAt alone', async () => {
    const services = house()
    const before = services.db.rows('groups').find((g) => g.$id === 'house')
    const response = await discard(services)
    expect(response).toEqual({ status: 200, body: { ok: true, data: {} } })
    expect(row(services, 'st-oct')).toBeUndefined()
    const after = services.db.rows('groups').find((g) => g.$id === 'house')
    expect(after?.nextCloseAt).toBe(before?.nextCloseAt)
    expect(after?.rev).not.toBe(before?.rev)
    expect(lastActivity(services)).toMatchObject({
      action: 'statement.discarded',
      actorPersonId: 'alice',
      summary: 'Divide for October discarded',
    })
    // Calling it again: done already.
    expect((await discard(services)).status).toBe(404)
  })

  it('discards an invoice draft that has no number yet', async () => {
    const services = house([{ statements: [statement('st-inv')] }])
    expect((await discard(services, 'st-inv', 'u-sam')).status).toBe(200)
    expect(lastActivity(services)?.summary).toBe('Invoice draft for October discarded')
  })

  it('takes off locks a stopped finalize left on the draft', async () => {
    const services = house([
      september(),
      tx(
        'oct1',
        '2026-10-10',
        1000,
        [
          ['alice', 1000, 500],
          ['bob', 0, 500],
        ],
        { statementId: 'st-oct' },
      ),
      { statements: [septemberFinal(), octoberDraft()] },
    ])
    expect((await discard(services)).status).toBe(200)
    expect(services.db.rows('transactions').find((t) => t.$id === 'oct1')?.statementId).toBeNull()
  })

  it.each([
    ['a member', 'st-oct', 'u-bob', 'FORBIDDEN'],
    ['a finalizing statement', 'st-fin', 'u-alice', 'CONFLICT'],
    ['a final statement', 'st-sep', 'u-alice', 'VALIDATION_FAILED'],
    ['a void statement', 'st-void', 'u-alice', 'VALIDATION_FAILED'],
    ['an invoice draft with its number', 'st-num', 'u-sam', 'VALIDATION_FAILED'],
  ])('refuses %s', async (_case, id, user, code) => {
    const services = house([
      september(),
      electricity(),
      {
        statements: [
          septemberFinal(),
          octoberDraft(),
          statement('st-fin', {
            groupId: 'house',
            type: 'divide',
            status: 'finalizing',
            periodStart: '2026-11-01',
            periodEnd: '2026-11-30',
          }),
          statement('st-void', {
            groupId: 'house',
            type: 'divide',
            status: 'void',
            periodStart: '2026-08-01',
            periodEnd: '2026-08-31',
          }),
          statement('st-num', { number: 10, displayNumber: 'INV-0010' }),
        ],
      },
    ])
    const before = services.db.rows('statements')
    const refused = await call(services, 'POST', `/statements/${id}/discard`, undefined, user)
    expect(refused.body).toMatchObject({ ok: false, error: { code } })
    expect(services.db.rows('statements')).toEqual(before)
  })

  it('answers an outsider as for a missing statement, and an archived house with ARCHIVED', async () => {
    const services = house([
      september(),
      electricity(),
      {
        statements: [
          septemberFinal(),
          octoberDraft(),
          statement('st-fin', {
            groupId: 'house',
            type: 'divide',
            status: 'finalizing',
            periodStart: '2026-11-01',
            periodEnd: '2026-11-30',
          }),
          statement('st-void', {
            groupId: 'house',
            type: 'divide',
            status: 'void',
            periodStart: '2026-08-01',
            periodEnd: '2026-08-31',
          }),
        ],
      },
    ])
    // Statements discard would refuse too, so no check on the statement comes first.
    await expectHiddenFromDan(services, 'discard', ['st-oct', 'st-sep', 'st-fin', 'st-void'])
    await commitNow(services.db, [op('groups', 'house', { archivedAt: NOW.toISOString() })])
    expect((await discard(services)).body).toMatchObject({ error: { code: 'ARCHIVED' } })
    expect(row(services, 'st-oct')).toBeDefined()
  })

  it('refuses a viewer, to finalize or discard', async () => {
    const services = house()
    await commitNow(services.db, [op('members', 'm-bob', { role: 'viewer' })])
    const finalizing = await failure(
      services,
      'POST',
      '/statements/st-oct/finalize',
      { send: false },
      'u-bob',
    )
    expect(finalizing.code).toBe('FORBIDDEN')
    expect((await discard(services, 'st-oct', 'u-bob')).body).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
  })

  it('refuses when a lock lands on the draft just before it stages', async () => {
    const services = house()
    beforeStaging(services.db, [op('transactions', 'oct1', { statementId: 'st-oct' })])
    expect((await discard(services)).body).toMatchObject({ error: { code: 'CONFLICT' } })
    expect(row(services, 'st-oct')).toBeDefined()
  })

  it('refuses a body', async () => {
    const services = house()
    const response = await call(
      services,
      'POST',
      '/statements/st-oct/discard',
      { force: true },
      'u-alice',
    )
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  it('loses to a finalize that starts first', async () => {
    const services = house()
    beforeStaging(services.db, [
      op('statements', 'st-oct', { status: 'finalizing' }),
      op('groups', 'house', { rev: 'other' }),
    ])
    expect((await discard(services)).body).toMatchObject({ error: { code: 'CONFLICT' } })
    expect(row(services, 'st-oct')?.status).toBe('finalizing')
  })

  it('wins against a finalize that starts after it, which then finds nothing', async () => {
    const services = house()
    beforeStaging(services.db, [op('statements', 'st-oct', {}, 'delete')])
    const finalizing = await failure(
      services,
      'POST',
      '/statements/st-oct/finalize',
      { send: false },
      'u-alice',
    )
    expect(['CONFLICT', 'NOT_FOUND']).toContain(finalizing.code)
    expect(services.db.rows('transactions').some((t) => t.statementId === 'st-oct')).toBe(false)
  })

  it('refuses when a finalize numbered the invoice draft meanwhile', async () => {
    const services = house([{ statements: [statement('st-inv')] }])
    beforeStaging(services.db, [
      op('statements', 'st-inv', { number: 10, displayNumber: 'INV-0010' }),
    ])
    expect((await discard(services, 'st-inv', 'u-sam')).body).toMatchObject({
      error: { code: 'CONFLICT' },
    })
    expect(row(services, 'st-inv')?.number).toBe(10)
  })

  it('rolls the latest draft’s period into the next one, so its range can’t be reissued', async () => {
    const services = house(undefined, { group: { nextCloseAt: NOVEMBER_CLOSE } })
    expect((await discard(services)).status).toBe(200)
    const again = await reissue(services, '2026-10-01', '2026-10-31')
    expect(again.body).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.stringContaining('hasn’t been drafted yet'),
      },
    })
    services.now = new Date('2026-12-01T20:00:00.000Z')
    await runJob(services)
    expect(houseStatements(services).find((found) => found.$id !== 'st-sep')).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-11-30',
    })
  })

  it('lets the range be reissued when the discarded draft was the group’s only statement', async () => {
    const services = house([electricity(), { statements: [octoberDraft()] }], {
      group: { nextCloseAt: NOVEMBER_CLOSE },
    })
    expect((await discard(services)).status).toBe(200)
    expect((await reissue(services, '2026-10-01', '2026-10-31')).status).toBe(200)
  })

  it('leaves the boundaries alone when a reissue of a void statement’s range is discarded, so it can be reissued again', async () => {
    const voided = { ...septemberFinal(), status: 'void' }
    const services = house([
      {
        ...september(),
        transactions: september().transactions.map((t) => ({ ...t, statementId: null })),
      },
      electricity(),
      { statements: [voided] },
    ])
    const first = await reissue(services, '2026-09-01', '2026-09-30')
    expect(first.status).toBe(200)
    const draft = (first.body as { ok: true; data: Statements }).data
    expect(draft.type).toBe('divide')
    expect((await discard(services, draft.$id)).status).toBe(200)
    expect((await reissue(services, '2026-09-01', '2026-09-30')).status).toBe(200)
  })
})

describe('statementName', () => {
  it('names a statement with no number by its period, and a part of a month by its days', () => {
    const named = (extra: Partial<Statements>) =>
      statementName({
        type: 'divide',
        displayNumber: null,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        ...extra,
      })
    expect(named({})).toBe('Divide for October')
    expect(named({ periodEnd: '2026-10-14' })).toBe('Divide for 1–14 October')
    expect(named({ type: 'invoice' })).toBe('Invoice draft for October')
    expect(named({ type: 'invoice', displayNumber: 'INV-0010' })).toBe('Invoice INV-0010')
  })
})
