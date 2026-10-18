import type { TransactionKind, TransactionStatus } from '@ledgerly/core/constants/domain'
import { daysBetween, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type {
  Activity,
  Groups,
  Items,
  Members,
  Shares,
  Statements,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { buildShares, type LedgerContext, type Share } from '@ledgerly/core/ledger/build-shares'
import { assertShareInvariants } from '@ledgerly/core/ledger/invariants'
import { LedgerError } from '@ledgerly/core/ledger/ledger-error'
import { formatMoney } from '@ledgerly/core/money/format'
import { localDateSchema } from '@ledgerly/core/schemas/common'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import {
  type TransactionInput,
  type TransactionTemplate,
  transactionTemplateSchema,
} from '@ledgerly/core/schemas/ledger'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import type { Tx, Write } from '@ledgerly/server/appwrite/transaction'
import type { Membership } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { AppwriteException, ID, type Models, Query } from 'node-appwrite'
import { z } from 'zod'

/** functions-api.md#transactioninput: what `POST` and `PATCH` return. */
export type TransactionView = { transaction: Transactions; shares: Shares[]; items: Items[] }

const PAGE = 100
const LOCALE = 'en-AU'
// ledger.md#transaction-kinds: the kinds that have payers.
const PAYER_KINDS: readonly TransactionKind[] = ['expense', 'bill', 'loan']

/**
 * `transactions.inputJson` (data-model.md#transactions): the input's payers, split, shift,
 * bill period, payment, adjustment and note. Items are rows of their own, and the rest are
 * columns. Parsed on every read.
 */
export const storedInputSchema = transactionTemplateSchema
  .pick({ payers: true, split: true, shift: true, payment: true, adjustment: true, note: true })
  .extend({
    bill: z
      .strictObject({
        periodStart: localDateSchema.optional(),
        periodEnd: localDateSchema.optional(),
      })
      .optional(),
  })

export type StoredInput = z.infer<typeof storedInputSchema>

/**
 * Runs a ledger route: a broken ledger rule becomes its error code, and a commit that lost a
 * race (409) runs the whole route once more (functions-api.md#ledger, step 4).
 */
export async function ledgerRoute<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (error instanceof LedgerError) throw new AppError(error.code, error.message)
      if (!(error instanceof AppwriteException && error.code === 409)) throw error
      if (attempt === 2) {
        throw new AppError('CONFLICT', 'Someone changed this at the same time. Try again.')
      }
    }
  }
}

/** The body parsed with the route's schema, or VALIDATION_FAILED with the issues. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'Some fields are not valid.', result.error.issues)
  }
  return result.data
}

export function invalid(message: string): never {
  throw new AppError('VALIDATION_FAILED', message)
}

/** "creator or admin" (functions-api.md#ledger; permissions.md). */
export function requireCreatorOrAdmin(membership: Membership, row: Transactions): void {
  if (membership.member.role !== 'admin' && row.createdBy !== membership.person.$id) {
    throw new AppError('FORBIDDEN', 'Only the person who added this, or an admin, can change it.')
  }
}

/** The transaction, or NOT_FOUND. */
export async function getTransaction(db: Db, id: string): Promise<Transactions> {
  const row = await findTransaction(db, id)
  if (!row) throw new AppError('NOT_FOUND', 'This transaction does not exist.')
  return row
}

export async function findTransaction(db: Db, id: string): Promise<Transactions | undefined> {
  try {
    return await db.getRow<Transactions>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      rowId: id,
    })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}

/** A date at most 1 year after today in the group's timezone (functions-api.md#validation). */
export function requireNotTooFarAhead(date: LocalDate, group: Groups, now: Date): void {
  if (daysBetween(localToday(group.timezone, now), date) > 366) {
    invalid('The date can be at most a year from today.')
  }
}

/** LOCKED if the transaction is on a statement (I-7). */
export function requireUnlocked(row: Pick<Transactions, 'statementId'>): void {
  if (row.statementId) {
    throw new AppError('LOCKED', 'This transaction is on a finalized statement and can’t change.')
  }
}

/**
 * LOCKED while a statement of the group that covers one of these dates is `finalizing`
 * (statements.md#2-finalize, step 1). Finalizing statements are rare, so the query uses
 * `idx_status`.
 */
export async function requireNotFinalizing(
  db: Db,
  groupId: string,
  dates: readonly string[],
): Promise<void> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('status', 'finalizing'), Query.equal('groupId', groupId)],
  })
  if (rows.some((statement) => dates.some((date) => date <= statement.periodEnd))) {
    throw new AppError(
      'LOCKED',
      'A statement covering this date is being finalized. Try again soon.',
    )
  }
}

export type Ledger = { ctx: LedgerContext; memberIds: string[] }

/** Everything `buildShares` needs about the group (build-shares.ts). */
export async function loadLedger(db: Db, membership: Membership): Promise<Ledger> {
  const { group } = membership
  // I-3: every member row counts, placeholders and people who left included.
  const members = await listAll<Members>(db, TABLES.members, [Query.equal('groupId', group.$id)])
  const settings = groupSettingsSchema.safeParse(JSON.parse(group.settingsJson))
  const defaultBillSplit =
    settings.success && settings.data.type === 'house' ? settings.data.defaultBillSplit : undefined
  return {
    ctx: {
      groupType: group.type,
      ownerPersonId: group.ownerPersonId,
      callerPersonId: membership.person.$id,
      members: members.map((member) => ({
        personId: member.personId,
        joinedOn: member.joinedOn as LocalDate,
        leftOn: (member.leftOn ?? null) as LocalDate | null,
      })),
      ...(defaultBillSplit ? { defaultBillSplit } : {}),
    },
    memberIds: members.map((member) => member.personId),
  }
}

/** What a write stores for a transaction, worked out before anything is written. */
export type Plan = {
  status: TransactionStatus
  totalCents: number
  shares: Share[]
  items: ItemData[]
  inputJson: string
  dueOn: string | null
}

type ItemData = Pick<
  Items,
  'position' | 'name' | 'quantity' | 'amountCents' | 'category' | 'splitJson'
>

/**
 * Builds the shares of `input` and checks the ledger invariants. A transaction that isn't
 * `posted` has no shares (I-6), but its shares are still built, to validate it and to get its
 * total. Missing payers become the caller, stored, so a later edit or post by someone else
 * doesn't move the payment to them.
 */
export function plan(
  input: TransactionTemplate & { kind: TransactionKind; date: LocalDate },
  status: TransactionStatus,
  ledger: Ledger,
): Plan {
  const built = buildShares(input, ledger.ctx)
  const shares = status === 'posted' ? built.shares : []
  if (shares.length > 0) {
    assertShareInvariants(
      { kind: input.kind, totalCents: built.totalCents },
      shares,
      ledger.memberIds,
    )
  }
  const payers =
    input.payers ??
    (PAYER_KINDS.includes(input.kind) && status === 'posted'
      ? [{ personId: ledger.ctx.callerPersonId, cents: built.totalCents }]
      : undefined)
  const { periodStart, periodEnd } = input.bill ?? {}
  const stored: StoredInput = {
    payers,
    split: input.split,
    shift: input.shift,
    bill: input.bill ? { periodStart, periodEnd } : undefined,
    payment: input.payment,
    adjustment: input.adjustment,
    note: input.note,
  }
  return {
    status,
    totalCents: built.totalCents,
    shares,
    items: (input.items ?? []).map((item, position) => ({
      position,
      name: item.name,
      quantity: item.quantity ?? 1,
      amountCents: item.amountCents,
      category: item.category ?? null,
      splitJson: JSON.stringify(item.split),
    })),
    // JSON.stringify drops the parts that are undefined.
    inputJson: JSON.stringify(stored),
    dueOn: input.bill?.dueOn ?? null,
  }
}

/** The input a stored transaction was made from, to post it or compare it. */
export async function storedInput(
  db: Db,
  row: Transactions,
): Promise<TransactionTemplate & { kind: TransactionKind; date: LocalDate }> {
  const { bill: period, ...stored } = storedInputSchema.parse(JSON.parse(row.inputJson))
  const items = await listItems(db, row.$id)
  return {
    ...stored,
    kind: row.kind,
    date: row.date as LocalDate,
    ...(row.category ? { category: row.category as TransactionTemplate['category'] } : {}),
    ...(row.kind === 'shift' || items.length > 0 ? {} : { totalCents: row.totalCents }),
    ...(items.length > 0
      ? {
          items: items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            amountCents: item.amountCents,
            ...(item.category
              ? { category: item.category as TransactionTemplate['category'] }
              : {}),
            split: JSON.parse(item.splitJson),
          })),
        }
      : {}),
    ...(row.kind === 'bill'
      ? {
          bill: {
            status: row.status === 'due' ? ('due' as const) : ('paid' as const),
            ...(row.dueOn ? { dueOn: row.dueOn as LocalDate } : {}),
            ...period,
          },
        }
      : {}),
  }
}

/** The `transactions` columns a write sets from the input and its plan. */
export function transactionColumns(input: TransactionInput, planned: Plan) {
  return {
    groupId: input.groupId,
    kind: input.kind,
    status: planned.status,
    date: input.date,
    description: input.description,
    category: input.category ?? null,
    totalCents: planned.totalCents,
    inputJson: planned.inputJson,
    dueOn: planned.dueOn,
  }
}

export function shareColumns(
  row: Pick<Transactions, '$id' | 'groupId' | 'date' | 'kind' | 'category'>,
  share: Share,
) {
  return {
    transactionId: row.$id,
    personId: share.personId,
    givenCents: share.givenCents,
    receivedCents: share.receivedCents,
    groupId: row.groupId,
    date: row.date,
    kind: row.kind,
    category: row.category,
  }
}

/** Every row of a table that matches, a page at a time (scaling.md). */
export async function listAll<R extends Models.Row>(
  db: Db,
  tableId: TableId,
  queries: string[],
): Promise<R[]> {
  const rows: R[] = []
  for (;;) {
    const last = rows.at(-1)
    const page = await db.listRows<R>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [...queries, Query.limit(PAGE), ...(last ? [Query.cursorAfter(last.$id)] : [])],
    })
    rows.push(...page.rows)
    if (page.rows.length < PAGE) return rows
  }
}

export function listShares(db: Db, transactionId: string): Promise<Shares[]> {
  return listAll<Shares>(db, TABLES.shares, [
    Query.equal('transactionId', transactionId),
    Query.orderAsc('personId'),
  ])
}

export function listItems(db: Db, transactionId: string): Promise<Items[]> {
  return listAll<Items>(db, TABLES.items, [
    Query.equal('transactionId', transactionId),
    Query.orderAsc('position'),
  ])
}

/**
 * Writes that replace `existing` rows with rows holding `data`, whole (D-007): existing rows
 * are overwritten in order, extra data gets new rows, and surplus rows are deleted. Reusing the
 * rows keeps a full rebuild of 15 shares and 30 items within one transaction's 90 writes.
 */
export function replaceRows(
  tableId: TableId,
  existing: readonly { $id: string }[],
  data: readonly Record<string, unknown>[],
  permissions: string[],
): Write[] {
  const writes: Write[] = data.map((row, index) => {
    const reuse = existing[index]
    return reuse
      ? { action: 'update', tableId, rowId: reuse.$id, data: row }
      : { action: 'create', tableId, rowId: ID.unique(), data: row, permissions }
  })
  for (const row of existing.slice(data.length)) {
    writes.push({ action: 'delete', tableId, rowId: row.$id })
  }
  return writes
}

/** Rows written by the ledger function are readable by the whole group (permissions.md). */
export function teamRead(groupId: string): string[] {
  return [`read("team:${groupId}")`]
}

type ActivityAction =
  | 'transaction.created'
  | 'transaction.updated'
  | 'transaction.posted'
  | 'transaction.voided'

/**
 * The `activity` row for a write. The summary names no one: the app shows the actor's name
 * from their member row.
 */
export function activityWrite(
  row: Pick<Transactions, '$id' | 'groupId' | 'description'>,
  actorPersonId: string,
  action: ActivityAction,
  summary: string,
  changes: Record<string, { before: unknown; after: unknown }> | null,
  now: Date,
): Write {
  const data: Omit<Activity, keyof Models.Row> = {
    groupId: row.groupId,
    actorPersonId,
    action,
    transactionId: row.$id,
    summary: summary.slice(0, 255),
    changesJson: changes && Object.keys(changes).length > 0 ? JSON.stringify(changes) : null,
    at: now.toISOString(),
  }
  return {
    action: 'create',
    tableId: TABLES.activity,
    rowId: ID.unique(),
    data,
    permissions: teamRead(row.groupId),
  }
}

export function money(cents: number, group: Groups): string {
  return formatMoney(cents, group.currency, LOCALE)
}

/** The columns that differ, as `{ column: { before, after } }`. */
export function changedColumns(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {}
  for (const [column, value] of Object.entries(after)) {
    if (JSON.stringify(before[column] ?? null) !== JSON.stringify(value ?? null)) {
      changes[column] = { before: before[column] ?? null, after: value ?? null }
    }
  }
  return changes
}

/**
 * Guards the transaction row (conventions.md#functions): stages a write that only sets
 * `updatedBy`, then reads the row in the transaction and checks that it is unlocked and still
 * in one of `statuses`. Anyone who changes the row after this makes the commit fail with 409,
 * so the route's own write can't undo a lock, a post or a void it never saw.
 */
export async function guardTransaction(
  tx: Tx,
  db: Db,
  rowId: string,
  updatedBy: string,
  statuses: readonly TransactionStatus[],
): Promise<Transactions> {
  await tx.write({ action: 'update', tableId: TABLES.transactions, rowId, data: { updatedBy } })
  const staged = await db.getRow<Transactions>({
    databaseId: DATABASE_ID,
    tableId: TABLES.transactions,
    rowId,
    transactionId: tx.id,
  })
  requireUnlocked(staged)
  if (!statuses.includes(staged.status)) {
    throw new AppError('CONFLICT', 'Someone changed this at the same time. Try again.')
  }
  return staged
}

/** The transaction with its shares and items, as committed. */
export async function readView(db: Db, id: string): Promise<TransactionView> {
  const transaction = await getTransaction(db, id)
  const [shares, items] = await Promise.all([listShares(db, id), listItems(db, id)])
  return { transaction, shares, items }
}
