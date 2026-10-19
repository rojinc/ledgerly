import { MAX_OPS_PER_DB_TRANSACTION } from '@ledgerly/core/constants/limits'
import type { DateRange, LocalDate } from '@ledgerly/core/dates/local-date'
import type {
  Groups,
  Items,
  Persons,
  Schedules,
  Shares,
  Transactions,
} from '@ledgerly/core/generated/rows'
import {
  type Merge,
  mergeInput,
  mergePostedSplit,
  mergeSplit,
} from '@ledgerly/core/identity/merge-input'
import type { LedgerContext } from '@ledgerly/core/ledger/build-shares'
import type { LedgerMember } from '@ledgerly/core/ledger/split-amount'
import {
  type MergeCursors,
  type MergeMembers,
  mergeCursorsSchema,
} from '@ledgerly/core/schemas/identity'
import { transactionTemplateSchema } from '@ledgerly/core/schemas/ledger'
import { splitSpecSchema } from '@ledgerly/core/schemas/split'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { randomId } from '@ledgerly/server/identity/random-id'
import {
  activityWrite,
  listAll,
  listShares,
  loadGroupLedger,
  Raced,
  type StoredInput,
  storedInputSchema,
} from '@ledgerly/server/ledger/transactions'
import { Query } from 'node-appwrite'
import type { z } from 'zod'
import { dropBalances, Finalizing, guardInto, isFinalizing } from './merge'
import { getRowOrNull, isAppwriteError } from './rows'

// identity-and-invites.md#merging-two-persons, step 3, inputs. Logs hold IDs and counts only.

/** Transactions read per page while looking for the ones that name P. */
const PAGE = 100

/** Why the merge voids a payment or loan whose two sides are now both U. */
export const VOID_REASON = 'Both sides are now the same person.'

/**
 * What became of the groups a call looked at. `skipped`: rows whose stored input can't be renamed
 * (unreadable, or invalid once renamed), left as they are and logged by ID. A locked row like that
 * is logged and left too, but not counted: nothing can change it, so it doesn't hold the merge
 * open. `cutOff`: the deadline stopped it. `done`: every group was read to the end, with nothing
 * put off or skipped.
 */
export type InputsResult = {
  rewritten: number
  voided: number
  skipped: number
  putOff: string[]
  cutOff: boolean
  done: boolean
}

/** One transaction's change: the writes, and the rows to read again once they're staged. */
type Rewrite = { row: Transactions; items: Items[]; writes: Write[]; voided: boolean }

/**
 * Step 3, inputs: P becomes U inside the stored input (`inputJson`) and the items' `splitJson`
 * of every transaction in `groupIds` that isn't void, locked ones included (I-7's merge
 * exception, #263), as `mergeInput` and `mergeSplit` say. An unlocked payment or loan whose two
 * sides are now both U is voided instead, as the ledger voids one; a locked one never is. Each
 * batch guards its group and checks for a `finalizing` statement first, as for shares, and a
 * group with one is put off, as is a group step 1 recorded no member dates for in `recorded`;
 * then it guards U's person row (`guardInto`). Each group's scan carries on from P's resume point
 * there (`cursors`) and records where it got to. It stops once `deadline` (epoch ms) has passed.
 */
export async function moveInputs(
  db: Db,
  merge: Merge,
  groupIds: readonly string[],
  now: Date,
  deadline: number,
  recorded: MergeMembers,
  cursors: MergeCursors,
): Promise<InputsResult> {
  const result: InputsResult = {
    rewritten: 0,
    voided: 0,
    skipped: 0,
    putOff: [],
    cutOff: false,
    done: true,
  }
  for (const groupId of groupIds) {
    const dates = recorded.find((entry) => entry.groupId === groupId)
    const from = cursors.find((entry) => entry.groupId === groupId)
    const outcome = await moveGroupInputs(db, merge, groupId, now, deadline, result, dates, from)
    if (outcome === 'putOff') result.putOff.push(groupId)
    if (outcome === 'cutOff') {
      result.cutOff = true
      result.done = false
      break
    }
  }
  if (result.putOff.length > 0 || result.skipped > 0) result.done = false
  return result
}

async function moveGroupInputs(
  db: Db,
  merge: Merge,
  groupId: string,
  now: Date,
  deadline: number,
  result: InputsResult,
  dates: MergeMembers[number] | undefined,
  from: MergeCursors[number] | undefined,
): Promise<'done' | 'putOff' | 'cutOff'> {
  // Step 3 never plans a posted row's items without step 1's dates (#301).
  if (!dates) {
    console.error(`merge ${merge.from}: no recorded member dates for group ${groupId}`)
    return 'putOff'
  }
  // An edit after the merge plans a row with the members as step 2 left them, and as they are
  // after a race: a member change may be what made the batch run again.
  const members = async () => {
    const group = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
    return group ? (await loadGroupLedger(db, group, merge.into)).ctx : undefined
  }
  let ctx = await members()
  // Renames what it can of `rows` (at most PAGE, under the query filter's value cap): the IDs
  // of unlocked rows left as they are, or why it stopped.
  const rename = async (rows: readonly Transactions[]) => {
    const { rewrites, skipped, lockedSkipped } = await planRewrites(
      db,
      rows.filter((row) => row.status !== 'void'),
      merge,
      now,
      ctx,
      ctx ? membersBefore(ctx.members, merge, dates) : [],
    )
    try {
      for (const batch of batches(rewrites)) {
        await runBatch(db, groupId, merge.into, batch)
        for (const rewrite of batch) {
          if (rewrite.voided) result.voided += 1
          else result.rewritten += 1
        }
      }
    } catch (error) {
      if (error instanceof Finalizing) return 'putOff'
      // A row changed after it was read: read these rows again. Rows already rewritten no
      // longer name P, so they're left alone.
      if (error instanceof Raced || isAppwriteError(error, 409)) {
        ctx = await members()
        return 'raced'
      }
      throw error
    }
    // Nothing can ever change a locked row, so it doesn't hold the merge open (#263).
    for (const rowId of lockedSkipped) {
      console.warn(
        `merge ${merge.from} into ${merge.into} left locked transaction ${rowId} as it is`,
      )
    }
    return skipped
  }
  // Where an earlier run's scan got to (#242 G). First the rows it left as they are, read again
  // in chunks, so one voided, fixed, locked or deleted since no longer holds the merge open: a
  // locked one is renamed as any locked row is, or logged and left.
  const again = from?.left ?? []
  const left: string[] = []
  for (let start = 0; start < again.length; ) {
    if (Date.now() >= deadline) return 'cutOff'
    const chunk = again.slice(start, start + PAGE)
    const rows = [...(await listById<Transactions>(db, TABLES.transactions, chunk)).values()]
    const outcome = await rename(rows)
    if (outcome === 'putOff') return 'putOff'
    if (outcome === 'raced') continue
    left.push(...outcome)
    start += PAGE
  }
  const cleared = again.filter((rowId) => !left.includes(rowId))
  // Then on from the cursor, in `$id` order. By `$id` rather than by a cursor row, which may
  // have been deleted since (scaling.md).
  let after = from?.after
  for (;;) {
    if (Date.now() >= deadline) return 'cutOff'
    // Void rows are skipped in `rename`, not in the query. Locked rows are read too (I-7):
    // voiding their statement unlocks them. `idx_group_statement_date`, by its `groupId` prefix.
    const { rows: page } = await db.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      queries: [
        Query.equal('groupId', groupId),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(after === undefined ? [] : [Query.greaterThan('$id', after)]),
      ],
      total: false,
    })
    const outcome = await rename(page)
    if (outcome === 'putOff') return 'putOff'
    if (outcome === 'raced') continue
    // Usually none of a page's rows is in `left` yet, but two runs at once can store a `left`
    // row past the other's `after` (saveCursor keeps the last writer's): count it once.
    for (const rowId of outcome.filter((id) => !left.includes(id))) {
      console.warn(`merge ${merge.from} into ${merge.into} left transaction ${rowId} as it is`)
      left.push(rowId)
    }
    after = page.at(-1)?.$id ?? after
    if (after !== undefined) {
      await saveCursor(db, merge.from, { groupId, after, left }, cleared, deadline)
    }
    if (page.length < PAGE) {
      result.skipped += left.length
      return 'done'
    }
  }
}

/** P's resume points (`persons.mergeCursorsJson`); none if there are none or they can't be read. */
export function cursorsOf(placeholder: Pick<Persons, 'mergeCursorsJson'> | null): MergeCursors {
  if (!placeholder?.mergeCursorsJson) return []
  let raw: unknown
  try {
    raw = JSON.parse(placeholder.mergeCursorsJson)
  } catch {
    return []
  }
  const parsed = mergeCursorsSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

/**
 * Records where the group's scan got to on P's row, once the page's batches have committed. The
 * stored entries are read, then the write is staged and they're read again, so another run's
 * entry written meanwhile is kept, not lost: its rows left as they are stay left, apart from the
 * ones this run `cleared`. Unreadable entries start over from scratch, which is only slower.
 */
async function saveCursor(
  db: Db,
  placeholderId: string,
  entry: MergeCursors[number],
  cleared: readonly string[],
  deadline: number,
): Promise<void> {
  for (;;) {
    // Out of time, the page is simply read again next run.
    if (Date.now() >= deadline) return
    try {
      await withTransaction(db, async (tx) => {
        const stored = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
        // Persons are never deleted; without P's row there's nowhere to keep it.
        if (!stored) return
        const cursors = cursorsOf(stored)
        const mine = cursors.find((other) => other.groupId === entry.groupId)
        const theirs = mine?.left ?? []
        const left = [
          ...new Set([...theirs.filter((rowId) => !cleared.includes(rowId)), ...entry.left]),
        ]
        // Nothing new since it was stored (a run that found no more rows): no write.
        const same = left.length === theirs.length && left.every((rowId) => theirs.includes(rowId))
        if (mine?.after === entry.after && same) return
        const next = [
          ...cursors.filter((other) => other.groupId !== entry.groupId),
          { ...entry, left },
        ]
        await tx.write({
          action: 'update',
          tableId: TABLES.persons,
          rowId: placeholderId,
          data: { mergeCursorsJson: JSON.stringify(next) },
        })
        const now = await getRowOrNull<Persons>(db, TABLES.persons, placeholderId)
        if (now?.mergeCursorsJson !== stored.mergeCursorsJson) throw new Raced()
      })
      return
    } catch (error) {
      if (!(error instanceof Raced || isAppwriteError(error, 409))) throw error
    }
  }
}

/**
 * The page's transactions whose input or items name P, with the writes that rename P, and the
 * IDs of those it can't rename: `skipped` if unlocked, `lockedSkipped` if locked. A locked row is
 * renamed as a posted one is and never voided: a locked loan from U to U is renamed, and a locked
 * payment between P and U, whose sides must differ, can't be, so it's left. A receipt has at most
 * 30 items (`MAX_ITEMS_PER_TRANSACTION`), so one transaction's writes always fit a batch.
 */
async function planRewrites(
  db: Db,
  rows: readonly Transactions[],
  merge: Merge,
  now: Date,
  ctx: LedgerContext | undefined,
  before: readonly LedgerMember[],
): Promise<{ rewrites: Rewrite[]; skipped: string[]; lockedSkipped: string[] }> {
  const items =
    rows.length === 0
      ? []
      : await listAll<Items>(db, TABLES.items, [
          Query.equal(
            'transactionId',
            rows.map((row) => row.$id),
          ),
        ])
  // An itemised row's items have splits of their own; its shares can't be told apart by item.
  const posted = rows.filter(
    (row) => row.status === 'posted' && !items.some((item) => item.transactionId === row.$id),
  )
  const shares =
    ctx === undefined || posted.length === 0
      ? []
      : await listAll<Shares>(db, TABLES.shares, [
          Query.equal(
            'transactionId',
            posted.map((row) => row.$id),
          ),
        ])
  const rewrites: Rewrite[] = []
  const skipped: string[] = []
  const lockedSkipped: string[] = []
  for (const row of rows) {
    const locked = row.statementId !== null
    const cantRename = locked ? lockedSkipped : skipped
    const asPosted =
      ctx !== undefined && posted.includes(row)
        ? {
            date: row.date as LocalDate,
            totalCents: row.totalCents,
            shares: shares.filter((share) => share.transactionId === row.$id),
            ctx,
            // As an edit has it: without payers, its creator pays.
            payer: row.createdBy,
          }
        : undefined
    const input = renamed(row.inputJson, storedInputSchema, (raw) => {
      const merged = mergeInput(raw as StoredInput, row.kind, merge, asPosted)
      return locked ? { input: merged.input, voided: false } : merged
    })
    if (!input) {
      cantRename.push(row.$id)
      continue
    }
    if (input.voided) {
      const shares = await listShares(db, row.$id)
      rewrites.push({
        row,
        items: [],
        writes: voidWrites(row, shares, merge.into, now),
        voided: true,
      })
      continue
    }
    // A posted row's items must each plan the same parts after the merge (lead, #242).
    const period = billPeriod(row)
    const splitCtx =
      ctx !== undefined && row.status === 'posted' ? { members: ctx.members, period } : undefined
    const splits = items
      .filter((item) => item.transactionId === row.$id)
      .map((item) => ({
        item,
        split: renamed(item.splitJson, splitSpecSchema, (raw) => {
          const split = raw as z.infer<typeof splitSpecSchema>
          return {
            input: splitCtx
              ? mergePostedSplit(split, merge, item.amountCents, splitCtx, {
                  members: before,
                  period,
                })
              : mergeSplit(split, merge),
            voided: false,
          }
        }),
      }))
    if (splits.some(({ split }) => !split)) {
      cantRename.push(row.$id)
      continue
    }
    const changed = splits.flatMap(({ item, split }) =>
      split?.json === undefined ? [] : [{ item, splitJson: split.json }],
    )
    if (input.json === undefined && changed.length === 0) continue
    rewrites.push({
      row,
      items: changed.map(({ item }) => item),
      writes: [
        ...(input.json === undefined
          ? []
          : [
              {
                action: 'update' as const,
                tableId: TABLES.transactions,
                rowId: row.$id,
                data: { inputJson: input.json },
              },
            ]),
        ...changed.map(({ item, splitJson }) => ({
          action: 'update' as const,
          tableId: TABLES.items,
          rowId: item.$id,
          data: { splitJson },
        })),
      ],
      voided: false,
    })
  }
  return { rewrites, skipped, lockedSkipped }
}

/**
 * The members as they were before the merge, for planning a posted row's items (#242 B2): P's and
 * U's member rows as step 1 recorded them, and everyone else's as they are now.
 */
function membersBefore(
  members: readonly LedgerMember[],
  merge: Merge,
  dates: MergeMembers[number],
): readonly LedgerMember[] {
  return [
    ...members.filter((member) => member.personId !== merge.from && member.personId !== merge.into),
    { personId: merge.from, ...dates.from },
    ...(dates.into ? [{ personId: merge.into, ...dates.into }] : []),
  ]
}

/** A bill's billing period from its stored input, for a `days` split. */
function billPeriod(row: Transactions): DateRange | undefined {
  const stored = storedInputSchema.safeParse(JSON.parse(row.inputJson))
  const { periodStart, periodEnd } = (stored.success && stored.data.bill) || {}
  return periodStart && periodEnd ? { start: periodStart, end: periodEnd } : undefined
}

/**
 * Stored JSON with P renamed: `json` is the new text, undefined when nothing changed, and
 * `voided` as `rename` says. The stored object is renamed as it is, so its keys keep their order.
 * Undefined when the JSON can't be read, or is no longer valid once renamed (weights that add up
 * past `MAX_WEIGHT`, say): nothing invalid is ever written.
 */
function renamed(
  text: string,
  schema: z.ZodType,
  rename: (raw: unknown) => { input: unknown; voided: boolean },
): { json?: string; voided: boolean } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!schema.safeParse(raw).success) return undefined
  const { input, voided } = rename(raw)
  // A voided row keeps its input, so only a rewrite has to be valid.
  if (voided) return { voided }
  if (!schema.safeParse(input).success) return undefined
  const json = JSON.stringify(input)
  return json === JSON.stringify(raw) ? { voided } : { json, voided }
}

/** As `POST /transactions/{id}/void` does it: the status and reason, no shares, an activity row. */
function voidWrites(row: Transactions, shares: Shares[], by: string, now: Date): Write[] {
  return [
    {
      action: 'update',
      tableId: TABLES.transactions,
      rowId: row.$id,
      data: { status: 'void', voidReason: VOID_REASON, updatedBy: by },
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

// A batch's own writes: the group's guard, U's person guard, and the delete of its `balances` row.
const OWN_WRITES = 3

/**
 * Rewrites packed into batches of at most 90 writes, the group's guard, U's guard and the delete
 * of its `balances` row included.
 */
function batches(rewrites: readonly Rewrite[]): Rewrite[][] {
  const result: Rewrite[][] = []
  let batch: Rewrite[] = []
  let size = OWN_WRITES
  for (const rewrite of rewrites) {
    if (batch.length > 0 && size + rewrite.writes.length > MAX_OPS_PER_DB_TRANSACTION) {
      result.push(batch)
      batch = []
      size = OWN_WRITES
    }
    batch.push(rewrite)
    size += rewrite.writes.length
  }
  if (batch.length > 0) result.push(batch)
  return result
}

/**
 * One batch: the group's guard first (ledger.md#concurrency), then the finalizing check, U's
 * guard (`IntoDeleted` if U's account is being deleted), the writes, and the rows read again as
 * stored, so one posted, edited, voided, locked or unlocked meanwhile runs it again.
 */
async function runBatch(
  db: Db,
  groupId: string,
  intoId: string,
  batch: readonly Rewrite[],
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.write({
      action: 'update',
      tableId: TABLES.groups,
      rowId: groupId,
      data: { rev: randomId() },
    })
    if (await isFinalizing(db, groupId)) throw new Finalizing()
    await guardInto(tx, db, intoId)
    // A void deletes shares; a rewritten input changes none.
    if (batch.some((rewrite) => rewrite.voided)) await dropBalances(tx, db, groupId)
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
          now.statementId === rewrite.row.statementId &&
          now.inputJson === rewrite.row.inputJson
        )
      }) &&
      batch.every((rewrite) =>
        rewrite.items.every((item) => items.get(item.$id)?.splitJson === item.splitJson),
      )
    if (!same) throw new Raced()
  })
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

/**
 * The scheduler's guard columns (functions/scheduler's `guardSchedule`, which another function
 * can't import): a change to any of them means the schedule is read again.
 */
const SCHEDULE_COLUMNS = [
  'kind',
  'description',
  'templateJson',
  'rrule',
  'startsOn',
  'endsOn',
  'exdates',
  'skipPublicHolidays',
  'autoPost',
  'horizonDays',
  'generatedThrough',
  'nextRunAt',
] as const

/**
 * What became of the groups' schedules. `skipped`: templates that can't be renamed, left as they
 * are and logged by ID. `cutOff`: the deadline stopped it. `done`: every group was read to the
 * end, with nothing put off or skipped.
 */
export type TemplatesResult = {
  rewritten: number
  skipped: number
  putOff: string[]
  cutOff: boolean
  done: boolean
}

/**
 * Step 3, templates: P becomes U inside `schedules.templateJson` in `groupIds`
 * (`idx_groupId`), one schedule at a time. Each write guards the group, checks for a
 * `finalizing` statement and guards U's person row, as for inputs, then is staged with the
 * schedule guard: the schedule row is written, then read again as stored, so an expansion, edit
 * or end that got there first runs it again (scheduling.md). No schedule kind is a payment or
 * loan, so none is voided.
 */
export async function moveTemplates(
  db: Db,
  merge: Merge,
  groupIds: readonly string[],
  deadline: number,
): Promise<TemplatesResult> {
  const result: TemplatesResult = {
    rewritten: 0,
    skipped: 0,
    putOff: [],
    cutOff: false,
    done: true,
  }
  for (const groupId of groupIds) {
    const outcome = await moveGroupTemplates(db, merge, groupId, deadline, result)
    if (outcome === 'putOff') result.putOff.push(groupId)
    if (outcome === 'cutOff') {
      result.cutOff = true
      result.done = false
      break
    }
  }
  if (result.putOff.length > 0 || result.skipped > 0) result.done = false
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
    let skipped = 0
    for (const schedule of rows) {
      const template = renamed(schedule.templateJson, transactionTemplateSchema, (raw) =>
        mergeInput(raw as z.infer<typeof transactionTemplateSchema>, schedule.kind, merge),
      )
      if (!template) {
        console.warn(
          `merge ${merge.from} into ${merge.into} left schedule ${schedule.$id} as it is`,
        )
        skipped += 1
        continue
      }
      const templateJson = template.json
      if (templateJson === undefined) continue
      if (Date.now() >= deadline) return 'cutOff'
      try {
        await rewriteTemplate(db, groupId, merge.into, schedule, templateJson)
        result.rewritten += 1
      } catch (error) {
        if (error instanceof Finalizing) return 'putOff'
        if (!(error instanceof Raced || isAppwriteError(error, 409))) throw error
        // It changed after it was read: read this page again, as it is now.
        changed = true
        break
      }
    }
    if (changed) continue
    result.skipped += skipped
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return 'done'
    cursor = last.$id
  }
}

/** One template: the group's guard and the finalizing check, U's guard, then the schedule guard. */
async function rewriteTemplate(
  db: Db,
  groupId: string,
  intoId: string,
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
    await guardInto(tx, db, intoId)
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
    if (!stored || !same) throw new Raced()
  })
}
