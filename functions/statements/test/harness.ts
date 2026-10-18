import { FakeDb } from '@ledgerly/server/appwrite/fake'
import type { Email } from '@ledgerly/server/email/send-email'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { AppwriteException } from 'node-appwrite'
import { vi } from 'vitest'
import type { Files } from '../src/files'
import { statementsRoutes } from '../src/main'
import type { Services } from '../src/services'

// 07:00 on 2 November in Sydney: October's statement was due at 06:00 on 1 November.
export const NOW = new Date('2026-11-01T20:00:00.000Z')
export const OCTOBER_CLOSE = '2026-10-31T19:00:00.000Z'
export const NOVEMBER_CLOSE = '2026-11-30T19:00:00.000Z'

type Row = Record<string, unknown> & { $id: string }

/** Storage's statements bucket, in memory. */
export class FakeFiles implements Files {
  readonly stored = new Map<string, { name: string; content: Uint8Array; permissions: string[] }>()

  async upload(fileId: string, name: string, content: Uint8Array, permissions: string[]) {
    if (!this.stored.has(fileId)) this.stored.set(fileId, { name, content, permissions })
  }

  async download(fileId: string): Promise<Uint8Array> {
    const file = this.stored.get(fileId)
    if (!file) throw new AppwriteException('File not found', 404, 'storage_file_not_found')
    return file.content
  }
}

export type Fakes = Services & { db: FakeDb; files: FakeFiles; sent: Email[] }

export const BUSINESS = {
  businessName: 'Sam Cleans',
  abn: '51824753556',
  email: 'sam@example.com',
  bank: { accountName: 'Sam Lee', bsb: '062000', accountNumber: '12345678' },
}

const groupRow = (id: string, type: string, settings: object, extra: object = {}): Row => ({
  $id: id,
  type,
  name: id === 'job' ? 'Acme' : 'House',
  ownerPersonId: type === 'employer' ? 'sam' : 'alice',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  region: 'AU-NSW',
  statementCycle: type === 'employer' ? 'monthly' : 'none',
  cycleAnchor: null,
  nextCloseAt: type === 'employer' ? OCTOBER_CLOSE : null,
  settingsJson: JSON.stringify({ type, ...settings }),
  archivedAt: null,
  ...extra,
})

export const job = (settings: object = {}, extra: object = {}) =>
  groupRow(
    'job',
    'employer',
    {
      defaultRateCents: 2500,
      paymentTermsDays: 14,
      autoFinalize: false,
      recipients: ['billing@acme.example'],
      ...settings,
    },
    extra,
  )

const house = groupRow('house', 'house', { autoFinalize: false, defaultBillSplit: 'equal' })

export const member = (
  $id: string,
  groupId: string,
  personId: string,
  role: 'admin' | 'member' | 'viewer',
  status: 'active' | 'placeholder' | 'left' = 'active',
): Row => ({
  $id,
  groupId,
  personId,
  displayName: personId[0]?.toUpperCase() + personId.slice(1),
  role,
  status,
  joinedOn: '2026-01-01',
  leftOn: null,
})

/**
 * Sam works for Acme (`job`, monthly invoices to billing@acme.example), with business details
 * and invoice number 9 used last. Alice and Bob share a house. Dan has an account but is in
 * neither group.
 */
export function fakes(extra: Record<string, Row[]> = {}): Fakes {
  const sent: Email[] = []
  const db = new FakeDb({
    persons: [
      { $id: 'sam', userId: 'u-sam', displayName: 'Sam' },
      { $id: 'acme', userId: null, displayName: 'Acme' },
      { $id: 'alice', userId: 'u-alice', displayName: 'Alice' },
      { $id: 'bob', userId: 'u-bob', displayName: 'Bob' },
      { $id: 'dan', userId: 'u-dan', displayName: 'Dan' },
    ],
    profiles: [
      {
        $id: 'u-sam',
        personId: 'sam',
        timezone: 'Australia/Sydney',
        region: 'AU-NSW',
        currency: 'AUD',
        businessJson: JSON.stringify(BUSINESS),
        invoicePrefix: 'INV-',
        lastInvoiceNumber: 9,
        summaryFrequency: 'none',
        nextSummaryAt: null,
      },
    ],
    identities: [
      {
        $id: 'i-sam',
        key: 'email:sam@example.com',
        type: 'email',
        personId: 'sam',
        verified: true,
        verifiedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    groups: [job(), house],
    members: [
      member('m-sam', 'job', 'sam', 'admin'),
      member('m-acme', 'job', 'acme', 'viewer', 'placeholder'),
      member('m-alice', 'house', 'alice', 'admin'),
      member('m-bob', 'house', 'bob', 'member'),
    ],
    ...extra,
  })
  return {
    db,
    files: new FakeFiles(),
    sendEmail: async (email) => {
      sent.push(email)
      return { id: `email-${sent.length}` }
    },
    now: NOW,
    appUrl: 'https://app.example.com',
    sent,
  }
}

const transaction = (
  $id: string,
  kind: string,
  date: string,
  totalCents: number,
  extra: object = {},
): Row => ({
  $id,
  groupId: 'job',
  kind,
  status: 'posted',
  date,
  description: `${kind} ${date}`,
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
  createdBy: 'sam',
  updatedBy: 'sam',
  ...extra,
})

const share = (row: Row, personId: string, givenCents: number, receivedCents: number): Row => ({
  $id: `${row.$id}-${personId}`,
  transactionId: row.$id,
  personId,
  givenCents,
  receivedCents,
  groupId: row.groupId,
  date: row.date,
  kind: row.kind,
  category: null,
})

/** A posted shift for Acme: Acme owes Sam its amount. */
export function shift(id: string, date: string, minutes: number, extra: object = {}) {
  const cents = (minutes / 60) * 2500
  const row = transaction(id, 'shift', date, cents, {
    inputJson: JSON.stringify({ shift: { minutes, rateCents: 2500 } }),
    ...extra,
  })
  return {
    transactions: [row],
    shares: [share(row, 'acme', 0, cents), share(row, 'sam', cents, 0)],
  }
}

/** A posted payment from Acme to Sam. */
export function payment(id: string, date: string, cents: number, extra: object = {}) {
  const row = transaction(id, 'payment', date, cents, extra)
  return {
    transactions: [row],
    shares: [share(row, 'acme', cents, 0), share(row, 'sam', 0, cents)],
  }
}

/** Rows for `fakes()`: the transactions and shares of each, joined, plus any other tables. */
export function rowsOf(
  ...parts: Array<{ transactions?: Row[]; shares?: Row[]; statements?: Row[] }>
): Record<string, Row[]> {
  return {
    transactions: parts.flatMap((part) => part.transactions ?? []),
    shares: parts.flatMap((part) => part.shares ?? []),
    statements: parts.flatMap((part) => part.statements ?? []),
  }
}

/** A statement row of `job`. */
export function statement(id: string, extra: object = {}): Row {
  return {
    $id: id,
    groupId: 'job',
    type: 'invoice',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    status: 'draft',
    number: null,
    displayNumber: null,
    issuedOn: null,
    dueOn: null,
    snapshotJson: '{}',
    pdfFileId: null,
    sentAt: null,
    finalizedBy: null,
    ...extra,
  }
}

type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

/** Sends a request through the function's real handler: as `userId`, or as the cron with `null`. */
export async function call(
  services: Services,
  method: string,
  path: string,
  body?: unknown,
  userId: string | null = 'u-sam',
): Promise<{ status: number; body: Envelope }> {
  const handler = createHandler(
    statementsRoutes(() => services),
    () => services.db,
    async (jwt) => jwt.slice('jwt-'.length),
  )
  let response: { status: number; body: Envelope } | undefined
  await handler({
    req: {
      method,
      path,
      headers:
        userId === null
          ? { 'x-appwrite-trigger': 'schedule' }
          : { 'x-appwrite-user-jwt': `jwt-${userId}` },
      bodyText: body === undefined ? '' : JSON.stringify(body),
    },
    res: {
      json: (sent, status) => {
        response = { status: status ?? 200, body: sent as Envelope }
        return response
      },
    },
    log: () => {},
    error: () => {},
  })
  if (!response) throw new Error('The handler sent no response')
  return response
}

/** The data of a successful request; fails the test otherwise. */
export async function ok<T>(
  services: Services,
  method: string,
  path: string,
  body?: unknown,
  userId: string | null = 'u-sam',
): Promise<T> {
  const { status, body: envelope } = await call(services, method, path, body, userId)
  if (!envelope.ok) throw new Error(`${status} ${JSON.stringify(envelope.error)}`)
  return envelope.data as T
}

/** The status and error code of a failed request. */
export async function failure(
  services: Services,
  method: string,
  path: string,
  body?: unknown,
  userId: string | null = 'u-sam',
): Promise<{ status: number; code: string; message: string }> {
  const { status, body: envelope } = await call(services, method, path, body, userId)
  if (envelope.ok) throw new Error(`Expected an error, got ${JSON.stringify(envelope.data)}`)
  return { status, code: envelope.error.code, message: envelope.error.message }
}

/** A valid invoice snapshot of `job` whose people close on these balances. */
export function snapshotClosing(
  period: { start: string; end: string },
  closings: Record<string, number>,
): string {
  return JSON.stringify({
    version: 1,
    group: {
      id: 'job',
      name: 'Acme',
      type: 'employer',
      currency: 'AUD',
      timezone: 'Australia/Sydney',
    },
    period,
    issuer: { personId: 'sam', name: 'Sam', business: {} },
    recipient: { personId: 'acme', name: 'Acme', emails: [] },
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
    invoice: { balanceDueCents: closings.sam ?? 0, paymentTermsDays: 14 },
    generatedAt: '2026-10-01T00:00:00.000Z',
  })
}

/** One staged write, as another request would send it. */
export function op(tableId: string, rowId: string, data: object, action = 'update'): object {
  return { action, databaseId: 'main', tableId, rowId, data }
}

/** Commits `operations` at once, as another request would. */
export async function commitNow(db: FakeDb, operations: object[]) {
  const { $id } = await db.createTransaction()
  await db.createOperations({ transactionId: $id, operations })
  await db.updateTransaction({ transactionId: $id, commit: true })
}

/**
 * Commits `operations`, as another request finishing first would, just before this request's
 * `nth` staging. A row that request changes is then seen by the checks after staging.
 */
export function beforeStaging(db: FakeDb, operations: object[], nth = 1) {
  const stage = db.createOperations.bind(db)
  let calls = 0
  return vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    calls += 1
    if (calls === nth) {
      const { $id } = await db.createTransaction()
      await stage({ transactionId: $id, operations })
      await db.updateTransaction({ transactionId: $id, commit: true })
    }
    return stage(params)
  })
}
