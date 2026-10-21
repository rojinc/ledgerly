import type { Statements } from '@ledgerly/core/generated/rows'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acmeJoins,
  archiveJob,
  BUSINESS,
  beforeStaging,
  commitNow,
  expectHiddenFromDan,
  failure,
  fakes,
  job,
  member,
  NOW,
  ok,
  op,
  payment,
  rowsOf,
  samProfile,
  shift,
  snapshotClosing,
  statement,
} from './harness'

let errors: string[]
beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.push(line)
  })
})
afterEach(() => vi.restoreAllMocks())

type Services = ReturnType<typeof fakes>

// October: Sam worked 4 hours ($100.00), Acme paid $30.00; a November shift isn't in it.
const october = () =>
  rowsOf(
    shift('s1', '2026-10-02', 240),
    payment('p1', '2026-10-15', 3000),
    shift('s2', '2026-11-03', 60),
    { statements: [statement('st1')] },
  )

// September's final invoice says Acme owes $50.00, but no locked share backs that up, so
// finalizing October's s1 fails its check.
const failingCheck = (extra: Parameters<typeof fakes>[0] = {}) =>
  fakes({
    ...rowsOf(shift('s1', '2026-10-02', 240), {
      statements: [
        statement('st-sep', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'final',
          snapshotJson: snapshotClosing(
            { start: '2026-09-01', end: '2026-09-30' },
            { acme: -5000, sam: 5000 },
          ),
        }),
        statement('st1'),
      ],
    }),
    ...extra,
  })

// Acme's shares in `part` name acme-old instead: a merge hasn't moved them yet.
const asOld = (part: ReturnType<typeof shift>) => ({
  ...part,
  shares: part.shares.map((row) =>
    row.personId === 'acme' ? { ...row, personId: 'acme-old' } : row,
  ),
})

/** The person IDs each `persons` list read asks for. */
function personReads(services: Services): string[][] {
  const reads: string[][] = []
  const list = services.db.listRows.bind(services.db)
  vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
    if (params.tableId === 'persons') {
      const byId = (params.queries ?? []).map((query) => JSON.parse(query))
      reads.push(
        ...byId
          .filter((query) => query.method === 'equal' && query.attribute === '$id')
          .map((query) => query.values),
      )
    }
    return list(params)
  })
  return reads
}

const finalize = (services: Services, send = false, id = 'st1', user = 'u-sam') =>
  ok<Statements>(services, 'POST', `/statements/${id}/finalize`, { send }, user)

const stored = (services: Services, id = 'st1') =>
  services.db.rows('statements').find((row) => row.$id === id) as unknown as Statements
const locks = (services: Services) =>
  Object.fromEntries(services.db.rows('transactions').map((row) => [row.$id, row.statementId]))
const lastNumber = (services: Services) => services.db.rows('profiles')[0]?.lastInvoiceNumber

// When Sam, the worker, deleted their account (#503, #519), and how finalize refuses then.
const DELETED_AT = '2026-11-01T00:00:00.000Z'
const REFUSAL = {
  code: 'CONFLICT',
  message: 'The worker has deleted their account, so this invoice can’t be finalized.',
}

/** Commits `operations` just before the first transaction whose writes include `text` commits. */
function beforeCommitOf(services: Services, text: string, operations: object[]) {
  const stage = services.db.createOperations.bind(services.db)
  const commit = services.db.updateTransaction.bind(services.db)
  let target: string | undefined
  vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
    if (target === undefined && JSON.stringify(params.operations).includes(text)) {
      target = params.transactionId
    }
    return stage(params)
  })
  vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
    if (params.commit && params.transactionId === target) {
      target = ''
      await commitNow(services.db, operations)
    }
    return commit(params)
  })
}

describe('POST /statements/{id}/finalize', () => {
  it('numbers the invoice, locks what it covers, stores the PDF and marks it final', async () => {
    const services = fakes(october())
    const final = await finalize(services)
    expect(final).toMatchObject({
      status: 'final',
      number: 10,
      displayNumber: 'INV-0010',
      // 07:00 on 2 November in Sydney; 14 days' terms.
      issuedOn: '2026-11-02',
      dueOn: '2026-11-16',
      pdfFileId: 'st1',
      finalizedBy: 'sam',
      sentAt: null,
    })
    expect(stored(services)).toMatchObject(final)
    expect(lastNumber(services)).toBe(10)
    expect(locks(services)).toEqual({ s1: 'st1', p1: 'st1', s2: null })
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.invoice).toEqual({
      balanceDueCents: 7000,
      paymentTermsDays: 14,
      dueOn: '2026-11-16',
    })
    const pdf = services.files.stored.get('st1')
    expect(pdf).toMatchObject({ name: 'INV-0010.pdf', permissions: ['read("team:job")'] })
    expect(
      Buffer.from(pdf?.content ?? [])
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-')
    expect(services.db.rows('activity')).toMatchObject([
      {
        actorPersonId: 'sam',
        action: 'statement.finalized',
        summary: 'Invoice INV-0010 finalized',
      },
    ])
    expect(services.sent).toEqual([])
  })

  it('leaves out the business details today’s rules refuse, and says which once it’s stored (#543)', async () => {
    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      warnings.push(line)
    })
    const odd = {
      ...BUSINESS,
      abn: 'not-an-abn',
      bank: { ...BUSINESS.bank, bsb: '12' },
      phone: null,
    }
    const services = fakes({ ...october(), profiles: [samProfile(JSON.stringify(odd))] })
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.issuer?.business).toEqual({
      ...BUSINESS,
      abn: undefined,
      phone: undefined,
      bank: undefined,
    })
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        event: 'invoice_business_dropped',
        groupId: 'job',
        statementId: 'st1',
        businessFields: ['abn', 'phone', 'bank'],
      }),
    ])
    // Field names only: never a value, the ones left out included.
    expect(warnings.join()).not.toMatch(/not-an-abn|Sam Lee|062000/)
    expect(errors).toEqual([])
  })

  it.each([
    ['doesn’t parse', '{'],
    ['is a list', '["Sam Cleans"]'],
    ['is text', '"Sam Cleans"'],
    ['is null', 'null'],
  ])('names the JSON when the stored details %s (#543)', async (_case, businessJson) => {
    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      warnings.push(line)
    })
    const final = await finalize(fakes({ ...october(), profiles: [samProfile(businessJson)] }))
    expect((JSON.parse(final.snapshotJson) as StatementSnapshot).issuer?.business).toEqual({})
    expect(warnings.map((line) => JSON.parse(line).businessFields)).toEqual([['json']])
  })

  it('says nothing about business details when they all read, or there are none (#543)', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await finalize(fakes(october()))
    await finalize(fakes({ ...october(), profiles: [samProfile(null)] }))
    await finalize(fakes({ ...october(), profiles: [samProfile('')] }))
    expect(warnings).not.toHaveBeenCalled()
  })

  it('says nothing about business details when its check fails and it goes back to draft (#543)', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = failingCheck({ profiles: [samProfile('{')] })
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('INVARIANT_VIOLATION')
    expect(warnings).not.toHaveBeenCalled()
  })

  it('stages the group row with the finalizing status, for the ledger (ledger.md#concurrency)', async () => {
    const services = fakes(october())
    const stage = vi.spyOn(services.db, 'createOperations')
    await finalize(services)
    expect(stage.mock.calls[0]?.[0].operations).toEqual([
      expect.objectContaining({
        tableId: 'statements',
        rowId: 'st1',
        data: { status: 'finalizing' },
      }),
      expect.objectContaining({
        tableId: 'groups',
        rowId: 'job',
        data: { rev: expect.stringMatching(/^[a-z0-9]{20}$/) },
      }),
    ])
  })

  it('fails a ledger write staged before it once finalizing commits (ledger.md#concurrency)', async () => {
    const services = fakes(october())
    // The ledger's group guard, staged by a write that checked for finalizing statements first.
    const { $id } = await services.db.createTransaction()
    await services.db.createOperations({
      transactionId: $id,
      operations: [op('groups', 'job', { rev: 'ledgerguard000000000' })],
    })
    await finalize(services)
    await expect(
      services.db.updateTransaction({ transactionId: $id, commit: true }),
    ).rejects.toMatchObject({
      code: 409,
    })
  })

  it('gives the same result when finalized twice, numbering and uploading once', async () => {
    const services = fakes(october())
    const upload = vi.spyOn(services.files, 'upload')
    const first = await finalize(services)
    const again = await finalize(services)
    expect(again).toEqual(first)
    expect(lastNumber(services)).toBe(10)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(services.db.rows('activity')).toHaveLength(1)
  })

  it('goes on after an interruption at the lock step, and numbers only once', async () => {
    // 95 shifts: locking takes two batches of 89 locks and a guard write to the group row.
    const shifts = Array.from({ length: 95 }, (_, index) =>
      shift(`s${String(index).padStart(3, '0')}`, '2026-10-10', 60),
    )
    const services = fakes(rowsOf(...shifts, { statements: [statement('st1')] }))
    const commit = services.db.updateTransaction.bind(services.db)
    let commits = 0
    vi.spyOn(services.db, 'updateTransaction').mockImplementation(async (params) => {
      // Commits: 1 finalizing, 2 the number, 3 and 4 the lock batches.
      if (params.commit && ++commits === 4) throw new Error('The function was stopped')
      return commit(params)
    })
    expect(
      (await failure(services, 'POST', '/statements/st1/finalize', { send: false })).code,
    ).toBe('INTERNAL')
    expect(stored(services)).toMatchObject({ status: 'finalizing', number: 10 })
    expect(Object.values(locks(services)).filter((lock) => lock === 'st1')).toHaveLength(89)

    const final = await finalize(services)
    expect(final).toMatchObject({ status: 'final', number: 10, displayNumber: 'INV-0010' })
    expect(lastNumber(services)).toBe(10)
    expect(Object.values(locks(services)).every((lock) => lock === 'st1')).toBe(true)
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.lines).toHaveLength(95)
    expect(snapshot.invoice?.balanceDueCents).toBe(95 * 2500)
  })

  it('keeps the first issue date when an interrupted finalize runs again the next day', async () => {
    const services = fakes(october())
    vi.spyOn(services.files, 'upload').mockRejectedValueOnce(new Error('Storage is down'))
    await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(stored(services)).toMatchObject({
      status: 'finalizing',
      issuedOn: '2026-11-02',
      pdfFileId: null,
    })
    services.now = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)
    const final = await finalize(services)
    expect(final).toMatchObject({ status: 'final', issuedOn: '2026-11-02', dueOn: '2026-11-16' })
    expect(services.files.stored.has('st1')).toBe(true)
  })

  it('opens from merged persons’ closings and passes its check after a merge (#39)', async () => {
    // September named two old placeholders for Acme, merged one into the other and then into
    // acme. Their member rows and locked shares are acme's now (identity-and-invites.md).
    const services = fakes(
      rowsOf(
        shift('s0', '2026-09-10', 120, { statementId: 'st-sep' }),
        shift('s1', '2026-10-02', 240),
        {
          statements: [
            statement('st-sep', {
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'final',
              snapshotJson: snapshotClosing(
                { start: '2026-09-01', end: '2026-09-30' },
                { 'acme-older': -2000, 'acme-old': -3000, sam: 5000 },
              ),
            }),
            statement('st1'),
          ],
        },
      ),
    )
    await commitNow(services.db, [
      op('persons', 'acme-old', { displayName: 'Acme', mergedInto: 'acme' }, 'create'),
      op('persons', 'acme-older', { displayName: 'Acme', mergedInto: 'acme-old' }, 'create'),
    ])
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.people).toMatchObject([
      { personId: 'acme', openingCents: -5000, closingCents: -15000 },
      { personId: 'sam', openingCents: 5000, closingCents: 15000 },
    ])
    expect(errors).toEqual([])
  })

  it('follows a closing’s merge chain one read at a time, reading only people with no member row (#39)', async () => {
    // September's closing names only acme-older, merged into acme-old, then into acme.
    const services = fakes(
      rowsOf(
        shift('s0', '2026-09-10', 120, { statementId: 'st-sep' }),
        shift('s1', '2026-10-02', 240),
        {
          statements: [
            statement('st-sep', {
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'final',
              snapshotJson: snapshotClosing(
                { start: '2026-09-01', end: '2026-09-30' },
                { 'acme-older': -5000, sam: 5000 },
              ),
            }),
            statement('st1'),
          ],
        },
      ),
    )
    await commitNow(services.db, [
      op('persons', 'acme-old', { displayName: 'Acme', mergedInto: 'acme' }, 'create'),
      op('persons', 'acme-older', { displayName: 'Acme', mergedInto: 'acme-old' }, 'create'),
    ])
    const reads = personReads(services)
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.people).toMatchObject([
      { personId: 'acme', openingCents: -5000, closingCents: -15000 },
      { personId: 'sam', openingCents: 5000, closingCents: 15000 },
    ])
    expect(reads).toEqual([['acme-older'], ['acme-old']])
    expect(errors).toEqual([])
  })

  it('adds up when it runs between merge batches, before old shares are moved (#39)', async () => {
    // Step 2 gave acme-old's member row to acme, but step 3 hasn't moved its shares yet: the
    // locked September shift and the October one still name acme-old (statements.md rule 2).
    const services = fakes(
      rowsOf(
        asOld(shift('s0', '2026-09-10', 120, { statementId: 'st-sep' })),
        asOld(shift('s1', '2026-10-02', 240)),
        payment('p1', '2026-10-15', 3000),
        {
          statements: [
            statement('st-sep', {
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'final',
              snapshotJson: snapshotClosing(
                { start: '2026-09-01', end: '2026-09-30' },
                { 'acme-old': -5000, sam: 5000 },
              ),
            }),
            statement('st1'),
          ],
        },
      ),
    )
    await commitNow(services.db, [
      op('persons', 'acme-old', { displayName: 'Acme', mergedInto: 'acme' }, 'create'),
    ])
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.people).toMatchObject([
      { personId: 'acme', openingCents: -5000, givenCents: 3000, closingCents: -12000 },
      { personId: 'sam', openingCents: 5000, closingCents: 12000 },
    ])
    expect(snapshot.lines.find((line) => line.transactionId === 's1')?.shares).toEqual([
      { personId: 'acme', givenCents: 0, receivedCents: 10000 },
      { personId: 'sam', givenCents: 10000, receivedCents: 0 },
    ])
    expect(errors).toEqual([])
  })

  it('checks against the member rows its snapshot used when a merge deletes one meanwhile (#39)', async () => {
    // acme-old is merged into acme, but step 2 hasn't reached this group: both have member
    // rows, so the snapshot keeps them apart. Step 2 deletes acme-old's row while the
    // transactions are being locked, and the check still counts acme-old on their own.
    const services = fakes(
      rowsOf(asOld(shift('s1', '2026-10-02', 240)), payment('p1', '2026-10-15', 3000), {
        statements: [statement('st1')],
      }),
    )
    const { $id, ...oldRow } = member('m-acme-old', 'job', 'acme-old', 'viewer', 'placeholder')
    await commitNow(services.db, [
      op('persons', 'acme-old', { displayName: 'Acme', mergedInto: 'acme' }, 'create'),
      op('members', $id, oldRow, 'create'),
    ])
    // This run's stagings: 1 finalizing, 2 the number, 3 the lock batch.
    beforeStaging(services.db, [op('members', 'm-acme-old', {}, 'delete')], 3)
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.people).toMatchObject([
      { personId: 'acme', givenCents: 3000, closingCents: 3000 },
      { personId: 'acme-old', receivedCents: 10000, closingCents: -10000 },
      { personId: 'sam', closingCents: 7000 },
    ])
    expect(errors).toEqual([])
  })

  it('refuses with ARCHIVED when an archive commits before step 1 is staged (#190)', async () => {
    const services = fakes(october())
    // The archive lands after the request read the group, just before step 1 stages.
    beforeStaging(services.db, [
      op('groups', 'job', { archivedAt: '2026-11-01T00:00:00.000Z', nextCloseAt: null }),
    ])
    expect(
      await failure(services, 'POST', '/statements/st1/finalize', { send: false }, 'u-sam'),
    ).toMatchObject({ status: 409, code: 'ARCHIVED' })
    expect(stored(services)).toMatchObject({ status: 'draft' })
    expect(lastNumber(services)).toBe(9)
  })

  it('unlocks everything and goes back to draft when the check fails', async () => {
    // September's final invoice says Acme owes $50.00, but no locked share backs that up.
    const services = fakes(
      rowsOf(shift('s1', '2026-10-02', 240), {
        statements: [
          statement('st-sep', {
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            status: 'final',
            snapshotJson: snapshotClosing(
              { start: '2026-09-01', end: '2026-09-30' },
              { acme: -5000, sam: 5000 },
            ),
          }),
          statement('st1'),
        ],
      }),
    )
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('INVARIANT_VIOLATION')
    expect(stored(services)).toMatchObject({ status: 'draft', number: 10, issuedOn: null })
    expect(locks(services)).toEqual({ s1: null })
    expect(services.files.stored.size).toBe(0)
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      { fn: 'unknown', event: 'snapshot_check_failed', statementId: 'st1', problems: ['fresh'] },
    ])
  })

  it('goes back to draft, unlocked, when the schema refuses its snapshot (#549)', async () => {
    // A currency an older rule allowed: the snapshot copies it, and no read could parse it back.
    const services = fakes({ ...october(), groups: [job({}, { currency: 'aud' })] })
    const draft = stored(services).snapshotJson
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: true })
    expect(response.code).toBe('INVARIANT_VIOLATION')
    expect(stored(services)).toMatchObject({
      status: 'draft',
      number: 10,
      issuedOn: null,
      dueOn: null,
      pdfFileId: null,
      sentAt: null,
      snapshotJson: draft,
    })
    expect(locks(services)).toEqual({ s1: null, p1: null, s2: null })
    expect(services.files.stored.size).toBe(0)
    expect(services.sent).toEqual([])
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      { fn: 'unknown', event: 'snapshot_check_failed', statementId: 'st1', problems: ['schema'] },
    ])
  })

  it('takes the next number when another invoice took this one meanwhile', async () => {
    const services = fakes(october())
    const stage = services.db.createOperations.bind(services.db)
    let stagings = 0
    vi.spyOn(services.db, 'createOperations').mockImplementation(async (params) => {
      // The second staging is the number: another finalize for Sam commits 10 just before.
      if (++stagings === 2) {
        const { $id } = await services.db.createTransaction()
        await stage({
          transactionId: $id,
          operations: [
            {
              action: 'update',
              databaseId: 'main',
              tableId: 'profiles',
              rowId: 'u-sam',
              data: { lastInvoiceNumber: 10 },
            },
          ],
        })
        await services.db.updateTransaction({ transactionId: $id, commit: true })
      }
      return stage(params)
    })
    expect(
      (await failure(services, 'POST', '/statements/st1/finalize', { send: false })).code,
    ).toBe('CONFLICT')
    expect(stored(services)).toMatchObject({ status: 'finalizing', number: null })
    expect((await finalize(services)).displayNumber).toBe('INV-0011')
    expect(lastNumber(services)).toBe(11)
  })

  it('finalizes only the oldest unfinished statement of the group', async () => {
    const services = fakes({
      statements: [
        statement('st1'),
        statement('st2', { periodStart: '2026-11-01', periodEnd: '2026-11-30' }),
      ],
    })
    expect(
      (await failure(services, 'POST', '/statements/st2/finalize', { send: false })).code,
    ).toBe('CONFLICT')
    expect(stored(services, 'st2').status).toBe('draft')
  })

  it('refuses a void statement', async () => {
    const services = fakes({ statements: [statement('st1', { status: 'void' })] })
    expect(
      (await failure(services, 'POST', '/statements/st1/finalize', { send: false })).code,
    ).toBe('VALIDATION_FAILED')
  })

  it('answers someone outside the group as for a missing statement; a viewer gets FORBIDDEN and an admin ARCHIVED', async () => {
    const services = fakes({
      statements: [
        statement('st1'),
        statement('st-void', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'void',
        }),
      ],
    })
    const body = { send: false }
    await expectHiddenFromDan(services, 'finalize', ['st1', 'st-void'], body)
    await acmeJoins(services)
    expect((await failure(services, 'POST', '/statements/st1/finalize', body, 'u-acme')).code).toBe(
      'FORBIDDEN',
    )
    await archiveJob(services)
    await expectHiddenFromDan(services, 'finalize', ['st1'], body)
    expect((await failure(services, 'POST', '/statements/st1/finalize', body)).code).toBe(
      'ARCHIVED',
    )
    expect(stored(services).status).toBe('draft')
  })

  // Sam, the worker, is deleting their account: past its point of no return (`deletedAt`), but
  // before step 6 clears `userId` (#503, #519). Acme joined, and was made admin.
  async function workerDeleted(services: Services) {
    await acmeJoins(services)
    await commitNow(services.db, [
      op('members', 'm-acme', { role: 'admin' }),
      op('persons', 'sam', { deletedAt: DELETED_AT }),
    ])
  }

  it.each([
    ['a draft', 'draft'],
    ['a resume', 'finalizing'],
  ])(
    'refuses %s of an invoice whose worker has deleted their account, changing nothing (#503)',
    async (_, status) => {
      const services = fakes(
        rowsOf(shift('s1', '2026-10-02', 240), { statements: [statement('st1', { status })] }),
      )
      await workerDeleted(services)
      const before = stored(services)
      const refused = await failure(
        services,
        'POST',
        '/statements/st1/finalize',
        { send: false },
        'u-acme',
      )
      expect(refused).toMatchObject(REFUSAL)
      expect(stored(services)).toEqual(before)
      expect(lastNumber(services)).toBe(9)
      expect(locks(services)).toEqual({ s1: null })
      expect(services.db.rows('activity')).toEqual([])
    },
  )

  it.each([
    // Just after the first check, before step 1 stages.
    ['before it numbers it', [op('persons', 'sam', { deletedAt: DELETED_AT })], 1],
    // Their deletion's step 5 deletes the profile.
    ['with their profile gone', [op('profiles', 'u-sam', {}, 'delete')], 1],
    // After step 2's own read, just before it stages: only its check after staging sees it.
    ['after its own read', [op('persons', 'sam', { deletedAt: DELETED_AT })], 2],
  ])(
    'checks the issuer again at step 2, %s: CONFLICT, finalizing and unnumbered (#519)',
    async (_, change, nth) => {
      const services = fakes(october())
      beforeStaging(services.db, change, nth)
      expect(
        await failure(services, 'POST', '/statements/st1/finalize', { send: false }),
      ).toMatchObject({ status: 409, ...REFUSAL })
      expect(stored(services)).toMatchObject({ status: 'finalizing', number: null })
    },
  )

  it('checks the issuer again at step 6: CONFLICT, finalizing and never issued (#519)', async () => {
    // With details a rule refuses: nothing is stored, so nothing is said about them (#543).
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = fakes({ ...october(), profiles: [samProfile('{')] })
    // Their deletion lands after step 2 numbered it, before step 4 locks.
    beforeStaging(services.db, [op('persons', 'sam', { deletedAt: DELETED_AT })], 3)
    expect(
      await failure(services, 'POST', '/statements/st1/finalize', { send: false }),
    ).toMatchObject({ status: 409, ...REFUSAL })
    expect(stored(services)).toMatchObject({
      status: 'finalizing',
      number: 10,
      issuedOn: null,
      pdfFileId: null,
    })
    expect(warnings).not.toHaveBeenCalled()
  })

  it.each([
    ['step 2 numbers it', '"lastInvoiceNumber"', { number: null }],
    ['step 6 issues it', '"issuedOn"', { number: 10, issuedOn: null }],
  ])(
    'fails the commit when their deletion lands after %s stages, before it commits (#519)',
    async (_, text, left) => {
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const services = fakes({ ...october(), profiles: [samProfile('{')] })
      // Its guard write on Sam's person row: a deletion committing first fails this commit.
      beforeCommitOf(services, text, [op('persons', 'sam', { deletedAt: DELETED_AT })])
      expect(
        await failure(services, 'POST', '/statements/st1/finalize', { send: false }),
      ).toMatchObject({ status: 409, code: 'CONFLICT' })
      expect(stored(services)).toMatchObject({ status: 'finalizing', ...left })
      // A step 6 that doesn't commit says nothing about the business details (#543).
      expect(warnings).not.toHaveBeenCalled()
    },
  )

  it('still finalizes a divide whose house was made by someone who has deleted their account', async () => {
    const services = fakes({
      statements: [statement('st-house', { groupId: 'house', type: 'divide' })],
    })
    await commitNow(services.db, [
      op('persons', 'alice', { deletedAt: DELETED_AT, userId: null }),
      op('members', 'm-bob', { role: 'admin' }),
    ])
    const final = await finalize(services, false, 'st-house', 'u-bob')
    expect(final).toMatchObject({ status: 'final', finalizedBy: 'bob' })
  })

  it('refuses a house divide to a member who is not an admin', async () => {
    const services = fakes({
      statements: [statement('st-house', { groupId: 'house', type: 'divide' })],
    })
    const asMember = await failure(
      services,
      'POST',
      '/statements/st-house/finalize',
      { send: false },
      'u-bob',
    )
    expect(asMember.code).toBe('FORBIDDEN')
  })

  it('emails the invoice when asked to send it', async () => {
    const services = fakes(october())
    const final = await finalize(services, true)
    expect(final.sentAt).toBe(NOW.toISOString())
    expect(
      services.sent.map(({ to, replyTo, idempotencyKey }) => ({ to, replyTo, idempotencyKey })),
    ).toEqual([
      {
        to: ['billing@acme.example'],
        replyTo: 'sam@example.com',
        idempotencyKey: 'invoice/st1/first/employer',
      },
      { to: 'sam@example.com', replyTo: undefined, idempotencyKey: 'invoice/st1/first/copy' },
    ])
    expect(services.sent[0]).toMatchObject({ subject: 'Invoice INV-0010 from Sam Cleans' })
    expect(services.sent[0]?.attachments?.[0]?.filename).toBe('INV-0010.pdf')
  })
})

describe('two finalize runs of one statement at once', () => {
  it('counts a transaction once when the other run locks it between this run’s two reads', async () => {
    const services = fakes(october())
    const list = services.db.listRows.bind(services.db)
    let locked = false
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      // The read of what's already locked to st1 comes after the read of what's unlocked.
      const lockedToThis =
        params.tableId === 'transactions' &&
        params.queries?.some((query) => query.includes('"equal","attribute":"statementId"'))
      if (lockedToThis && !locked) {
        locked = true
        await commitNow(services.db, [op('transactions', 's1', { statementId: 'st1' })])
      }
      return list(params)
    })
    const final = await finalize(services)
    expect(final.status).toBe('final')
    const snapshot = JSON.parse(final.snapshotJson) as StatementSnapshot
    expect(snapshot.lines.map((line) => line.transactionId)).toEqual(['s1', 'p1'])
    expect(snapshot.invoice?.balanceDueCents).toBe(7000)
    expect(locks(services)).toEqual({ s1: 'st1', p1: 'st1', s2: null })
  })

  it('leaves the locks alone when its check fails after the other run stored the issue date', async () => {
    // The check fails, but the other run passed its check and stored issuedOn just before this
    // one goes back to draft.
    const services = failingCheck()
    // This run's stagings: 1 finalizing, 2 the number, 3 the lock batch, 4 back to draft.
    beforeStaging(services.db, [op('statements', 'st1', { issuedOn: '2026-11-02' })], 4)
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('CONFLICT')
    expect(stored(services)).toMatchObject({ status: 'finalizing', issuedOn: '2026-11-02' })
    expect(locks(services)).toEqual({ s1: 'st1' })
  })

  it('stops unlocking when another run starts finalizing the statement again', async () => {
    // This run went back to draft. Before its locks come off, a new run starts finalizing (its
    // step 1 writes the statement and the group row), and goes on to use those locks.
    const services = failingCheck()
    // This run's stagings: 1 finalizing, 2 the number, 3 the lock batch, 4 back to draft, 5 the
    // first unlock batch.
    beforeStaging(
      services.db,
      [
        op('statements', 'st1', { status: 'finalizing' }),
        op('groups', 'job', { rev: 'other-run' }),
      ],
      5,
    )
    const response = await failure(services, 'POST', '/statements/st1/finalize', { send: false })
    expect(response.code).toBe('CONFLICT')
    expect(stored(services)).toMatchObject({ status: 'finalizing' })
    expect(locks(services)).toEqual({ s1: 'st1' })
  })
})

describe('auto-finalize (the statements job)', () => {
  it('finalizes a new draft at once when the group asks for it, without sending it', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 120)),
      groups: [job({ autoFinalize: true })],
    })
    expect(await ok(services, 'POST', '/', undefined, null)).toEqual({ drafted: 1, failed: 0 })
    expect(services.db.rows('statements')[0]).toMatchObject({
      status: 'final',
      displayNumber: 'INV-0010',
      finalizedBy: null,
      sentAt: null,
    })
    // Only the "ready to review" email.
    expect(services.sent).toHaveLength(1)
  })

  it('leaves the new draft for an admin when the worker has deleted their account (#503)', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 120)),
      groups: [job({ autoFinalize: true })],
    })
    await commitNow(services.db, [op('persons', 'sam', { deletedAt: DELETED_AT })])
    expect(await ok(services, 'POST', '/', undefined, null)).toEqual({ drafted: 1, failed: 0 })
    expect(services.db.rows('statements')[0]).toMatchObject({ status: 'draft', number: null })
    expect(lastNumber(services)).toBe(9)
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      {
        fn: 'unknown',
        event: 'auto_finalize_failed',
        statementId: expect.any(String),
        cause: 'AppError CONFLICT',
      },
    ])
  })
})
