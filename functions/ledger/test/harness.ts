import type { Activity, Items, Shares, Transactions } from '@ledgerly/core/generated/rows'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { createHandler, type Route } from '@ledgerly/server/http/create-handler'
import { createTransaction } from '../src/routes/transactions-create'
import { postTransaction } from '../src/routes/transactions-post'
import type { TransactionView } from '../src/routes/transactions-shared'
import { updateTransaction } from '../src/routes/transactions-update'
import { voidTransaction } from '../src/routes/transactions-void'
import { setTeamsForTests } from '../src/teams'

// "Today" in every test: 2026-10-18 in Sydney.
export const NOW = new Date('2026-10-18T01:00:00.000Z')

const routes: Route[] = [createTransaction, updateTransaction, postTransaction, voidTransaction]

export const member = (
  $id: string,
  groupId: string,
  personId: string,
  role: 'admin' | 'member' | 'viewer',
  status: 'active' | 'placeholder' | 'left' = 'active',
) => ({ $id, groupId, personId, displayName: personId, role, status, joinedOn: '2026-01-01' })

export const GROUPS = [
  {
    $id: 'house',
    type: 'house',
    name: 'House',
    ownerPersonId: 'alice',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    settingsJson: JSON.stringify({ type: 'house', autoFinalize: false, defaultBillSplit: 'equal' }),
    archivedAt: null,
  },
  {
    $id: 'job',
    type: 'employer',
    name: 'Acme',
    ownerPersonId: 'sam',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    settingsJson: JSON.stringify({
      type: 'employer',
      defaultRateCents: 2500,
      paymentTermsDays: 14,
      autoFinalize: false,
      recipients: [],
    }),
    archivedAt: null,
  },
]

export const MEMBERS = [
  member('m-alice', 'house', 'alice', 'admin'),
  member('m-bob', 'house', 'bob', 'member'),
  member('m-cara', 'house', 'cara', 'viewer'),
  member('m-pat', 'house', 'pat', 'member', 'placeholder'),
  // Moved out: leaving makes a member a viewer (functions-api.md#groups).
  member('m-lee', 'house', 'lee', 'viewer', 'left'),
  member('m-sam', 'job', 'sam', 'admin'),
  member('m-acme', 'job', 'acme', 'member', 'placeholder'),
]

/**
 * Two groups: a house (`house`) with Alice (admin), Bob (member), Cara (viewer) and Pat
 * (placeholder), and an employer group (`job`) where Sam works for Acme. Dan has an account
 * but is in neither.
 */
export function seed(extra: Record<string, Record<string, unknown>[]> = {}): FakeDb {
  return new FakeDb({
    persons: [
      { $id: 'alice', userId: 'u-alice', displayName: 'Alice' },
      { $id: 'bob', userId: 'u-bob', displayName: 'Bob' },
      { $id: 'cara', userId: 'u-cara', displayName: 'Cara' },
      { $id: 'pat', userId: null, displayName: 'Pat' },
      { $id: 'lee', userId: 'u-lee', displayName: 'Lee' },
      { $id: 'sam', userId: 'u-sam', displayName: 'Sam' },
      { $id: 'acme', userId: null, displayName: 'Acme' },
      { $id: 'dan', userId: 'u-dan', displayName: 'Dan' },
    ],
    groups: GROUPS,
    members: MEMBERS,
    ...extra,
  })
}

/** A house expense of $90.00 paid by Alice, split equally between Alice and Bob. */
export function expense(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    groupId: 'house',
    kind: 'expense',
    date: '2026-10-10',
    description: 'Groceries',
    totalCents: 9000,
    split: { mode: 'equal', personIds: ['alice', 'bob'] },
    ...extra,
  }
}

const quitters = new WeakMap<FakeDb, Set<string>>()

/** `userId` left a group on their own: their row stays `left`, but they're out of its team. */
export function leftOnTheirOwn(db: FakeDb, userId: string): void {
  quitters.set(db, new Set([...(quitters.get(db) ?? []), userId]))
}

// Team ID = group ID: every joined member's user, including people who moved out.
function teamsOf(db: FakeDb): FakeTeams {
  const users = new Map(db.rows('persons').map((row) => [row.$id, row.userId as string | null]))
  const teams: Record<string, string[]> = {}
  for (const row of db.rows('members')) {
    const userId = users.get(row.personId as string)
    if (!userId || row.status === 'placeholder' || quitters.get(db)?.has(userId)) continue
    teams[row.groupId as string] = [...(teams[row.groupId as string] ?? []), userId]
  }
  return new FakeTeams(teams)
}

export type Response = {
  status: number
  body: { ok: boolean; data?: TransactionView; error?: { code: string; message: string } }
}

/** Calls the ledger function as `user` (a userId), with a valid JWT for them. */
export async function call(
  db: FakeDb,
  method: string,
  path: string,
  body: unknown,
  user: string | null = 'u-alice',
): Promise<Response> {
  setTeamsForTests(teamsOf(db))
  const handler = createHandler(
    routes,
    () => db,
    async (jwt) => jwt.slice('jwt-'.length),
  )
  let response: Response | undefined
  await handler({
    req: {
      method,
      path,
      headers: user ? { 'x-appwrite-user-jwt': `jwt-${user}` } : {},
      bodyText: body === undefined ? '' : JSON.stringify(body),
    },
    res: { json: (data: Response['body'], status: number) => (response = { status, body: data }) },
    log: () => {},
    error: () => {},
  })
  return response as Response
}

export const rows = {
  transactions: (db: FakeDb) => db.rows('transactions') as unknown as Transactions[],
  shares: (db: FakeDb) =>
    (db.rows('shares') as unknown as Shares[]).sort((a, b) => (a.personId < b.personId ? -1 : 1)),
  items: (db: FakeDb) =>
    (db.rows('items') as unknown as Items[]).sort((a, b) => a.position - b.position),
  activity: (db: FakeDb) => db.rows('activity') as unknown as Activity[],
}

export const amounts = (shares: Shares[]) =>
  shares.map(({ personId, givenCents, receivedCents }) => ({ personId, givenCents, receivedCents }))
