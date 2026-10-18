import type { DateRange, LocalDate } from '@ledgerly/core/dates/local-date'
import type {
  Groups,
  Members,
  Persons,
  Profiles,
  Shares,
  Statements,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { businessDetailsSchema } from '@ledgerly/core/schemas/identity'
import { type StatementSnapshot, statementSnapshotSchema } from '@ledgerly/core/schemas/statements'
import { buildStatementSnapshot } from '@ledgerly/core/statements/snapshot'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'
import { z } from 'zod'
import { chunks, getRowOrNull, invalid, listAll } from './shared'

type Line = StatementSnapshot['lines'][number]

// A shift's stored input keeps its minutes and rate (ledger.md#shifts).
const storedShiftSchema = z.looseObject({
  shift: z.looseObject({ minutes: z.int(), rateCents: z.int() }).optional(),
})

/** `invoice` for employer groups, `divide` for houses; other groups have no statements. */
export function statementTypeOf(group: Groups): Statements['type'] {
  if (group.type === 'employer') return 'invoice'
  if (group.type === 'house') return 'divide'
  throw invalid('Only employer and house groups have statements.')
}

/**
 * A group's snapshot for `period` (statements.md#snapshot): every posted transaction that isn't
 * locked and is dated on or before the period end, plus those already locked to `statementId`
 * (an interrupted finalize, step 3). The opening is the closing of the latest final statement
 * that ends before this period does. Also returns the IDs of the transactions not locked yet,
 * which finalize step 4 locks.
 */
export async function computeSnapshot(
  db: Db,
  group: Groups,
  period: DateRange,
  now: Date,
  statementId?: string,
): Promise<{ snapshot: StatementSnapshot; unlockedIds: string[] }> {
  const type = statementTypeOf(group)
  const [members, unlocked, locked, previous] = await Promise.all([
    listAll<Members>(db, TABLES.members, [Query.equal('groupId', group.$id)]),
    listAll<Transactions>(db, TABLES.transactions, [
      Query.equal('groupId', group.$id),
      Query.isNull('statementId'),
      Query.lessThanEqual('date', period.end),
      Query.equal('status', 'posted'),
    ]),
    statementId
      ? listAll<Transactions>(db, TABLES.transactions, [
          Query.equal('groupId', group.$id),
          Query.equal('statementId', statementId),
        ])
      : [],
    previousFinal(db, group.$id, period),
  ])
  // Another run of this finalize can lock a transaction between the two reads, putting it in
  // both: it counts once.
  const transactions = [...new Map([...unlocked, ...locked].map((row) => [row.$id, row])).values()]
  const shares = await sharesOf(db, transactions)
  const snapshot = buildStatementSnapshot({
    group: {
      id: group.$id,
      name: group.name,
      type: group.type as 'employer' | 'house',
      currency: group.currency,
      timezone: group.timezone,
    },
    period,
    people: members.map((member) => ({ personId: member.personId, name: member.displayName })),
    previousClosing: previous
      ? previous.people.map((person) => ({
          personId: person.personId,
          netCents: person.closingCents,
        }))
      : [],
    lines: transactions.map((row) => lineOf(row, shares.get(row.$id) ?? [])),
    ...(type === 'invoice' ? await invoiceParties(db, group, members) : {}),
    generatedAt: now.toISOString(),
  })
  return { snapshot, unlockedIds: unlocked.map((row) => row.$id) }
}

/** The snapshot of the latest final statement ending before `period` does, if there is one. */
async function previousFinal(
  db: Db,
  groupId: string,
  period: DateRange,
): Promise<StatementSnapshot | undefined> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('status', 'final'),
      Query.lessThan('periodEnd', period.end),
      Query.orderDesc('periodEnd'),
      Query.limit(1),
    ],
    total: false,
  })
  const [row] = rows
  return row ? statementSnapshotSchema.parse(JSON.parse(row.snapshotJson)) : undefined
}

/** The shares of `transactions`, by transaction ID. */
export async function sharesOf(
  db: Db,
  transactions: readonly Transactions[],
): Promise<Map<string, Shares[]>> {
  const byTransaction = new Map<string, Shares[]>()
  for (const ids of chunks(transactions.map((row) => row.$id))) {
    for (const share of await listAll<Shares>(db, TABLES.shares, [
      Query.equal('transactionId', ids),
    ])) {
      byTransaction.set(share.transactionId, [
        ...(byTransaction.get(share.transactionId) ?? []),
        share,
      ])
    }
  }
  return byTransaction
}

function lineOf(row: Transactions, shares: readonly Shares[]): Line {
  const { shift } = storedShiftSchema.parse(JSON.parse(row.inputJson))
  return {
    transactionId: row.$id,
    date: row.date as LocalDate,
    kind: row.kind,
    description: row.description,
    ...(row.category ? { category: row.category } : {}),
    totalCents: row.totalCents,
    ...(row.kind === 'shift' && shift
      ? { shift: { minutes: shift.minutes, rateCents: shift.rateCents } }
      : {}),
    shares: shares
      .map(({ personId, givenCents, receivedCents }) => ({ personId, givenCents, receivedCents }))
      .sort((a, b) => (a.personId < b.personId ? -1 : 1)),
  }
}

/**
 * An invoice's issuer (the worker who owns the employer group, with their business details)
 * and recipient (the employer, at the group's billing emails), and the payment terms.
 */
async function invoiceParties(db: Db, group: Groups, members: readonly Members[]) {
  const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
  if (settings.type !== 'employer') throw new Error('An employer group needs employer settings')
  const worker = members.find((member) => member.personId === group.ownerPersonId)
  const employer = members.find((member) => member.personId !== group.ownerPersonId)
  const person = await getRowOrNull<Persons>(db, TABLES.persons, group.ownerPersonId)
  const profile = person?.userId
    ? await getRowOrNull<Profiles>(db, TABLES.profiles, person.userId)
    : null
  return {
    issuer: worker && {
      personId: worker.personId,
      name: worker.displayName,
      business: profile?.businessJson
        ? businessDetailsSchema.parse(JSON.parse(profile.businessJson))
        : {},
    },
    recipient: employer && {
      personId: employer.personId,
      name: employer.displayName,
      emails: settings.recipients,
    },
    paymentTermsDays: settings.paymentTermsDays,
  }
}
