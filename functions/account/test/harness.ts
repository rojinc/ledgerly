import type {
  Groups,
  Members,
  Persons,
  Schedules,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { AppwriteException } from 'node-appwrite'
import { vi } from 'vitest'
import { accountRoutes } from '../src/main'
import type { AccountUser, Services, UsersApi } from '../src/services'

// 07:00 on Monday 19 October in Sydney, still Sunday 18 October in UTC. Earlier than the real
// clock, which FakeDb stamps `$createdAt` with, as Appwrite's is by the time a deletion runs.
export const NOW = new Date('2026-10-18T20:00:00.000Z')
export const TODAY = '2026-10-19'

/** `NOW` less `minutes`, as an ISO string. */
export function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

type Session = { $id: string; $createdAt: string }
export type FakeAccount = AccountUser & { sessions: Session[] }

/** u1, signed in 5 minutes ago in session s1, with a password set long ago. */
export function account(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    $id: 'u1',
    labels: [],
    status: true,
    passwordUpdate: '2026-01-01T00:00:00.000Z',
    sessions: [{ $id: 's1', $createdAt: minutesAgo(5) }],
    ...overrides,
  }
}

/** In-memory Users, with Appwrite's 404 for a user who doesn't exist (or no longer does). */
export class FakeUsers implements UsersApi {
  private users: Map<string, FakeAccount>

  constructor(accounts: FakeAccount[]) {
    this.users = new Map(accounts.map((user) => [user.$id, structuredClone(user)]))
  }

  /** The account as stored, for assertions; undefined once it's deleted. */
  account(userId: string): FakeAccount | undefined {
    const user = this.users.get(userId)
    return user && structuredClone(user)
  }

  async get({ userId }: { userId: string }): Promise<AccountUser> {
    const { sessions: _sessions, ...user } = this.find(userId)
    return structuredClone(user)
  }

  async listSessions({ userId }: { userId: string }): Promise<{ sessions: Session[] }> {
    return { sessions: structuredClone(this.find(userId).sessions) }
  }

  async updateLabels({ userId, labels }: { userId: string; labels: string[] }): Promise<object> {
    this.find(userId).labels = [...labels]
    return {}
  }

  async updateStatus({ userId, status }: { userId: string; status: boolean }): Promise<object> {
    this.find(userId).status = status
    return {}
  }

  async deleteSessions({ userId }: { userId: string }): Promise<object> {
    this.find(userId).sessions = []
    return {}
  }

  async delete({ userId }: { userId: string }): Promise<object> {
    this.find(userId)
    this.users.delete(userId)
    return {}
  }

  private find(userId: string): FakeAccount {
    const user = this.users.get(userId)
    if (!user) throw new AppwriteException('User not found', 404, 'user_not_found')
    return user
  }
}

type Seed = ConstructorParameters<typeof FakeDb>[0]
type SeedRow<R> = Partial<R> & { $id: string }

export type Fakes = Services & { db: FakeDb; teams: FakeTeams; users: FakeUsers }

export function fakes(
  seed: Seed = {},
  options: { accounts?: FakeAccount[]; teams?: Record<string, string[]> } = {},
): Fakes {
  return {
    db: new FakeDb(seed),
    teams: new FakeTeams(options.teams),
    users: new FakeUsers(options.accounts ?? [account()]),
    now: NOW,
    outOfTime: () => false,
  }
}

export function person(id: string, userId: string | null, extra: Partial<Persons> = {}) {
  return {
    $id: id,
    userId,
    displayName: id,
    claimedAt: null,
    mergedInto: null,
    deletedAt: null,
    ...extra,
  } satisfies SeedRow<Persons>
}

export function group(
  id: string,
  type: Groups['type'],
  ownerPersonId: string,
  extra: Partial<Groups> = {},
) {
  return {
    $id: id,
    type,
    name: id,
    ownerPersonId,
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    statementCycle: 'none',
    cycleAnchor: null,
    nextCloseAt: null,
    settingsJson: JSON.stringify({ type }),
    archivedAt: null,
    ...extra,
  } satisfies SeedRow<Groups>
}

export function member(groupId: string, personId: string, extra: Partial<Members> = {}) {
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
  } satisfies SeedRow<Members>
}

/** A weekly expense split equally between `personIds`, expanded up to 30 November. */
export function schedule(
  id: string,
  groupId: string,
  createdBy: string,
  personIds: string[],
  extra: Partial<Schedules> = {},
) {
  return {
    $id: id,
    groupId,
    kind: 'expense',
    description: 'Groceries',
    templateJson: JSON.stringify({ totalCents: 1000, split: { mode: 'equal', personIds } }),
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    startsOn: '2026-10-05',
    endsOn: null,
    exdates: null,
    skipPublicHolidays: false,
    autoPost: false,
    horizonDays: 56,
    generatedThrough: '2026-11-30',
    nextRunAt: '2026-10-19T13:05:00.000Z',
    createdBy,
    ...extra,
  } satisfies SeedRow<Schedules>
}

/** The schedule's `scheduled` occurrence on `date`. */
export function occurrence(
  scheduleRow: { $id: string; groupId: string; createdBy: string },
  date: string,
  extra: Partial<Transactions> = {},
) {
  return {
    $id: `${scheduleRow.$id}_${date.replaceAll('-', '')}`,
    groupId: scheduleRow.groupId,
    kind: 'expense',
    status: 'scheduled',
    date,
    description: 'Groceries',
    totalCents: 1000,
    inputJson: '{}',
    scheduleId: scheduleRow.$id,
    overridden: false,
    statementId: null,
    createdBy: scheduleRow.createdBy,
    updatedBy: scheduleRow.createdBy,
    ...extra,
  } satisfies SeedRow<Transactions>
}

type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

/**
 * Sends a request through the function's real handler, as `userId` (null: no JWT) with a JWT
 * made for `sessionId` (null: a JWT that names no session). Defaults: `POST /delete` with
 * `{ confirm: 'DELETE' }`, as u1 in session s1.
 */
export async function call(
  services: Services,
  options: {
    method?: string
    path?: string
    body?: unknown
    userId?: string | null
    sessionId?: string | null
  } = {},
): Promise<{ status: number; body: Envelope; logs: string[] }> {
  const { method = 'POST', path = '/delete', userId = 'u1', sessionId = 's1' } = options
  // A body given as undefined sends none.
  const body = 'body' in options ? options.body : { confirm: 'DELETE' }
  // Appwrite's JWT payload; the fake verification accepts any JWT.
  const payload = { userId, ...(sessionId === null ? {} : { sessionId }) }
  const jwt = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
  const handler = createHandler(
    accountRoutes(() => services),
    () => services.db,
    async () => userId ?? '',
  )
  const logs: string[] = []
  let response: { status: number; body: Envelope } | undefined
  await handler({
    req: {
      method,
      path,
      headers: userId === null ? {} : { 'x-appwrite-user-jwt': jwt },
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
export async function ok<T>(services: Services, options?: Parameters<typeof call>[1]): Promise<T> {
  const { status, body } = await call(services, options)
  if (!body.ok) throw new Error(`${status} ${JSON.stringify(body.error)}`)
  return body.data as T
}

/** The status, code and details of a failed request. */
export async function failure(
  services: Services,
  options?: Parameters<typeof call>[1],
): Promise<{ status: number; code: string; details?: unknown }> {
  const { status, body } = await call(services, options)
  if (body.ok) throw new Error(`Expected an error, got ${JSON.stringify(body.data)}`)
  return { status, code: body.error.code, details: body.error.details }
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
