import type { Groups, Persons } from '@ledgerly/core/generated/rows'
import { pages } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { AppError } from '@ledgerly/server/http/app-error'
import { type LogFields, logProblem } from '@ledgerly/server/http/log'
import { Query } from 'node-appwrite'
import type { Deleting } from '../groups'
import { personsOfUser } from '../rows'
import type { AccountUser, Services } from '../services'
import { DELETED_LABEL, deleteUser, finish } from './delete-account'
import { type DeletingGroup, finishDelete } from './delete-group'

export type JobResult = { finished: number; users: number; groups: number; failed: number }

// A deletion started less recently than this is the job's. The route stops after 20 s, inside
// the 30 s synchronous limit, and a bootstrap that read the user before step 3 labelled it ends
// within identity's 15 s timeout, so by then no person can still be made for the user.
const SETTLE_MS = 60_000
// Users a page, as pages.ts lists rows.
const PAGE = 100

/**
 * The hourly job (identity-and-invites.md#finishing-purges): Appwrite sends it as `POST /` with
 * the `schedule` trigger. The account pass finishes every deletion that still names its user,
 * then deletes each user labelled `deleted` that no deleted person names any more; then the group
 * pass finishes each group delete. It skips all three while they're less than a minute old, until
 * the time budget is used up. Returns counts only, and logs IDs only, so the execution log holds
 * no personal data.
 */
export async function hourlyJob(scheduled: boolean, services: () => Services): Promise<JobResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled)
    throw new AppError('FORBIDDEN', 'Only the account job’s own scheduled run does this.')
  const built = services()
  const settled = built.now.getTime() - SETTLE_MS
  const counts: JobResult = { finished: 0, users: 0, groups: 0, failed: 0 }
  // idx_deletedAt. Paged by $id: finishing clears `userId`, which takes the row out of the list.
  const persons = pages<Persons>(built, TABLES.persons, [
    Query.lessThanEqual('deletedAt', new Date(settled).toISOString()),
    Query.isNotNull('userId'),
  ])
  for await (const person of persons) {
    // The query says both are set.
    const deleting = person as Deleting & { userId: string }
    await counted(counts, { personId: person.$id }, async () => {
      if (await finish(built, deleting.userId, deleting)) counts.finished += 1
    })
  }
  for await (const user of labelledUsers(built)) {
    // Step 3 labels the user after step 2, and `$updatedAt` is at least as late as the label.
    // Fails closed: a date that doesn't parse waits too.
    if (!user.labels.includes(DELETED_LABEL) || !(Date.parse(user.$updatedAt) <= settled)) {
      continue
    }
    await counted(counts, { userId: user.$id }, async () => {
      if (await deleteLeftUser(built, user.$id)) counts.users += 1
    })
  }
  // After the account pass, so someone whose account is being deleted while they delete a group
  // settles that purge as part of their own deletion. idx_deletingAt. Paged by $id: a finished
  // purge deletes the group row, which takes it out of the list. One whose `deletingBy` row is
  // gone is another person's account deletion's to end, and purge() leaves it to them.
  const groups = pages<Groups>(built, TABLES.groups, [
    Query.lessThanEqual('deletingAt', new Date(settled).toISOString()),
  ])
  for await (const group of groups) {
    await counted(counts, { groupId: group.$id }, async () => {
      // The query says `deletingAt` is set, and `deletingBy` is written with it.
      if (await finishDelete(built, group as DeletingGroup)) counts.groups += 1
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

// One that fails is counted and logged by its ID (and the error's name), and the others still
// run.
async function counted(
  counts: JobResult,
  ids: Pick<LogFields, 'personId' | 'userId' | 'groupId'>,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work()
  } catch (error) {
    counts.failed += 1
    logProblem('account_finish_failed', { ...ids, error })
  }
}
