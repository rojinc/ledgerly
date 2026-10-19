import type { Persons } from '@ledgerly/core/generated/rows'
import { pages } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { AppError } from '@ledgerly/server/http/app-error'
import { AppwriteException, Query } from 'node-appwrite'
import type { Deleting } from '../groups'
import { personsOfUser } from '../rows'
import type { AccountUser, Services } from '../services'
import { DELETED_LABEL, deleteUser, finish } from './delete-account'

export type JobResult = { finished: number; users: number; failed: number }

// A deletion started less recently than this is the job's. The route stops after 20 s, inside
// the 30 s synchronous limit, and a bootstrap that read the user before step 3 labelled it ends
// within identity's 15 s timeout, so by then no person can still be made for the user.
const SETTLE_MS = 60_000
// Users a page, as pages.ts lists rows.
const PAGE = 100

/**
 * The hourly job (identity-and-invites.md#order): Appwrite sends it as `POST /` with the
 * `schedule` trigger. It finishes every deletion that still names its user, then deletes each
 * user labelled `deleted` that no deleted person names any more, skipping both while they're
 * less than a minute old, until the time budget is used up. Returns counts only, and logs IDs
 * only, so the execution log holds no personal data.
 */
export async function hourlyJob(scheduled: boolean, services: () => Services): Promise<JobResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled)
    throw new AppError('FORBIDDEN', 'Only the account job’s own scheduled run does this.')
  const built = services()
  const settled = built.now.getTime() - SETTLE_MS
  const counts: JobResult = { finished: 0, users: 0, failed: 0 }
  // idx_deletedAt. Paged by $id: finishing clears `userId`, which takes the row out of the list.
  const persons = pages<Persons>(built, TABLES.persons, [
    Query.lessThanEqual('deletedAt', new Date(settled).toISOString()),
    Query.isNotNull('userId'),
  ])
  for await (const person of persons) {
    // The query says both are set.
    const deleting = person as Deleting & { userId: string }
    await counted(counts, `person ${person.$id}`, async () => {
      if (await finish(built, deleting.userId, deleting)) counts.finished += 1
    })
  }
  for await (const user of labelledUsers(built)) {
    // Step 3 labels the user after step 2, and `$updatedAt` is at least as late as the label.
    // Fails closed: a date that doesn't parse waits too.
    if (!user.labels.includes(DELETED_LABEL) || !(Date.parse(user.$updatedAt) <= settled)) {
      continue
    }
    await counted(counts, `user ${user.$id}`, async () => {
      if (await deleteLeftUser(built, user.$id)) counts.users += 1
    })
  }
  return counts
}

// A user whose deletion got past step 6, so no deleted person names it, but not past step 7.
// A person without `deletedAt` that still names it is a bootstrap's, made after step 2 (only
// step 3 labels a user, and bootstrap refuses a labelled one), so step 7 purges it first. A
// deleted person that still names it is the first loop's.
async function deleteLeftUser(services: Services, userId: string): Promise<boolean> {
  const named = await personsOfUser(services.db, userId)
  if (named.some((person) => person.deletedAt)) return false
  return deleteUser(services, userId)
}

// Every user labelled `deleted`, a page at a time, until the time budget is used up. Paged by
// `$id`, as pages.ts pages rows: users are deleted meanwhile, and a deleted cursor fails.
async function* labelledUsers({ users, outOfTime }: Services): AsyncGenerator<AccountUser> {
  let after: string | undefined
  while (!outOfTime()) {
    const { users: page } = await users.list({
      queries: [
        Query.contains('labels', [DELETED_LABEL]),
        ...(after === undefined ? [] : [Query.greaterThan('$id', after)]),
        Query.orderAsc('$id'),
        Query.limit(PAGE),
      ],
      total: false,
    })
    for (const user of page) {
      if (outOfTime()) return
      yield user
    }
    if (page.length < PAGE) return
    after = page[page.length - 1]?.$id
  }
}

// One that fails is counted and logged by its ID, and the others still run.
async function counted(counts: JobResult, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    counts.failed += 1
    console.error(`account: finishing failed for ${what}: ${describe(error)}`)
  }
}

// Names the error, never its message, which can quote personal data.
function describe(error: unknown): string {
  if (error instanceof AppwriteException) return `AppwriteException ${error.code} ${error.type}`
  return error instanceof Error ? error.name : typeof error
}
