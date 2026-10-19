import type { Identities, Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { AppError } from '@ledgerly/server/http/app-error'
import { logProblem } from '@ledgerly/server/http/log'
import { Query } from 'node-appwrite'
import { findIdentity, getRowOrNull, isAppwriteError } from '../rows'
import { finishMerges, MERGE_BUDGET_MS } from '../run-merge'
import type { Services } from '../services'
import { markVerified, verifiedIdentities } from './claim'

// identity-and-invites.md#finishing-merges: the hourly run carries on the merges a claim left
// unfinished, so one finishes within about an hour even if U never calls /claim again. Logs and
// the result hold IDs and counts only (security-and-privacy.md).

const PAGE = 100

/**
 * Merges, counted one per P: found unfinished, finished now, skipped (U), cut off by the budget
 * (left unfinished once it had passed), and stopped by an error. The rest were carried on and
 * wait: a group put off, or a merge into a U whose deletion started midway (the next run skips U).
 */
export type RunResult = {
  unfinished: number
  finished: number
  skipped: number
  cutOff: number
  stopped: number
}

/** `identity POST /`, the hourly run (`interval: 60`), sent with the `schedule` trigger. */
export async function run(scheduled: boolean, services: () => Services): Promise<RunResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled) throw new AppError('FORBIDDEN', 'Only identity’s own hourly run runs this.')
  const built = services()
  const deadline = Date.now() + MERGE_BUDGET_MS
  const result: RunResult = { unfinished: 0, finished: 0, skipped: 0, cutOff: 0, stopped: 0 }
  const { merges, read, complete } = await unfinishedMerges(built.db, deadline)
  // Merged persons are kept for good, so a walk that outgrows the budget would hide every merge
  // past it: this says so (scaling.md).
  if (!complete) logProblem('merge_walk_cut_off', { count: read })
  // In random order, so a merge that can never finish doesn't take every run's budget.
  for (const [intoId, fromIds] of shuffled([...merges])) {
    const count = fromIds.length
    result.unfinished += count
    if (Date.now() >= deadline) {
      result.cutOff += count
      continue
    }
    let done = 0
    try {
      // Read just before its turn: a deletion that started meanwhile ends U's merges (step 5).
      const into = await getRowOrNull<Persons>(built.db, TABLES.persons, intoId)
      if (!into?.userId || into.deletedAt) {
        result.skipped += count
        continue
      }
      // /claim's own code: it never marks a new merge. Only the merges found above count; one
      // marked since is the next run's.
      const { finished } = await finishMerges(built, into.userId, intoId, deadline)
      done = fromIds.filter((fromId) => finished.includes(fromId)).length
      result.finished += done
      if (done < count) {
        if (Date.now() >= deadline) result.cutOff += count - done
        continue
      }
      await verifyKeys(built, into.userId, intoId)
    } catch (error) {
      // One U's trouble doesn't stop the others; the next run tries again. A race with a claim
      // (`CONFLICT`) or a deletion (`NOT_FOUND`) is expected; anything else is an error line,
      // since a merge that fails every hour is otherwise never seen (conventions.md).
      result.stopped += count - done
      const raced = error instanceof AppError && ['CONFLICT', 'NOT_FOUND'].includes(error.code)
      logProblem(raced ? 'merge_stopped' : 'merge_run_failed', { intoPersonId: intoId, error })
    }
  }
  // With how many merged persons the walk read, to see its cost (scaling.md).
  logProblem('merge_run', { counts: { ...result, personsRead: read } })
  return result
}

/**
 * Each U with a merge still to finish, and its Ps: P has `mergedInto` set (`idx_mergedInto`) and
 * still holds an identity, since identities move last. Only a placeholder is ever merged, so a P
 * with an account, or deleted, is left out, as `finishMerges` leaves it alone. `read` counts the
 * persons read, and `complete` says whether the walk reached the end before `deadline` passed.
 */
async function unfinishedMerges(
  db: Db,
  deadline: number,
): Promise<{ merges: Map<string, string[]>; read: number; complete: boolean }> {
  const merges = new Map<string, string[]>()
  let read = 0
  let cursor: string | undefined
  while (Date.now() < deadline) {
    const { rows } = await db.listRows<Persons>({
      databaseId: DATABASE_ID,
      tableId: TABLES.persons,
      queries: [
        Query.isNotNull('mergedInto'),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    const holding = await holdingIdentities(
      db,
      rows.map((row) => row.$id),
    )
    read += rows.length
    for (const row of rows) {
      if (row.mergedInto && !row.userId && !row.deletedAt && holding.has(row.$id)) {
        merges.set(row.mergedInto, [...(merges.get(row.mergedInto) ?? []), row.$id])
      }
    }
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return { merges, read, complete: true }
    cursor = last.$id
  }
  return { merges, read, complete: false }
}

/**
 * Which of these persons still hold an identity (`idx_personId`, only `personId` read). Paged
 * by `$id`, not a cursor row: a claim or a deletion may delete the page's last one meanwhile.
 */
async function holdingIdentities(db: Db, personIds: readonly string[]): Promise<Set<string>> {
  const holding = new Set<string>()
  if (personIds.length === 0) return holding
  let cursor: string | undefined
  for (;;) {
    const { rows } = await db.listRows<Identities>({
      databaseId: DATABASE_ID,
      tableId: TABLES.identities,
      queries: [
        Query.equal('personId', [...personIds]),
        Query.select(['$id', 'personId']),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.greaterThan('$id', cursor)]),
      ],
      total: false,
    })
    for (const row of rows) holding.add(row.personId)
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return holding
    cursor = last.$id
  }
}

/**
 * Once U's merges are finished: marks verified U's identities whose key U's account verifies,
 * as a claim does (step 2), so statement emails can use them before U's next login. A user
 * that's gone, or labelled `deleted`, is left alone.
 */
async function verifyKeys(
  { db, users, now }: Services,
  userId: string,
  personId: string,
): Promise<void> {
  let user: Awaited<ReturnType<Services['users']['get']>>
  try {
    user = await users.get({ userId })
  } catch (error) {
    if (isAppwriteError(error, 404)) return
    throw error
  }
  if (user.labels.includes('deleted')) return
  for (const { key } of verifiedIdentities(user)) {
    const identity = await findIdentity(db, key)
    if (identity?.personId === personId) await markVerified(db, now, identity, deletedMeanwhile)
  }
}

// A deletion that started after U was read: this U is stopped, and the next run skips it.
function deletedMeanwhile(): AppError {
  return new AppError('NOT_FOUND', 'The account is being deleted.')
}

/** A copy in random order (Fisher–Yates). */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
  }
  return copy
}
