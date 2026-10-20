import type { Groups, Identities, Persons } from '@ledgerly/core/generated/rows'
import type { Db } from '@ledgerly/server/appwrite/client'
import { allRows, pages } from '@ledgerly/server/appwrite/pages'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { AppError } from '@ledgerly/server/http/app-error'
import { type LogFields, logProblem } from '@ledgerly/server/http/log'
import { Query } from 'node-appwrite'
import type { Deleting } from '../groups'
import { personsOfUser } from '../rows'
import type { AccountUser, Services } from '../services'
import { DELETED_LABEL, deleteUser, finish, markDeleted } from './delete-account'
import { type DeletingGroup, finishDelete } from './delete-group'

export type JobResult = {
  finished: number
  users: number
  groups: number
  e2e: number
  failed: number
}

// A deletion started less recently than this is the job's. The route stops after 20 s, inside
// the 30 s synchronous limit, and a bootstrap that read the user before step 3 labelled it ends
// within identity's 15 s timeout, so by then no person can still be made for the user.
const SETTLE_MS = 60_000
// Users a page, as pages.ts lists rows.
const PAGE = 100
// What an e2e run's teardown labels its users, and the only address such a user, and each of its
// person's identities, can have: a run's Resend test address (testing.md#end-to-end, #386).
const E2E_LABEL = 'e2e'
const E2E_ADDRESS = /^delivered\+e2e[a-z0-9]{10,}-[a-z0-9-]+@resend\.dev$/
const E2E_IDENTITY = new RegExp(`^email:${E2E_ADDRESS.source.slice(1)}`)

/**
 * The hourly job (identity-and-invites.md#finishing-purges): Appwrite sends it as `POST /` with
 * the `schedule` trigger. The account pass finishes every deletion that still names its user,
 * then deletes each user labelled `deleted` that no deleted person names any more; then the group
 * pass finishes each group delete; then the e2e pass deletes the accounts an e2e run labelled. It
 * skips all four while they're less than a minute old, until the time budget is used up. Returns counts only, and logs IDs only, so the execution log holds
 * no personal data.
 */
export async function hourlyJob(scheduled: boolean, services: () => Services): Promise<JobResult> {
  // Before the services, which need the execution's API key.
  if (!scheduled)
    throw new AppError('FORBIDDEN', 'Only the account job’s own scheduled run does this.')
  const built = services()
  const settled = built.now.getTime() - SETTLE_MS
  const counts: JobResult = { finished: 0, users: 0, groups: 0, e2e: 0, failed: 0 }
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
  for await (const user of labelledUsers(built, DELETED_LABEL)) {
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
  // Last: it only starts deletions, which the account pass finishes on a later run if this one
  // is cut off (identity-and-invites.md#finishing-purges).
  for await (const user of labelledUsers(built, E2E_LABEL)) {
    if (!user.labels.includes(E2E_LABEL) || !(Date.parse(user.$updatedAt) <= settled)) continue
    // Step 3 labels it `deleted`: a deletion under way is the account pass's.
    if (user.labels.includes(DELETED_LABEL)) continue
    await counted(counts, { userId: user.$id }, async () => {
      const deleted = await deleteE2eUser(built, user)
      // Only a mistake with the e2e key labels anyone else: never deleted here, and said.
      if (deleted === null) logProblem('e2e_user_not_deleted', { userId: user.$id })
      if (deleted) counts.e2e += 1
    })
  }
  return counts
}

// An e2e run's user, deleted as POST /delete deletes an account once past its checks: step 2 for
// its person (the one being deleted, if a bootstrap made another), unless that's done, then
// steps 3–7. A user with no person (setup failed before its first sign-in) gets step 7 alone.
// Null, changing nothing, unless the user's email and, before step 2, each of its person's
// identities is a run's: the e2e key can change an email, but only functions write identities.
async function deleteE2eUser(services: Services, user: AccountUser): Promise<boolean | null> {
  if (!E2E_ADDRESS.test(user.email)) return null
  const persons = await personsOfUser(services.db, user.$id)
  const person = persons.find((row) => row.deletedAt) ?? persons[0]
  if (!person) return deleteUser(services, user.$id)
  if (person.deletedAt) return finish(services, user.$id, person as Deleting)
  if (!(await onlyRunIdentities(services.db, person.$id))) return null
  return finish(services, user.$id, await markDeleted(services, person))
}

// At least one identity (idx_personId), and each an email identity with a run's address.
async function onlyRunIdentities(db: Db, personId: string): Promise<boolean> {
  const identities = await allRows<Identities>(db, TABLES.identities, [
    Query.equal('personId', personId),
  ])
  return identities.length > 0 && identities.every(({ key }) => E2E_IDENTITY.test(key))
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

// Every user with `label`, a page at a time, until the time budget is used up. Paged by `$id`, as
// pages.ts pages rows: users are deleted meanwhile, and a deleted cursor fails.
async function* labelledUsers(
  { users, outOfTime }: Services,
  label: string,
): AsyncGenerator<AccountUser> {
  let after: string | undefined
  while (!outOfTime()) {
    const { users: page } = await users.list({
      queries: [
        Query.contains('labels', [label]),
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
