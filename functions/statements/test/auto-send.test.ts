import type { Statements } from '@ledgerly/core/generated/rows'
import { type Email, EmailError } from '@ledgerly/server/email/send-email'
import { AppwriteException } from 'node-appwrite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveJob,
  beforeCommits,
  commitNow,
  type Fakes,
  fakes,
  house,
  job,
  member,
  NOVEMBER_CLOSE,
  NOW,
  ok,
  op,
  rowsOf,
  shift,
  snapshotClosing,
  statement,
} from './harness'

// statements.md#auto-send (#432).

let errors: string[]
beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.push(line)
  })
})
afterEach(() => vi.restoreAllMocks())

const AUTO = { autoFinalize: true, autoSend: true }
const HOUR_MS = 60 * 60 * 1000
const WINDOW_END = new Date(NOW.getTime() + 23 * HOUR_MS).toISOString()

const runJob = (services: Fakes) =>
  ok<{ drafted: number; failed: number }>(services, 'POST', '/', undefined, null)

const invoices = (services: Fakes) => services.db.rows('statements') as unknown as Statements[]

const keys = (services: Fakes) => services.sent.map((email) => email.idempotencyKey)

const logged = () => errors.map((line) => JSON.parse(line) as { event: string })

// Sam's October shift, drafted and auto-finalized by the run at NOW.
function octoberDue(settings: object = AUTO, extra: Record<string, unknown[]> = {}) {
  return fakes({ ...rowsOf(shift('s1', '2026-10-02', 120)), groups: [job(settings)], ...extra })
}

// Sends that fail as `fail` says; the rest go through. A failed one isn't counted as sent.
function failing(services: Fakes, fail: (email: Email) => Error | undefined) {
  const send = services.sendEmail
  services.sendEmail = async (email) => {
    const error = fail(email)
    if (error) throw error
    return send(email)
  }
}

const isInvoice = (email: Email) => email.idempotencyKey?.startsWith('invoice/') ?? false
const isInvoiceKey = (key: string | undefined) => key?.startsWith('invoice/') ?? false

describe('the statements job, with autoSend on', () => {
  it('emails the invoice it auto-finalizes in the same run, as an admin’s Send does', async () => {
    const services = octoberDue()
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const [invoice] = invoices(services)
    expect(invoice).toMatchObject({
      status: 'final',
      displayNumber: 'INV-0010',
      finalizedBy: null,
      autoSendUntil: WINDOW_END,
      sentAt: NOW.toISOString(),
    })
    // The employer's, reply-to Sam, then Sam's copy, with an admin's first keys. No "ready"
    // email: the invoice is on its way.
    expect(services.sent.map((email) => [email.to, email.idempotencyKey, email.replyTo])).toEqual([
      [['billing@acme.example'], `invoice/${invoice?.$id}/first/employer`, 'sam@example.com'],
      ['sam@example.com', `invoice/${invoice?.$id}/first/copy`, undefined],
    ])
    expect(services.sent[0]?.attachments?.map((file) => file.filename)).toEqual(['INV-0010.pdf'])
    expect(
      services.db.rows('activity').map((row) => [row.action, row.actorPersonId, row.summary]),
    ).toEqual([
      ['statement.drafted', null, expect.any(String)],
      ['statement.finalized', null, 'Invoice INV-0010 finalized'],
      ['statement.sent', null, 'Invoice INV-0010 sent'],
    ])
    expect(errors).toEqual([])
  })

  it('opens no window for an admin’s finalize, or with autoSend off', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 120), { statements: [statement('st1')] }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    await ok(services, 'POST', '/statements/st1/finalize', { send: false })
    await runJob(services)
    expect(invoices(services)[0]).toMatchObject({ status: 'final', sentAt: null })
    expect(invoices(services)[0]?.autoSendUntil ?? null).toBeNull()
    const off = octoberDue({ autoFinalize: true })
    await runJob(off)
    expect(invoices(off)[0]).toMatchObject({ status: 'final', sentAt: null })
    expect(invoices(off)[0]?.autoSendUntil ?? null).toBeNull()
    // Without autoSend, the "ready" email goes as before.
    expect(keys(off)).toEqual([`ready/${invoices(off)[0]?.$id}/sam`])
    expect(services.sent).toEqual([])
  })

  it('doesn’t email an invoice with no lines: it’s finalized, and the "ready" email goes', async () => {
    // An idle October: the employer could be asked again for a balance already invoiced.
    const services = fakes({ groups: [job(AUTO)] })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const [invoice] = invoices(services)
    expect(invoice?.status).toBe('final')
    expect(invoice?.autoSendUntil ?? null).toBeNull()
    expect(keys(services)).toEqual([`ready/${invoice?.$id}/sam`])
    services.now = new Date(NOW.getTime() + HOUR_MS)
    await runJob(services)
    expect(keys(services)).toEqual([`ready/${invoice?.$id}/sam`])
  })

  it('sends the "ready" email instead when the finalize fails, and sends no invoice', async () => {
    const services = octoberDue()
    vi.spyOn(services.files, 'upload').mockRejectedValue(
      new AppwriteException('Storage is down', 503, 'general_unknown'),
    )
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const [draft] = invoices(services)
    expect(draft).toMatchObject({ status: 'finalizing', sentAt: null })
    expect(keys(services)).toEqual([`ready/${draft?.$id}/sam`])
  })

  it('lets an admin who turned the "ready" email off go without it, autoSend or not (#431)', async () => {
    const services = octoberDue()
    await commitNow(services.db, [op('profiles', 'u-sam', { emailOptOuts: ['statementReady'] })])
    vi.spyOn(services.files, 'upload').mockRejectedValue(
      new AppwriteException('Storage is down', 503, 'general_unknown'),
    )
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    expect(invoices(services)[0]).toMatchObject({ status: 'finalizing', sentAt: null })
    expect(services.sent).toEqual([])
  })

  it('sends the "ready" email instead when the finalize waits behind an early close (#420)', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-11-01', 60), shift('s2', '2026-11-20', 60), {
        statements: [
          statement('st-oct', {
            status: 'final',
            number: 9,
            displayNumber: 'INV-0009',
            snapshotJson: snapshotClosing({ start: '2026-10-01', end: '2026-10-31' }, {}),
          }),
        ],
      }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    const early = await ok<Statements>(services, 'POST', '/statements/close', { groupId: 'job' })
    // 07:00 on 1 December in Sydney: November is due, and the early close is still a draft.
    services.now = new Date('2026-11-30T20:00:00.000Z')
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const november = invoices(services).find((row) => row.periodEnd === '2026-11-30')
    expect(november?.status).toBe('draft')
    expect(invoices(services).find((row) => row.$id === early.$id)?.status).toBe('draft')
    expect(keys(services)).toEqual([`ready/${november?.$id}/sam`])
  })

  it('sends the "ready" email instead while an earlier statement is stuck finalizing', async () => {
    // September stopped half-way through finalizing: rule 5 holds October back.
    const services = octoberDue(AUTO, {
      statements: [
        statement('st-sep', {
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'finalizing',
        }),
      ],
    })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const october = invoices(services).find((row) => row.periodEnd === '2026-10-31')
    expect(october?.status).toBe('draft')
    expect(keys(services)).toEqual([`ready/${october?.$id}/sam`])
    expect(errors).toEqual([])
  })

  it.each([
    ['on', AUTO],
    ['off', { autoFinalize: true }],
  ])(
    'sends the "ready" email when the finalize can’t check rule 5, with autoSend %s',
    async (_case, settings) => {
      const services = octoberDue(settings)
      // The draft is made, then the read of the group's unfinished statements fails once.
      const listRows = services.db.listRows.bind(services.db)
      let failed = false
      vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
        if (
          !failed &&
          params.tableId === 'statements' &&
          params.queries?.join().includes('finalizing')
        ) {
          failed = true
          throw new AppwriteException('Database is down', 503, 'general_unknown')
        }
        return listRows(params)
      })
      expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
      const [draft] = invoices(services)
      expect(draft?.status).toBe('draft')
      expect(draft?.autoSendUntil ?? null).toBeNull()
      expect(keys(services)).toEqual([`ready/${draft?.$id}/sam`])
      expect(logged().map((line) => line.event)).toEqual(['auto_finalize_failed'])
    },
  )

  it('tries a transient failure again with the same keys, and tells the admins once', async () => {
    const services = octoberDue()
    failing(services, (email) =>
      isInvoice(email)
        ? new EmailError('Resend could not be reached: timeout', 'timeout')
        : undefined,
    )
    await runJob(services)
    const [invoice] = invoices(services)
    // Neither column changes, and the log has the IDs and the error type only.
    expect(invoice).toMatchObject({ status: 'final', sentAt: null, autoSendUntil: WINDOW_END })
    expect(logged()).toEqual([
      {
        fn: 'unknown',
        event: 'auto_send_failed',
        statementId: invoice?.$id,
        cause: 'EmailError timeout',
      },
    ])
    expect(errors.join('\n')).not.toContain('@')
    expect(services.sent.map((email) => [email.to, email.idempotencyKey, email.subject])).toEqual([
      [
        ['sam@example.com'],
        `auto-send-failed/${invoice?.$id}/sam`,
        "Invoice INV-0010 for Acme couldn't be emailed",
      ],
    ])
    // An hour later it fails again: the notice has the same key, so Resend delivers it once.
    services.now = new Date(NOW.getTime() + HOUR_MS)
    await runJob(services)
    expect(keys(services)).toEqual([
      `auto-send-failed/${invoice?.$id}/sam`,
      `auto-send-failed/${invoice?.$id}/sam`,
    ])
    // Then it goes, with the keys it had from the start.
    services.now = new Date(NOW.getTime() + 2 * HOUR_MS)
    vi.restoreAllMocks()
    services.sendEmail = fakes().sendEmail
    const sent: Email[] = []
    services.sendEmail = async (email) => {
      sent.push(email)
      return { id: 'email' }
    }
    await runJob(services)
    expect(sent.map((email) => email.idempotencyKey)).toEqual([
      `invoice/${invoice?.$id}/first/employer`,
      `invoice/${invoice?.$id}/first/copy`,
    ])
    expect(invoices(services)[0]?.sentAt).toBe(services.now.toISOString())
  })

  it.each([
    ['validation_error', 422],
    ['invalid_idempotent_request', 409],
  ])('closes the window on Resend’s %s, so no later run sends', async (type, status) => {
    const services = octoberDue()
    failing(services, (email) =>
      isInvoice(email)
        ? new EmailError(`Resend answered ${status} ${type}`, type, status)
        : undefined,
    )
    await runJob(services)
    const [invoice] = invoices(services)
    expect(invoice).toMatchObject({ sentAt: null, autoSendUntil: NOW.toISOString() })
    expect(keys(services)).toEqual([`auto-send-failed/${invoice?.$id}/sam`])
    services.now = new Date(NOW.getTime() + HOUR_MS)
    await runJob(services)
    expect(keys(services)).toEqual([`auto-send-failed/${invoice?.$id}/sam`])
  })

  it.each([401, 403])(
    'stops at a validation_error with %i, our key or domain: one line, every window kept (#469)',
    async (status) => {
      const services = fakes({
        ...rowsOf(shift('s1', '2026-09-02', 60), shift('s2', '2026-10-02', 60), {
          statements: [
            statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
            statement('st-oct'),
          ],
        }),
        groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
      })
      for (const id of ['st-sep', 'st-oct']) {
        await ok(services, 'POST', `/statements/${id}/finalize`, { send: false })
        await commitNow(services.db, [op('statements', id, { autoSendUntil: WINDOW_END })])
      }
      const tried: string[] = []
      failing(services, (email) => {
        tried.push(email.idempotencyKey ?? '')
        return new EmailError(
          `Resend answered ${status} validation_error`,
          'validation_error',
          status,
        )
      })
      await runJob(services)
      // The first invoice's employer email only: no notice to the admins, which would fail too.
      expect(tried).toEqual([`invoice/${tried[0]?.split('/')[1]}/first/employer`])
      expect(logged().map((line) => line.event)).toEqual(['auto_send_failed'])
      expect(invoices(services).map((row) => [row.sentAt, row.autoSendUntil])).toEqual([
        [null, WINDOW_END],
        [null, WINDOW_END],
      ])
    },
  )

  it('stops at the notice to the admins when it meets a 403 there: one line each (#469)', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-09-02', 60), shift('s2', '2026-10-02', 60), {
        statements: [
          statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
          statement('st-oct'),
        ],
      }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    // Dan is Acme's second admin, so a notice is left to try after the first.
    const { $id: _, ...dan } = member('m-dan', 'job', 'dan', 'admin')
    await commitNow(services.db, [
      op('members', 'm-dan', dan, 'create'),
      op(
        'identities',
        'i-dan',
        { key: 'email:dan@example.com', type: 'email', personId: 'dan', verified: true },
        'create',
      ),
    ])
    for (const id of ['st-sep', 'st-oct']) {
      await ok(services, 'POST', `/statements/${id}/finalize`, { send: false })
      await commitNow(services.db, [op('statements', id, { autoSendUntil: WINDOW_END })])
    }
    const tried: string[] = []
    failing(services, (email) => {
      tried.push(email.idempotencyKey ?? '')
      return isInvoice(email)
        ? new EmailError('Resend could not be reached: timeout', 'timeout')
        : new EmailError('Resend answered 403 validation_error', 'validation_error', 403)
    })
    await runJob(services)
    // The first invoice's employer email and one notice: not the other admin's or the next invoice.
    const first = tried[0]?.split('/')[1]
    expect(tried).toHaveLength(2)
    expect(tried[0]).toBe(`invoice/${first}/first/employer`)
    expect(tried[1]).toMatch(new RegExp(`^auto-send-failed/${first}/(sam|dan)$`))
    expect(logged().map((line) => line.event)).toEqual([
      'auto_send_failed',
      'auto_send_notice_failed',
    ])
    expect(invoices(services).map((row) => [row.sentAt, row.autoSendUntil])).toEqual([
      [null, WINDOW_END],
      [null, WINDOW_END],
    ])
  })

  it('still tries an invoice after a "ready" email met a 403 in the same run: one line each (#476)', async () => {
    // September is final with its window open; October is idle, so its "ready" email goes.
    const services = fakes({
      ...rowsOf(shift('s1', '2026-09-02', 60), {
        statements: [statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' })],
      }),
      groups: [job(AUTO)],
    })
    await ok(services, 'POST', '/statements/st-sep/finalize', { send: false })
    await commitNow(services.db, [op('statements', 'st-sep', { autoSendUntil: WINDOW_END })])
    const tried: string[] = []
    failing(services, (email) => {
      tried.push(email.idempotencyKey ?? '')
      return new EmailError('Resend answered 403 validation_error', 'validation_error', 403)
    })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    const october = invoices(services).find((row) => row.$id !== 'st-sep')
    expect(tried).toEqual([`ready/${october?.$id}/sam`, 'invoice/st-sep/first/employer'])
    expect(logged().map((line) => line.event)).toEqual(['ready_email_failed', 'auto_send_failed'])
  })

  it('takes concurrent_idempotent_requests, an admin’s Send at the same moment, as transient', async () => {
    const services = octoberDue()
    const send = services.sendEmail
    failing(services, (email) =>
      isInvoice(email)
        ? new EmailError(
            'Resend answered 409 concurrent_idempotent_requests',
            'concurrent_idempotent_requests',
            409,
          )
        : undefined,
    )
    await runJob(services)
    const [invoice] = invoices(services)
    expect(invoice).toMatchObject({ sentAt: null, autoSendUntil: WINDOW_END })
    // The window stays open, and the next run sends with the same keys.
    services.sendEmail = send
    services.now = new Date(NOW.getTime() + HOUR_MS)
    await runJob(services)
    expect(keys(services).filter(isInvoiceKey)).toEqual([
      `invoice/${invoice?.$id}/first/employer`,
      `invoice/${invoice?.$id}/first/copy`,
    ])
    expect(invoices(services)[0]?.sentAt).toBe(services.now.toISOString())
  })

  it('ends quietly when a void gets in first: no sentAt, no notice and no log', async () => {
    const services = octoberDue()
    const original = services.sendEmail
    let voided = false
    services.sendEmail = async (email) => {
      if (email.idempotencyKey?.endsWith('/copy') && !voided) {
        voided = true
        // An admin voids it just before the job's sentAt write commits.
        beforeCommits(services.db, [
          op('statements', email.idempotencyKey.split('/')[1] ?? '', { status: 'void' }),
        ])
      }
      return original(email)
    }
    await runJob(services)
    expect(invoices(services)[0]).toMatchObject({ status: 'void', sentAt: null })
    expect(keys(services).filter((key) => key?.startsWith('auto-send-failed/'))).toEqual([])
    expect(errors).toEqual([])
  })

  it('reads the invoice again before sending, so one voided since the listing isn’t sent', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 120), { statements: [statement('st1')] }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    await ok(services, 'POST', '/statements/st1/finalize', { send: false })
    await commitNow(services.db, [op('statements', 'st1', { autoSendUntil: WINDOW_END })])
    const listRows = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      const page = await listRows(params)
      if (params.tableId === 'statements' && params.queries?.join().includes('autoSendUntil')) {
        await commitNow(services.db, [op('statements', 'st1', { status: 'void' })])
      }
      return page
    })
    await runJob(services)
    expect(services.sent).toEqual([])
  })

  it('keeps the drafts when listing the invoices to send fails, and logs it', async () => {
    const services = octoberDue()
    const listRows = services.db.listRows.bind(services.db)
    vi.spyOn(services.db, 'listRows').mockImplementation(async (params) => {
      if (params.tableId === 'statements' && params.queries?.join().includes('autoSendUntil')) {
        throw new AppwriteException('Database is down', 503, 'general_unknown')
      }
      return listRows(params)
    })
    expect(await runJob(services)).toEqual({ drafted: 1, failed: 0 })
    expect(services.sent).toEqual([])
    expect(logged()).toEqual([
      { fn: 'unknown', event: 'auto_send_failed', cause: expect.any(String) },
    ])
  })

  it('doesn’t send without the worker’s verified email, which an admin’s Send would', async () => {
    const services = octoberDue(AUTO, { identities: [] })
    await runJob(services)
    const [invoice] = invoices(services)
    // Nobody can be told either: Sam has no verified email.
    expect(invoice).toMatchObject({
      status: 'final',
      sentAt: null,
      autoSendUntil: NOW.toISOString(),
    })
    expect(services.sent).toEqual([])
  })

  it('stops for the run when Resend says to slow down, after telling the admins', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-09-02', 60), shift('s2', '2026-10-02', 60), {
        statements: [
          statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
          statement('st-oct'),
        ],
      }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    for (const id of ['st-sep', 'st-oct']) {
      await ok(services, 'POST', `/statements/${id}/finalize`, { send: false })
      await commitNow(services.db, [op('statements', id, { autoSendUntil: WINDOW_END })])
    }
    const tried: string[] = []
    failing(services, (email) => {
      tried.push(email.idempotencyKey ?? '')
      return new EmailError('Resend answered 429 rate_limit_exceeded', 'rate_limit_exceeded', 429)
    })
    await runJob(services)
    // The first invoice's employer email, and the notice about it: the step ends there.
    const first = tried[0]?.split('/')[1]
    expect(tried).toEqual([`invoice/${first}/first/employer`, `auto-send-failed/${first}/sam`])
    expect(invoices(services).map((row) => [row.sentAt, row.autoSendUntil])).toEqual([
      [null, WINDOW_END],
      [null, WINDOW_END],
    ])
  })

  it('goes on to the next invoice when reading one fails, and tries that one next run', async () => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-09-02', 60), shift('s2', '2026-10-02', 60), {
        statements: [
          statement('st-sep', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
          statement('st-oct'),
        ],
      }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    for (const id of ['st-sep', 'st-oct']) {
      await ok(services, 'POST', `/statements/${id}/finalize`, { send: false })
      await commitNow(services.db, [op('statements', id, { autoSendUntil: WINDOW_END })])
    }
    // The step's first read of an invoice fails, whichever it reads first.
    const getRow = services.db.getRow.bind(services.db)
    let unread = ''
    vi.spyOn(services.db, 'getRow').mockImplementation(async (params) => {
      if (!unread && params.tableId === 'statements') {
        unread = params.rowId
        throw new AppwriteException('Database is down', 503, 'general_unknown')
      }
      return getRow(params)
    })
    await runJob(services)
    const other = unread === 'st-sep' ? 'st-oct' : 'st-sep'
    expect(keys(services)).toEqual([
      `invoice/${other}/first/employer`,
      `invoice/${other}/first/copy`,
    ])
    expect(logged()).toEqual([
      { fn: 'unknown', event: 'auto_send_failed', statementId: unread, cause: expect.any(String) },
    ])
    services.now = new Date(NOW.getTime() + HOUR_MS)
    await runJob(services)
    expect(keys(services).slice(2)).toEqual([
      `invoice/${unread}/first/employer`,
      `invoice/${unread}/first/copy`,
    ])
  })

  it.each([
    ['archived', (services: Fakes) => archiveJob(services)],
    [
      'with autoSend turned off',
      (services: Fakes) =>
        commitNow(services.db, [
          op('groups', 'job', { settingsJson: job({ autoFinalize: true }).settingsJson }),
        ]),
    ],
  ])('sends nothing for a group %s since the finalize', async (_case, change) => {
    const services = octoberDue()
    failing(services, (email) =>
      isInvoice(email) ? new EmailError('timeout', 'timeout') : undefined,
    )
    await runJob(services)
    vi.restoreAllMocks()
    await change(services)
    const sent: Email[] = []
    services.sendEmail = async (email) => {
      sent.push(email)
      return { id: 'email' }
    }
    services.now = new Date(NOW.getTime() + HOUR_MS)
    await runJob(services)
    expect(sent).toEqual([])
    expect(invoices(services)[0]?.sentAt).toBeNull()
  })

  it.each([
    ['void', { status: 'void' }],
    ['sent', { sentAt: '2026-11-01T00:00:00.000Z' }],
    ['past its window', { autoSendUntil: NOW.toISOString() }],
    ['admin-finalized, or final before autoSend was on', { autoSendUntil: null }],
  ])('sends nothing for an invoice that’s %s', async (_case, extra) => {
    const services = fakes({
      ...rowsOf(shift('s1', '2026-10-02', 120), { statements: [statement('st1')] }),
      groups: [job(AUTO, { nextCloseAt: NOVEMBER_CLOSE })],
    })
    await ok(services, 'POST', '/statements/st1/finalize', { send: false })
    await commitNow(services.db, [op('statements', 'st1', { autoSendUntil: WINDOW_END, ...extra })])
    await runJob(services)
    expect(services.sent).toEqual([])
  })

  it('sends no divide', async () => {
    const services = fakes({
      groups: [
        {
          ...house,
          settingsJson: JSON.stringify({
            type: 'house',
            autoFinalize: true,
            defaultBillSplit: 'equal',
          }),
        },
      ],
    })
    await runJob(services)
    expect(invoices(services).every((row) => (row.autoSendUntil ?? null) === null)).toBe(true)
  })

  it('shares the keys with an admin’s Send that gets in first: one sentAt, one activity row', async () => {
    const services = octoberDue()
    // The admin's Send stores sentAt just before the job's own write commits.
    const admins = '2026-11-01T20:00:30.000Z'
    let invoiceId = ''
    const original = services.sendEmail
    services.sendEmail = async (email) => {
      if (email.idempotencyKey?.endsWith('/copy') && !invoiceId) {
        invoiceId = email.idempotencyKey.split('/')[1] ?? ''
        beforeCommits(services.db, [
          op('statements', invoiceId, { sentAt: admins }),
          op(
            'activity',
            'admin-sent',
            {
              groupId: 'job',
              actorPersonId: 'sam',
              action: 'statement.sent',
              summary: 'Invoice INV-0010 sent',
              at: admins,
            },
            'create',
          ),
        ])
      }
      return original(email)
    }
    await runJob(services)
    expect(invoices(services)[0]?.sentAt).toBe(admins)
    expect(
      services.db.rows('activity').filter((row) => row.action === 'statement.sent'),
    ).toHaveLength(1)
    // Nobody is told anything failed.
    expect(keys(services).filter((key) => key?.startsWith('auto-send-failed/'))).toEqual([])
    expect(errors).toEqual([])
  })
})
