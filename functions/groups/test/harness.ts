import type { Db } from '@ledgerly/server/appwrite/client'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { vi } from 'vitest'
import { groupsRoutes } from '../src/main'
import type { Services } from '../src/services'

// 07:00 on 19 October in Sydney, still 18 October in UTC.
export const NOW = new Date('2026-10-18T20:00:00.000Z')
export const TODAY = '2026-10-19'
export const TRY_AGAIN = 'Something else changed this at the same time. Try again.'

type Seed = ConstructorParameters<typeof FakeDb>[0]
type Row = Record<string, unknown> & { $id: string }

export type Fakes = Services & { db: FakeDb; teams: FakeTeams }

export function fakes(seed: Seed = {}, teams: Record<string, string[]> = {}): Fakes {
  return { db: new FakeDb(seed), teams: new FakeTeams(teams), now: NOW }
}

/** A registered person: user `u<n>` is person `p<n>`. */
export function person(n: number, extra: object = {}): Row {
  return {
    $id: `p${n}`,
    userId: `u${n}`,
    displayName: `Person ${n}`,
    claimedAt: null,
    mergedInto: null,
    deletedAt: null,
    ...extra,
  }
}

/** A placeholder person, with no account. */
export function placeholder(id: string, displayName = 'Placeholder'): Row {
  return { $id: id, userId: null, displayName, claimedAt: null, mergedInto: null, deletedAt: null }
}

/** User `u<n>`'s profile. */
export function profile(n: number, extra: object = {}): Row {
  return {
    $id: `u${n}`,
    personId: `p${n}`,
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    currency: 'AUD',
    businessJson: null,
    invoicePrefix: 'INV-',
    lastInvoiceNumber: 0,
    summaryFrequency: 'none',
    nextSummaryAt: null,
    ...extra,
  }
}

/** A group row. */
export function group(id: string, type: string, extra: object = {}): Row {
  const settings =
    type === 'employer'
      ? { type, defaultRateCents: 3000, paymentTermsDays: 14, autoFinalize: false, recipients: [] }
      : type === 'house'
        ? { type, autoFinalize: false, defaultBillSplit: 'days' }
        : { type }
  return {
    $id: id,
    type,
    name: `Group ${id}`,
    ownerPersonId: 'p1',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: type === 'employer' ? 'monthly' : 'none',
    cycleAnchor: null,
    nextCloseAt: null,
    settingsJson: JSON.stringify(settings),
    archivedAt: null,
    ...extra,
  }
}

/** A member row. */
export function member(
  id: string,
  groupId: string,
  personId: string,
  role: 'admin' | 'member' | 'viewer',
  status: 'placeholder' | 'active' | 'left',
  extra: object = {},
): Row {
  return {
    $id: id,
    groupId,
    personId,
    displayName: `Member ${id}`,
    role,
    status,
    joinedOn: '2026-09-01',
    leftOn: null,
    ...extra,
  }
}

/** A share row, enough for balances. */
export function share(
  id: string,
  groupId: string,
  personId: string,
  givenCents: number,
  receivedCents: number,
): Row {
  return {
    $id: id,
    transactionId: `t-${id}`,
    groupId,
    personId,
    givenCents,
    receivedCents,
    date: '2026-10-01',
    kind: 'expense',
    category: null,
  }
}

type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

/** Sends a request through the function's real handler, as `userId` (null: no JWT). */
export async function call(
  services: Services,
  method: string,
  path: string,
  body?: unknown,
  userId: string | null = 'u1',
): Promise<{ status: number; body: Envelope; logs: string[] }> {
  const handler = createHandler(
    groupsRoutes(() => services),
    () => services.db,
    async (jwt) => jwt.slice('jwt-'.length),
  )
  const logs: string[] = []
  let response: { status: number; body: Envelope } | undefined
  await handler({
    req: {
      method,
      path,
      headers: userId === null ? {} : { 'x-appwrite-user-jwt': `jwt-${userId}` },
      bodyText: body === undefined ? '' : JSON.stringify(body),
    },
    res: {
      json: (sent, status) => {
        response = { status: status ?? 200, body: sent as Envelope }
        return response
      },
    },
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
  })
  if (!response) throw new Error('The handler sent no response')
  return { ...response, logs }
}

/** The data of a successful request; fails the test otherwise. */
export async function ok<T>(
  services: Services,
  method: string,
  path: string,
  body?: unknown,
  userId: string | null = 'u1',
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
  userId: string | null = 'u1',
): Promise<{ status: number; code: string; message: string }> {
  const { status, body: envelope } = await call(services, method, path, body, userId)
  if (envelope.ok) throw new Error(`Expected an error, got ${JSON.stringify(envelope.data)}`)
  return { status, code: envelope.error.code, message: envelope.error.message }
}

/**
 * Runs `change` just before the first commit, after the request staged its writes, so the
 * commit fails with Appwrite's 409 as it would on a real conflict.
 */
export function beforeCommit(db: FakeDb, change: () => Promise<unknown>) {
  const commit = db.updateTransaction.bind(db)
  let done = false
  return vi.spyOn(db, 'updateTransaction').mockImplementation(async (params) => {
    if (!done && params.commit) {
      done = true
      await change()
    }
    return commit(params)
  })
}

/** Commits one row write outside the request under test. */
export function updateRow(
  db: Db,
  tableId: 'members' | 'groups' | 'persons' | 'shares',
  rowId: string,
  data: object,
) {
  return withTransaction(db, (tx) =>
    tx.write({ action: 'update', tableId, rowId, data: { ...data } }),
  )
}

/**
 * Runs `change` just before the request's `nth` staging call (1-based), so it lands after the
 * request read the rows but before it staged that write.
 */
export function beforeStaging(db: FakeDb, nth: number, change: () => Promise<unknown>) {
  const stage = db.createOperations.bind(db)
  let calls = 0
  return vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    calls += 1
    if (calls === nth) await change()
    return stage(params)
  })
}

/** Commits one new row outside the request under test. */
export function createRow(
  db: Db,
  tableId: 'shares' | 'transactions' | 'groups' | 'items' | 'schedules' | 'invites',
  row: Row,
) {
  const { $id, ...data } = row
  return withTransaction(db, (tx) => tx.write({ action: 'create', tableId, rowId: $id, data }))
}
