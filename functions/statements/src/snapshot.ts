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
import { type Net, netsFromShares } from '@ledgerly/core/settle/nets'
import {
  buildStatementSnapshot,
  mergedClosings,
  mergedShares,
} from '@ledgerly/core/statements/snapshot'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { Query } from 'node-appwrite'
import { z } from 'zod'
import { chunks, getRowOrNull, invalid, listAll } from './shared'

type Line = StatementSnapshot['lines'][number]

/**
 * Who has a member row in the group, and who each merged person with none was merged into, as
 * one snapshot read them (statements.md#core-rules, rule 2).
 */
export type Membership = {
  inGroup: ReadonlySet<string>
  mergedInto: ReadonlyMap<string, string | null>
}

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
 * which finalize step 4 locks, and the membership it used, so finalize's check (step 5) counts
 * people the same way even if a merge changes a member row meanwhile.
 */
export async function computeSnapshot(
  db: Db,
  group: Groups,
  period: DateRange,
  now: Date,
  statementId?: string,
): Promise<{ snapshot: StatementSnapshot; unlockedIds: string[]; membership: Membership }> {
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
  // Rule 2: a merged person with no member row counts as the person they were merged into.
  const closings = (previous?.people ?? []).map((person) => ({
    personId: person.personId,
    netCents: person.closingCents,
  }))
  const inGroup = new Set(members.map((member) => member.personId))
  const mergedInto = await mergedIntoOf(
    db,
    [
      ...closings.map((net) => net.personId),
      ...[...shares.values()].flat().map((share) => share.personId),
    ],
    inGroup,
  )
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
    previousClosing: previous ? mergedClosings(closings, inGroup, mergedInto) : [],
    lines: transactions.map((row) =>
      lineOf(row, mergedShares(shares.get(row.$id) ?? [], inGroup, mergedInto)),
    ),
    ...(type === 'invoice' ? await invoiceParties(db, group, members) : {}),
    generatedAt: now.toISOString(),
  })
  return {
    snapshot,
    unlockedIds: unlocked.map((row) => row.$id),
    membership: { inGroup, mergedInto },
  }
}

/**
 * `known` plus `mergedInto` for every other person in `personIds` with no member row in the
 * group, following each chain once (statements.md#core-rules, rule 2). Reads `persons` only for
 * those, which is rare: a merge in progress, or a closing from before one.
 */
async function mergedIntoOf(
  db: Db,
  personIds: readonly string[],
  inGroup: ReadonlySet<string>,
  known: ReadonlyMap<string, string | null> = new Map(),
): Promise<Map<string, string | null>> {
  const mergedInto = new Map(known)
  let unread = [...new Set(personIds)].filter((id) => !inGroup.has(id) && !mergedInto.has(id))
  while (unread.length > 0) {
    for (const id of unread) mergedInto.set(id, null)
    const rows = (
      await Promise.all(
        chunks(unread).map((ids) =>
          listAll<Persons>(db, TABLES.persons, [Query.equal('$id', ids)]),
        ),
      )
    ).flat()
    for (const row of rows) mergedInto.set(row.$id, row.mergedInto)
    unread = [
      ...new Set(
        rows.flatMap((row) =>
          row.mergedInto && !inGroup.has(row.mergedInto) && !mergedInto.has(row.mergedInto)
            ? [row.mergedInto]
            : [],
        ),
      ),
    ]
  }
  return mergedInto
}

/**
 * `shares` with a merged person who has no member row counted as the person they were merged
 * into (rule 2), for finalize's fresh sum (step 5). It uses the snapshot's `membership`, reading
 * `persons` only for people the snapshot didn't name.
 */
export async function sharesInGroup(
  db: Db,
  { inGroup, mergedInto }: Membership,
  shares: readonly Shares[],
): Promise<Net[]> {
  const all = await mergedIntoOf(
    db,
    shares.map((share) => share.personId),
    inGroup,
    mergedInto,
  )
  return netsFromShares(mergedShares(shares, inGroup, all))
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

function lineOf(row: Transactions, shares: readonly Line['shares'][number][]): Line {
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
