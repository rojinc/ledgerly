import type { Db } from '@ledgerly/server/appwrite/client'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import type { Email } from '@ledgerly/server/email/send-email'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { vi } from 'vitest'
import { identityRoutes } from '../src/main'
import type { AccountUser, Services } from '../src/services'

// 07:00 on 19 October in Sydney, still 18 October in UTC.
export const NOW = new Date('2026-10-18T20:00:00.000Z')
export const BEFORE = '2026-10-01T00:00:00.000Z'
export const AFTER = '2026-10-19T00:00:00.000Z'
export const TRY_AGAIN = 'Something else changed this at the same time. Try again.'
export const APP_URL = 'https://app.example'

type Seed = ConstructorParameters<typeof FakeDb>[0]

/** `sent` holds every email the fake `sendEmail` was given, in order. */
export type Fakes = Services & {
  db: FakeDb
  teams: FakeTeams
  account: AccountUser
  sent: Email[]
}

/** An account with a verified email and nothing else, as `users.get` returns it. */
export function account(overrides: Partial<AccountUser> = {}): AccountUser {
  return {
    $id: 'u1',
    name: 'Sam Lee',
    email: 'sam@example.com',
    emailVerification: true,
    phone: '',
    phoneVerification: false,
    passwordUpdate: '',
    ...overrides,
  }
}

export function fakes(
  seed: Seed = {},
  options: { account?: AccountUser; teams?: Record<string, string[]> } = {},
): Fakes {
  const user = options.account ?? account()
  const sent: Email[] = []
  return {
    db: new FakeDb(seed),
    teams: new FakeTeams(options.teams),
    users: { get: async () => user },
    // A mock, so tests can read its calls, that also records each email in `sent`.
    sendEmail: vi.fn(async (email: Email) => {
      sent.push(email)
      return { id: `email-${sent.length}` }
    }),
    now: NOW,
    appUrl: APP_URL,
    account: user,
    sent,
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Envelope; logs: string[] }> {
  const handler = createHandler(
    identityRoutes(() => services),
    () => services.db,
    async (jwt) => jwt.slice('jwt-'.length),
  )
  const logs: string[] = []
  let response: { status: number; body: Envelope } | undefined
  await handler({
    req: {
      method,
      path,
      headers: {
        ...(userId === null ? {} : { 'x-appwrite-user-jwt': `jwt-${userId}` }),
        ...headers,
      },
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
): Promise<T> {
  const { status, body: envelope } = await call(services, method, path, body)
  if (!envelope.ok) throw new Error(`${status} ${JSON.stringify(envelope.error)}`)
  return envelope.data as T
}

/** The status and error code of a failed request. */
export async function failure(
  services: Services,
  method: string,
  path: string,
  body?: unknown,
  userId?: string | null,
): Promise<{ status: number; code: string; message: string }> {
  const { status, body: envelope } = await call(services, method, path, body, userId)
  if (envelope.ok) throw new Error(`Expected an error, got ${JSON.stringify(envelope.data)}`)
  return { status, code: envelope.error.code, message: envelope.error.message }
}

/**
 * Runs `change` just before the first staging whose operations match `when`, as if another
 * request got there first. Returns the spy so a test can check it ran.
 */
export function beforeStaging(
  db: FakeDb,
  when: (operations: string) => boolean,
  change: () => Promise<unknown>,
) {
  const stage = db.createOperations.bind(db)
  let done = false
  return vi.spyOn(db, 'createOperations').mockImplementation(async (params) => {
    if (!done && when(JSON.stringify(params.operations))) {
      done = true
      await change()
    }
    return stage(params)
  })
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

/** Commits one row update outside the request under test. */
export function updateRow(
  db: Db,
  tableId: 'members' | 'persons' | 'profiles',
  rowId: string,
  data: object,
) {
  return withTransaction(db, (tx) =>
    tx.write({ action: 'update', tableId, rowId, data: { ...data } }),
  )
}

/** A placeholder member row, added at `createdAt`. */
export function placeholderRow(
  id: string,
  groupId: string,
  personId: string,
  createdAt: string,
  extra: object = {},
) {
  return {
    $id: id,
    $createdAt: createdAt,
    groupId,
    personId,
    displayName: 'Sammy',
    role: 'member',
    status: 'placeholder',
    joinedOn: '2026-09-01',
    leftOn: null,
    ...extra,
  }
}
