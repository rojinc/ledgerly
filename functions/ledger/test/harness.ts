import type { Activity, Items, Shares, Transactions } from '@ledgerly/core/generated/rows'
import type { TransactionView } from '@ledgerly/core/schemas/ledger'
import { FakeDb } from '@ledgerly/server/appwrite/fake'
import { FakeTeams } from '@ledgerly/server/appwrite/fake-teams'
import { createHandler } from '@ledgerly/server/http/create-handler'
import { ledgerRoutes } from '../src/main'
import type { Files, ReceiptFile } from '../src/receipts'

// "Today" in every test: 2026-10-18 in Sydney.
export const NOW = new Date('2026-10-18T01:00:00.000Z')

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
  {
    $id: 'sam-own',
    type: 'personal',
    name: 'Personal',
    ownerPersonId: 'sam',
    currency: 'AUD',
    timezone: 'Australia/Sydney',
    region: 'AU-NSW',
    settingsJson: JSON.stringify({ type: 'personal' }),
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
  member('m-sam-own', 'sam-own', 'sam', 'admin'),
]

/**
 * Three groups: a house (`house`) with Alice (admin), Bob (member), Cara (viewer) and Pat
 * (placeholder), an employer group (`job`) where Sam works for Acme, and Sam's personal group
 * (`sam-own`). Dan has an account but is in none.
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

/** Storage's receipts bucket, in memory. */
export class FakeFiles implements Files {
  readonly stored = new Map<string, ReceiptFile>()

  /** A file as the web app uploads it: a photo readable by the group's team. */
  upload(fileId: string, groupId = 'house', file: Partial<ReceiptFile> = {}): void {
    this.stored.set(fileId, {
      mimeType: 'image/webp',
      permissions: [`read("team:${groupId}")`],
      complete: true,
      ...file,
    })
  }

  permissions(fileId: string): string[] | undefined {
    return this.stored.get(fileId)?.permissions
  }

  async getFile(fileId: string): Promise<ReceiptFile | undefined> {
    const file = this.stored.get(fileId)
    return file && { ...file, permissions: [...file.permissions] }
  }

  async updateFile(fileId: string, permissions: string[]): Promise<ReceiptFile | undefined> {
    const file = this.stored.get(fileId)
    if (!file) return undefined
    const updated = { ...file, permissions: [...permissions] }
    this.stored.set(fileId, updated)
    return { ...updated, permissions: [...permissions] }
  }
}

const fileStores = new WeakMap<FakeDb, FakeFiles>()

/** The receipts bucket that goes with `db`. */
export function filesOf(db: FakeDb): FakeFiles {
  let files = fileStores.get(db)
  if (!files) {
    files = new FakeFiles()
    fileStores.set(db, files)
  }
  return files
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

export type Response<T = TransactionView> = {
  status: number
  body: {
    ok: boolean
    data?: T
    error?: { code: string; message: string; details?: unknown }
  }
}

/** Calls the ledger function as `user` (a userId), with a valid JWT for them. */
export async function call<T = TransactionView>(
  db: FakeDb,
  method: string,
  path: string,
  body: unknown,
  user: string | null = 'u-alice',
): Promise<Response<T>> {
  const teams = teamsOf(db)
  const files = filesOf(db)
  const handler = createHandler(
    ledgerRoutes(() => ({ teams, files })),
    () => db,
    async (jwt) => jwt.slice('jwt-'.length),
  )
  let response: Response<T> | undefined
  await handler({
    req: {
      method,
      path,
      headers: user ? { 'x-appwrite-user-jwt': `jwt-${user}` } : {},
      bodyText: body === undefined ? '' : JSON.stringify(body),
    },
    res: {
      json: (data: Response<T>['body'], status: number) => (response = { status, body: data }),
    },
    log: () => {},
    error: () => {},
  })
  return response as Response<T>
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
