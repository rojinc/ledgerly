import {
  type ChangeRow,
  type PersonChange,
  transactionChanges,
} from '@ledgerly/core/activity/transaction-changes'
import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type {
  Activity,
  Checkpoints,
  Groups,
  Members,
  Persons,
  Profiles,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { changeNetsSchema } from '@ledgerly/core/schemas/activity'
import { localDateSchema } from '@ledgerly/core/schemas/common'
import { allRows, pages } from '@ledgerly/server/appwrite/pages'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { isInTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { EmailError } from '@ledgerly/server/email/send-email'
import { type ChangedTransaction, transactionChangesEmail } from '@ledgerly/server/email/templates'
import { logProblem } from '@ledgerly/server/http/log'
import { AppwriteException, type Models, Query } from 'node-appwrite'
import { z } from 'zod'
import { appBase, type Services } from '../services'
import { memo, NEVER_SENT } from './reminders'
import { verifiedEmail } from './summaries'

/** `sent` and `failed` are emails; `skipped` is windows too old to send. */
export type ChangeCounts = { sent: number; failed: number; skipped: number }

// data-model.md#checkpoints: the end of the last window step 3b finished.
const CHECKPOINT = 'transaction-changes'
const HOUR_MS = 60 * 60_000
// A ledger write sets `at` before it commits, and may take 15 s.
const SETTLE_MS = 60_000
// Resend drops a repeated key for 24 hours, so an older window could arrive twice.
const STALE_MS = 23 * HOUR_MS
// Its share of the run, so summaries still go out (scheduling.md#step-3b).
const STEP_MS = 4 * 60_000
// Resend takes 2 sends a second, shared with every other email.
const SPACING_MS = 500
// When a 429 names no wait: Resend's limit is per second.
const RETRY_AFTER_MS = 1_000
// Merges chain at most this deep before the step gives up following one.
const MAX_MERGE_HOPS = 10

/**
 * Step 3b (scheduling.md#step-3b-transaction-change-emails): for each whole UTC hour after the
 * checkpoint, once it's a minute old, one email to each person in a posted transaction someone
 * else edited or voided, covering every group. The checkpoint moves only past a finished window,
 * so a run cut short redoes its window with the same keys.
 */
export async function sendTransactionChanges(services: Services): Promise<ChangeCounts> {
  const counts: ChangeCounts = { sent: 0, failed: 0, skipped: 0 }
  try {
    await sendDue(services, counts)
  } catch (error) {
    // The next run redoes the window; the steps after this one still run.
    logProblem('transaction_changes_failed', { error })
  }
  return counts
}

// What one run of the step shares between its windows.
type Run = {
  services: Services
  counts: ChangeCounts
  outOfTime: () => boolean
  /** Whether a wait of `ms` still ends within the step's time. */
  fits: (ms: number) => boolean
  /** Whether an email went out yet, for the spacing between them. */
  sentAny: boolean
}

async function sendDue(services: Services, counts: ChangeCounts): Promise<void> {
  const started = performance.now()
  const outOfTime = () => services.outOfTime() || performance.now() - started >= STEP_MS
  const fits = (ms: number) => !services.outOfTime() && performance.now() + ms - started < STEP_MS
  const run: Run = { services, counts, outOfTime, fits, sentAny: false }
  const now = services.now.getTime()
  let through = await checkpoint(services)
  // Windows too old to send are passed over in one move.
  const fresh = Math.ceil((now - STALE_MS - HOUR_MS) / HOUR_MS) * HOUR_MS
  if (fresh > through) {
    if (!(await moveCheckpoint(services, through, fresh))) return
    counts.skipped += (fresh - through) / HOUR_MS
    logProblem('transaction_changes_skipped', { count: counts.skipped })
    through = fresh
  }
  while (through + HOUR_MS + SETTLE_MS <= now && !outOfTime()) {
    const end = through + HOUR_MS
    if (!(await sendWindow(run, through, end))) break
    if (!(await moveCheckpoint(services, through, end))) break
    through = end
  }
}

/** Where the checkpoint is, made at the start of this hour when it's missing. */
async function checkpoint({ db, now }: Services): Promise<number> {
  const stored = await rowOrNull<Checkpoints>(db, TABLES.checkpoints, CHECKPOINT)
  if (stored) return Date.parse(stored.through)
  const start = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  try {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'create',
        tableId: TABLES.checkpoints,
        rowId: CHECKPOINT,
        data: { through: new Date(start).toISOString() },
      }),
    )
    return start
  } catch (error) {
    // Another run made it first.
    if (!(error instanceof AppwriteException && error.code === 409)) throw error
    const made = await db.getRow<Checkpoints>({
      databaseId: DATABASE_ID,
      tableId: TABLES.checkpoints,
      rowId: CHECKPOINT,
    })
    return Date.parse(made.through)
  }
}

class Moved extends Error {}

/** Moves the checkpoint from `from` to `to`; false when another run moved it first. */
async function moveCheckpoint({ db }: Services, from: number, to: number): Promise<boolean> {
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.checkpoints,
        rowId: CHECKPOINT,
        data: { through: new Date(to).toISOString() },
      })
      // The stored row, not this transaction's view.
      const stored = await db.getRow<Checkpoints>({
        databaseId: DATABASE_ID,
        tableId: TABLES.checkpoints,
        rowId: CHECKPOINT,
      })
      if (Date.parse(stored.through) !== from) throw new Moved()
    })
    return true
  } catch (error) {
    if (error instanceof Moved) return false
    if (error instanceof AppwriteException && (error.code === 404 || error.code === 409)) {
      return false
    }
    throw error
  }
}

/**
 * One window `[start, end)`: folds its edits and voids, then emails each person told, at least
 * SPACING_MS apart. True once everyone was sent to or refused for good; false to stop the step
 * (out of time, or a failure the next run may not meet), leaving the window for the next run.
 */
async function sendWindow(run: Run, start: number, end: number): Promise<boolean> {
  const { services, counts, outOfTime } = run
  const { db } = services
  const activity: Activity[] = []
  // idx_action_at
  for await (const row of pages<Activity>({ db, outOfTime }, TABLES.activity, [
    Query.equal('action', ['transaction.updated', 'transaction.voided']),
    Query.greaterThanEqual('at', new Date(start).toISOString()),
    Query.lessThan('at', new Date(end).toISOString()),
  ])) {
    activity.push(row)
  }
  // Pages stop when time runs out: a window read in part is never sent.
  if (outOfTime()) return false
  // Pages come in `$id` order and the sort is stable, so rows at the same moment stay in it.
  activity.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const rows = activity.flatMap((row) => changeRow(row) ?? [])
  const look = lookups(services)
  const transactions = new Map<string, Transactions>()
  for (const transactionId of new Set(rows.map((row) => row.transactionId))) {
    if (outOfTime()) return false
    const transaction = await rowOrNull<Transactions>(db, TABLES.transactions, transactionId)
    if (transaction) transactions.set(transactionId, transaction)
  }
  const known = rows.filter((row) => transactions.has(row.transactionId))
  const people = new Set(
    known.flatMap((row) => [
      row.actorPersonId,
      ...[...row.nets.before, ...row.nets.after].map((net) => net.personId),
    ]),
  )
  const merged = new Map<string, string>()
  for (const personId of people) {
    if (outOfTime()) return false
    merged.set(personId, await look.mergedInto(personId))
  }
  const told = transactionChanges(
    known,
    (transactionId) => {
      const transaction = transactions.get(transactionId) as Transactions
      return { totalCents: transaction.totalCents, date: transaction.date as LocalDate }
    },
    (personId) => merged.get(personId) ?? personId,
  )
  const base = appBase(services.appUrl)
  // The window's start as YYYYMMDDHH, UTC.
  const hour = new Date(start).toISOString().slice(0, 13).replace(/[-T]/g, '')
  for (const personId of [...told.keys()].sort()) {
    if (outOfTime()) return false
    const email = await emailFor(
      services,
      look,
      personId,
      told.get(personId) ?? [],
      transactions,
      base,
    )
    if (!email) continue
    if (run.sentAny) await services.wait(SPACING_MS)
    run.sentAny = true
    const outcome = await deliver(run, {
      to: email.to,
      ...transactionChangesEmail({ changes: email.changes, profileUrl: `${base}/profile` }),
      idempotencyKey: `txn-changes-${personId}-${hour}`,
    })
    if (outcome === 'stop') return false
    counts[outcome] += 1
  }
  return true
}

const fieldChange = <T extends z.ZodType>(value: T) =>
  z.object({ before: value, after: value }).optional()
const changesSchema = z.object({
  nets: changeNetsSchema,
  totalCents: fieldChange(z.int()),
  date: fieldChange(localDateSchema),
})

/** The row as the fold takes it, or undefined for a row with no actor or no `nets`. */
function changeRow(row: Activity): ChangeRow | undefined {
  if (!row.actorPersonId || !row.transactionId || !row.changesJson) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(row.changesJson)
  } catch {
    return undefined
  }
  const changes = changesSchema.safeParse(parsed)
  if (!changes.success) return undefined
  return {
    transactionId: row.transactionId,
    actorPersonId: row.actorPersonId,
    voided: row.action === 'transaction.voided',
    nets: changes.data.nets,
    ...(changes.data.totalCents && { totalCents: changes.data.totalCents }),
    ...(changes.data.date && {
      date: changes.data.date as { before: LocalDate; after: LocalDate },
    }),
  }
}

/**
 * One person's email, or undefined when they get none: only for the groups where they have an
 * `active` member row, or a `left` one while they're still in its team, and only to a verified
 * account email of an account that isn't blocked, with no `deletedAt`.
 */
async function emailFor(
  services: Services,
  look: ReturnType<typeof lookups>,
  personId: string,
  told: readonly PersonChange[],
  transactions: ReadonlyMap<string, Transactions>,
  base: string,
): Promise<{ to: string; changes: ChangedTransaction[] } | undefined> {
  const person = await look.person(personId)
  if (!person?.userId || person.deletedAt) return undefined
  const userId = person.userId
  // On unless they turned it off (#431). A profile is made with the account, so none means on.
  const profile = await rowOrNull<Profiles>(services.db, TABLES.profiles, userId)
  if (profile?.emailOptOuts?.includes('transactionChanged')) return undefined
  const changes: ChangedTransaction[] = []
  for (const change of told) {
    const transaction = transactions.get(change.transactionId) as Transactions
    const group = await look.group(transaction.groupId)
    if (!group) continue
    const members = await look.members(group.$id)
    const member = members.get(personId)
    const open =
      member?.status === 'active' ||
      (member?.status === 'left' && (await isInTeam(services.teams, group.$id, userId)))
    if (!open) continue
    changes.push({
      // A pair is named by its other member, as the app names it (#145).
      groupName:
        group.type === 'pair'
          ? [...members.values()].find((one) => one.personId !== personId)?.displayName ||
            group.name
          : group.name,
      description: transaction.description,
      changedBy: change.changedBy.map((actor) => members.get(actor)?.displayName ?? 'someone'),
      currency: group.currency,
      totalCents: change.totalCents,
      date: change.date,
      netCents: change.netCents,
      voided: change.voided,
      url: `${base}/groups/${group.$id}/transactions/${transaction.$id}`,
    })
  }
  if (changes.length === 0) return undefined
  const to = await verifiedEmail(services, userId)
  return to ? { to, changes } : undefined
}

/**
 * One email, and once more after a 429 with the same key if Resend's wait ends within the step's
 * time: `sent` (an overlapping run sending the same key counts), `failed` for one Resend will
 * never take, or `stop` for anything else, which the next run tries again.
 */
async function deliver(
  { services, fits }: Run,
  email: Parameters<Services['sendEmail']>[0],
): Promise<'sent' | 'failed' | 'stop'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await services.sendEmail(email)
      return 'sent'
    } catch (error) {
      if (error instanceof EmailError && error.type === 'concurrent_idempotent_requests') {
        return 'sent'
      }
      if (error instanceof EmailError && NEVER_SENT.has(error.type)) return 'failed'
      const wait = error instanceof EmailError ? (error.retryAfterMs ?? RETRY_AFTER_MS) : 0
      if (
        error instanceof EmailError &&
        error.type === 'rate_limit_exceeded' &&
        attempt === 1 &&
        fits(wait)
      ) {
        await services.wait(wait)
        continue
      }
      logProblem('transaction_changes_failed', { error })
      return 'stop'
    }
  }
}

/** Rows read once per window, by ID. */
function lookups({ db }: Services) {
  const person = memo((id) => rowOrNull<Persons>(db, TABLES.persons, id))
  return {
    person,
    group: memo((id) => rowOrNull<Groups>(db, TABLES.groups, id)),
    // idx_groupId
    members: memo(async (groupId) => {
      const rows = await allRows<Members>(db, TABLES.members, [Query.equal('groupId', groupId)])
      return new Map(rows.map((row) => [row.personId, row]))
    }),
    /** The person a merged one now is (identity-and-invites.md#merging-two-persons). */
    mergedInto: async (personId: string): Promise<string> => {
      let current = personId
      for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
        const next = (await person(current))?.mergedInto
        if (!next) return current
        current = next
      }
      return current
    },
  }
}

async function rowOrNull<R extends Models.Row>(
  db: Services['db'],
  tableId: TableId,
  rowId: string,
): Promise<R | null> {
  try {
    return await db.getRow<R>({ databaseId: DATABASE_ID, tableId, rowId })
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return null
    throw error
  }
}
