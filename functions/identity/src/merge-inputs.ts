import type { Items, Schedules, Shares, Transactions } from '@ledgerly/core/generated/rows'
import { type Merge, mergeInput, mergeSplit } from '@ledgerly/core/identity/merge-input'
import { transactionTemplateSchema } from '@ledgerly/core/schemas/ledger'
import { splitSpecSchema } from '@ledgerly/core/schemas/split'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import { activityWrite, storedInputSchema } from '@ledgerly/server/ledger/transactions'
import { Query } from 'node-appwrite'
import { Changed, Finalizing, isFinalizing, MERGE_BATCH } from './merge'
import { getRowOrNull, isAppwriteError } from './rows'

// identity-and-invites.md#merging-two-persons, step 3, inputs. Logs hold IDs and counts only.

/** Transactions read per page while looking for the ones that name P. */
const PAGE = 50

/** Item writes per rewrite, so one with its input write and the group's guard fits a batch. */
const ITEMS_PER_REWRITE = MERGE_BATCH - 2

/** Why the merge voids a payment or loan whose two sides are now both U. */
export const VOID_REASON = 'Both sides are now the same person.'

/** What became of the groups a call looked at. `done`: every one was read to the end. */
export type InputsResult = { rewritten: number; voided: number; putOff: string[]; done: boolean }

/** One transaction's change: the writes, and the rows to read again once they're staged. */
type Rewrite = { row: Transactions; items: Items[]; writes: Write[]; voided: boolean }

/**
 * Step 3, inputs: P becomes U inside the stored input (`inputJson`) and the items' `splitJson`
 * of every transaction in `groupIds` that isn't locked or void (`idx_group_statement_date`), as
 * `mergeInput` and `mergeSplit` say. A payment or loan whose two sides are now both U is voided
 * instead, as the ledger voids one. Each batch guards its group and checks for a `finalizing`
 * statement first, as for shares, and a group with one is put off. It stops once `deadline`
 * (epoch ms) has passed.
 */
export async function moveInputs(
  db: Db,
  merge: Merge,
  groupIds: readonly string[],
  now: Date,
  deadline: number,
): Promise<InputsResult> {
  const result: InputsResult = { rewritten: 0, voided: 0, putOff: [], done: true }
  for (const groupId of groupIds) {
    const outcome = await moveGroupInputs(db, merge, groupId, now, deadline, result)
    if (outcome === 'putOff') result.putOff.push(groupId)
    if (outcome === 'cutOff') {
      result.done = false
      break
    }
  }
  if (result.putOff.length > 0) result.done = false
  return result
}

async function moveGroupInputs(
  db: Db,
  merge: Merge,
  groupId: string,
  now: Date,
  deadline: number,
  result: InputsResult,
): Promise<'done' | 'putOff' | 'cutOff'> {
  let cursor: string | undefined
  for (;;) {
    if (Date.now() >= deadline) return 'cutOff'
    const { rows } = await db.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      queries: [
        Query.equal('groupId', groupId),
        Query.isNull('statementId'),
        Query.notEqual('status', 'void'),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    const rewrites = await planRewrites(db, rows, merge, now)
    try {
      for (const batch of batches(rewrites)) {
        await runBatch(db, groupId, batch)
        for (const rewrite of batch) {
          if (rewrite.voided) result.voided += 1
          else result.rewritten += 1
        }
      }
    } catch (error) {
      if (error instanceof Finalizing) return 'putOff'
      // A row changed after it was read: read this page again. Rows already rewritten no
      // longer name P, so they're left alone.
      if (error instanceof Changed || isAppwriteError(error, 409)) continue
      throw error
    }
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return 'done'
    cursor = last.$id
  }
}

/** The page's transactions whose input or items name P, with the writes that rename P. */
async function planRewrites(
  db: Db,
  rows: readonly Transactions[],
  merge: Merge,
  now: Date,
): Promise<Rewrite[]> {
  const items = await listByTransaction<Items>(db, TABLES.items, rows)
  const rewrites: Rewrite[] = []
  for (const row of rows) {
    const stored = storedInputSchema.parse(JSON.parse(row.inputJson))
    const { input, voided } = mergeInput(stored, row.kind, merge)
    if (voided) {
      const shares = await listByTransaction<Shares>(db, TABLES.shares, [row])
      rewrites.push({ row, items: [], writes: voidWrites(row, shares, merge.into, now), voided })
      continue
    }
    const ownItems = items.filter((item) => item.transactionId === row.$id)
    const changedItems = ownItems.flatMap((item) => {
      const split = splitSpecSchema.parse(JSON.parse(item.splitJson))
      const splitJson = JSON.stringify(mergeSplit(split, merge))
      return splitJson === item.splitJson ? [] : [{ item, splitJson }]
    })
    const inputJson = JSON.stringify(input)
    const inputChanged = inputJson !== JSON.stringify(stored)
    if (!inputChanged && changedItems.length === 0) continue
    // A long receipt's items go over several rewrites; the input goes with the first.
    for (let start = 0; start === 0 || start < changedItems.length; start += ITEMS_PER_REWRITE) {
      const part = changedItems.slice(start, start + ITEMS_PER_REWRITE)
      rewrites.push({
        row,
        items: part.map(({ item }) => item),
        writes: [
          ...(inputChanged && start === 0
            ? [
                {
                  action: 'update' as const,
                  tableId: TABLES.transactions,
                  rowId: row.$id,
                  data: { inputJson },
                },
              ]
            : []),
          ...part.map(({ item, splitJson }) => ({
            action: 'update' as const,
            tableId: TABLES.items,
            rowId: item.$id,
            data: { splitJson },
          })),
        ],
        voided: false,
      })
    }
  }
  return rewrites
}

/** As `POST /transactions/{id}/void` does it: the status and reason, no shares, an activity row. */
function voidWrites(row: Transactions, shares: Shares[], by: string, now: Date): Write[] {
  return [
    {
      action: 'update',
      tableId: TABLES.transactions,
      rowId: row.$id,
      data: { status: 'void', voidReason: VOID_REASON },
    },
    ...shares.map((share) => ({
      action: 'delete' as const,
      tableId: TABLES.shares,
      rowId: share.$id,
    })),
    activityWrite(
      row,
      by,
      'transaction.voided',
      `Voided “${row.description}”`,
      {
        status: { before: row.status, after: 'void' },
        voidReason: { before: null, after: VOID_REASON },
      },
      now,
    ),
  ]
}

/** Rewrites packed into batches of at most `MERGE_BATCH` writes, the group's guard included. */
function batches(rewrites: readonly Rewrite[]): Rewrite[][] {
  const result: Rewrite[][] = []
  let batch: Rewrite[] = []
  let size = 1
  for (const rewrite of rewrites) {
    if (batch.length > 0 && size + rewrite.writes.length > MERGE_BATCH) {
      result.push(batch)
      batch = []
      size = 1
    }
    batch.push(rewrite)
    size += rewrite.writes.length
  }
  if (batch.length > 0) result.push(batch)
  return result
}

/**
 * One batch: the guard first (ledger.md#concurrency), then the finalizing check, the writes, and
 * the rows read again as stored, so one posted, edited or voided meanwhile runs it again.
 */
async function runBatch(db: Db, groupId: string, batch: readonly Rewrite[]): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.write({
      action: 'update',
      tableId: TABLES.groups,
      rowId: groupId,
      data: { rev: randomId() },
    })
    if (await isFinalizing(db, groupId)) throw new Finalizing()
    await tx.write(...batch.flatMap((rewrite) => rewrite.writes))
    const rows = await listById<Transactions>(
      db,
      TABLES.transactions,
      batch.map((rewrite) => rewrite.row.$id),
    )
    const items = await listById<Items>(
      db,
      TABLES.items,
      batch.flatMap((rewrite) => rewrite.items.map((item) => item.$id)),
    )
    const same =
      batch.every((rewrite) => {
        const now = rows.get(rewrite.row.$id)
        return (
          now?.status === rewrite.row.status &&
          now.statementId === null &&
          now.inputJson === rewrite.row.inputJson
        )
      }) &&
      batch.every((rewrite) =>
        rewrite.items.every((item) => items.get(item.$id)?.splitJson === item.splitJson),
      )
    if (!same) throw new Changed()
  })
}

/** Rows of `tableId` whose `transactionId` is one of `rows`' (`idx_transactionId`). */
async function listByTransaction<R extends Items | Shares>(
  db: Db,
  tableId: typeof TABLES.items | typeof TABLES.shares,
  rows: readonly Transactions[],
): Promise<R[]> {
  if (rows.length === 0) return []
  const found: R[] = []
  let cursor: string | undefined
  for (;;) {
    const { rows: page } = await db.listRows<R>({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        Query.equal(
          'transactionId',
          rows.map((row) => row.$id),
        ),
        Query.orderAsc('$id'),
        Query.limit(100),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    found.push(...page)
    const last = page.at(-1)
    if (!last || page.length < 100) return found
    cursor = last.$id
  }
}

/** The stored rows with these IDs, by ID: what's stored, not a transaction's view of it. */
async function listById<R extends Transactions | Items>(
  db: Db,
  tableId: typeof TABLES.transactions | typeof TABLES.items,
  ids: readonly string[],
): Promise<Map<string, R>> {
  if (ids.length === 0) return new Map()
  const { rows } = await db.listRows<R>({
    databaseId: DATABASE_ID,
    tableId,
    queries: [Query.equal('$id', [...ids]), Query.limit(ids.length)],
    total: false,
  })
  return new Map(rows.map((row) => [row.$id, row]))
}

/** The schedule columns an expansion, edit or end writes: any change means read it again. */
const SCHEDULE_COLUMNS = [
  'templateJson',
  'rrule',
  'startsOn',
  'endsOn',
  'exdates',
  'generatedThrough',
  'nextRunAt',
] as const

/** What became of the groups' schedules. `done`: every group was read to the end. */
export type TemplatesResult = { rewritten: number; putOff: string[]; done: boolean }

/**
 * Step 3, templates: P becomes U inside `schedules.templateJson` in `groupIds`
 * (`idx_groupId`), one schedule at a time. Each write guards the group and checks for a
 * `finalizing` statement, as for inputs, then is staged with the schedule guard: the schedule
 * row is written, then read again as stored, so an expansion, edit or end that got there first
 * runs it again (scheduling.md). No schedule kind is a payment or loan, so none is voided.
 */
export async function moveTemplates(
  db: Db,
  merge: Merge,
  groupIds: readonly string[],
  deadline: number,
): Promise<TemplatesResult> {
  const result: TemplatesResult = { rewritten: 0, putOff: [], done: true }
  for (const groupId of groupIds) {
    const outcome = await moveGroupTemplates(db, merge, groupId, deadline, result)
    if (outcome === 'putOff') result.putOff.push(groupId)
    if (outcome === 'cutOff') {
      result.done = false
      break
    }
  }
  if (result.putOff.length > 0) result.done = false
  return result
}

async function moveGroupTemplates(
  db: Db,
  merge: Merge,
  groupId: string,
  deadline: number,
  result: TemplatesResult,
): Promise<'done' | 'putOff' | 'cutOff'> {
  let cursor: string | undefined
  for (;;) {
    if (Date.now() >= deadline) return 'cutOff'
    const { rows } = await db.listRows<Schedules>({
      databaseId: DATABASE_ID,
      tableId: TABLES.schedules,
      queries: [
        Query.equal('groupId', groupId),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    let changed = false
    for (const schedule of rows) {
      const templateJson = renamedTemplate(schedule, merge)
      if (templateJson === undefined) continue
      if (Date.now() >= deadline) return 'cutOff'
      try {
        await rewriteTemplate(db, groupId, schedule, templateJson)
        result.rewritten += 1
      } catch (error) {
        if (error instanceof Finalizing) return 'putOff'
        if (!(error instanceof Changed || isAppwriteError(error, 409))) throw error
        // It changed after it was read: read this page again, as it is now.
        changed = true
        break
      }
    }
    if (changed) continue
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return 'done'
    cursor = last.$id
  }
}

/** The schedule's template with P renamed, or undefined when it doesn't name P. */
function renamedTemplate(schedule: Schedules, merge: Merge): string | undefined {
  const template = transactionTemplateSchema.parse(JSON.parse(schedule.templateJson))
  const templateJson = JSON.stringify(mergeInput(template, schedule.kind, merge).input)
  return templateJson === JSON.stringify(template) ? undefined : templateJson
}

/** One template: the group's guard and the finalizing check, then the schedule guard. */
async function rewriteTemplate(
  db: Db,
  groupId: string,
  schedule: Schedules,
  templateJson: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.write({
      action: 'update',
      tableId: TABLES.groups,
      rowId: groupId,
      data: { rev: randomId() },
    })
    if (await isFinalizing(db, groupId)) throw new Finalizing()
    await tx.write({
      action: 'update',
      tableId: TABLES.schedules,
      rowId: schedule.$id,
      data: { templateJson },
    })
    const stored = await getRowOrNull<Schedules>(db, TABLES.schedules, schedule.$id)
    const same = SCHEDULE_COLUMNS.every(
      (column) => JSON.stringify(stored?.[column]) === JSON.stringify(schedule[column]),
    )
    if (!stored || !same) throw new Changed()
  })
}
