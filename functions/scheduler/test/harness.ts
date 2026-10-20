import type { Groups, Members, Persons, Profiles } from '@ledgerly/core/generated/rows'
import type { EmailType } from '@ledgerly/core/schemas/identity'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import type { Email } from '@ledgerly/server/email/send-email'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { AppwriteException } from 'node-appwrite'
import { vi } from 'vitest'
import { schedulerRoutes } from '../src/main'
import type { AccountUser, Services } from '../src/services'
import { type BucketFile, PAGE, type ReceiptsBucket } from '../src/steps/receipts'

// 07:00 on Monday 19 October in Sydney, still Sunday 18 October in UTC.
export const NOW = new Date('2026-10-18T20:00:00.000Z')
export const APP_URL = 'https://app.example.com'

type Seed = ConstructorParameters<typeof FakeDb>[0]
type SeedRow<R> = Partial<R> & { $id: string }

export type Fakes = Services & {
  db: FakeDb
  teams: FakeTeams
  files: FakeBucket
  sendEmail: ReturnType<typeof vi.fn<(email: Email) => Promise<unknown>>>
}

/** Accounts by user ID; any other user ID is a deleted account (404). Teams by team ID. */
export function fakes(
  seed: Seed = {},
  options: {
    accounts?: Record<string, Partial<AccountUser>>
    now?: Date
    teams?: Record<string, string[]>
  } = {},
): Fakes {
  const accounts = options.accounts ?? {
    u1: { email: 'sam@example.com', emailVerification: true },
    u2: { email: 'alex@example.com', emailVerification: true },
  }
  return {
    db: new FakeDb(seed),
    teams: new FakeTeams(options.teams),
    users: {
      get: async ({ userId }) => {
        const account = accounts[userId]
        if (!account) throw new AppwriteException('User not found', 404, 'user_not_found')
        return { $id: userId, email: '', emailVerification: false, status: true, ...account }
      },
    },
    sendEmail: vi.fn(async (_email: Email) => ({ id: 'email1' })),
    files: new FakeBucket(),
    now: options.now ?? NOW,
    appUrl: APP_URL,
    outOfTime: () => false,
  }
}

/** Storage's receipts bucket, in memory: file IDs and when they were uploaded. */
export class FakeBucket implements ReceiptsBucket {
  readonly stored = new Map<string, string>()

  upload(fileId: string, createdAt: string): void {
    this.stored.set(fileId, createdAt)
  }

  async listFiles(page: { from: string; to: string; after?: string }): Promise<BucketFile[]> {
    // As on Appwrite, a cursor must be a file that still exists.
    if (page.after !== undefined && !this.stored.has(page.after)) {
      throw new AppwriteException('Cursor not found', 400, 'general_cursor_not_found')
    }
    // Oldest first, then by ID, as step 5 asks for.
    const key = ({ $id, $createdAt }: BucketFile) => `${$createdAt}|${$id}`
    const cursor = page.after === undefined ? undefined : this.stored.get(page.after)
    return [...this.stored]
      .map(([$id, $createdAt]) => ({ $id, $createdAt }))
      .filter(({ $createdAt }) => $createdAt > page.from && $createdAt <= page.to)
      .filter((file) => cursor === undefined || key(file) > `${cursor}|${page.after}`)
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .slice(0, PAGE)
  }

  async deleteFile(fileId: string): Promise<boolean> {
    return this.stored.delete(fileId)
  }
}

export function person(id: string, userId: string | null): SeedRow<Persons> {
  return { $id: id, userId, displayName: id, claimedAt: null, mergedInto: null, deletedAt: null }
}

/** A user's profile (row ID = user ID) with the emails they turned off: null is every email on. */
export function profile(
  userId: string,
  personId: string,
  emailOptOuts: EmailType[] | null,
): SeedRow<Profiles> {
  return { $id: userId, personId, nextSummaryAt: null, emailOptOuts }
}

export function group(id: string, ownerPersonId: string, extra: Partial<Groups> = {}) {
  return {
    $id: id,
    type: 'employer',
    name: 'Acme',
    ownerPersonId,
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: 'monthly',
    cycleAnchor: null,
    nextCloseAt: null,
    settingsJson: '{"type":"employer"}',
    archivedAt: null,
    ...extra,
  } satisfies SeedRow<Groups>
}

export function member(
  groupId: string,
  personId: string,
  extra: Partial<Members> = {},
): SeedRow<Members> {
  return {
    $id: `${groupId}-${personId}`,
    groupId,
    personId,
    displayName: personId,
    role: 'admin',
    status: 'active',
    joinedOn: '2026-01-01',
    leftOn: null,
    ...extra,
  }
}

type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

/**
 * Sends a request through the function's real handler, as `userId` (null: no JWT), or as a
 * cron run with `scheduled`.
 */
export async function call(
  services: Services,
  method: string,
  path: string,
  options: { body?: unknown; userId?: string | null; scheduled?: boolean } = {},
): Promise<{ status: number; body: Envelope; logs: string[] }> {
  const { body, userId = 'u1', scheduled = false } = options
  const handler = createHandler(
    schedulerRoutes(() => services),
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
        ...(scheduled ? { 'x-appwrite-trigger': 'schedule' } : {}),
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
  options?: Parameters<typeof call>[3],
): Promise<T> {
  const { status, body } = await call(services, method, path, options)
  if (!body.ok) throw new Error(`${status} ${JSON.stringify(body.error)}`)
  return body.data as T
}

/** The status and error code of a failed request. */
export async function failure(
  services: Services,
  method: string,
  path: string,
  options?: Parameters<typeof call>[3],
): Promise<{ status: number; code: string }> {
  const { status, body } = await call(services, method, path, options)
  if (body.ok) throw new Error(`Expected an error, got ${JSON.stringify(body.data)}`)
  return { status, code: body.error.code }
}

/**
 * Runs `change` just before the first staging whose operations match `when`, as if another
 * request got there first.
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
