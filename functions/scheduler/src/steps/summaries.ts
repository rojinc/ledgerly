import type { PeriodCycle } from '@ledgerly/core/dates/periods'
import { nextSummaryAt, summaryPeriod } from '@ledgerly/core/dates/summary-period'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Profiles, Shares } from '@ledgerly/core/generated/rows'
import { buildPersonalReport } from '@ledgerly/core/reports/personal-report'
import { netsFromShares } from '@ledgerly/core/settle/nets'
import { DATABASE_ID, TABLES, type TableId } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { type EmailContent, summaryEmail } from '@ledgerly/server/email/templates'
import { AppwriteException, type Models, Query } from 'node-appwrite'
import { pages } from '../pages'
import { appBase, type Services } from '../services'

export type SummaryCounts = { sent: number; skipped: number; failed: number }

type Links = { home: string; profile: string }

/**
 * Step 4 (scheduling.md#step-4-summary-emails): each profile whose `nextSummaryAt` has come
 * gets the summary of the period that just ended, at most once. A profile that fails is
 * counted, and the run carries on.
 */
export async function sendSummaries(services: Services): Promise<SummaryCounts> {
  const base = appBase(services.appUrl)
  const links = { home: `${base}/`, profile: `${base}/profile` }
  const counts: SummaryCounts = { sent: 0, skipped: 0, failed: 0 }
  // idx_nextSummaryAt
  const due = pages<Profiles>(services, TABLES.profiles, [
    Query.lessThanEqual('nextSummaryAt', services.now.toISOString()),
  ])
  for await (const profile of due) {
    try {
      const outcome = await summarise(services, profile, links)
      if (outcome) counts[outcome] += 1
    } catch {
      // The next run tries it again: nextSummaryAt hasn't moved.
      counts.failed += 1
    }
  }
  return counts
}

/**
 * Builds the summary first, so a failed read is tried again next run. Then moves
 * `nextSummaryAt` on, and only then sends, so the summary goes out at most once. With
 * nothing to send (`none`, no verified email, an empty period), it still moves on.
 */
async function summarise(
  services: Services,
  seen: Profiles,
  links: Links,
): Promise<keyof SummaryCounts | undefined> {
  let email: Awaited<ReturnType<typeof summaryOf>>
  try {
    email = seen.summaryFrequency === 'none' ? undefined : await summaryOf(services, seen, links)
  } catch (error) {
    // A summary that can't be shown (an amount too big to format, say) would fail on every
    // run, so it moves on and counts as failed. Anything else, a failed read among them, leaves
    // it for the next run.
    if (!(error instanceof RangeError)) throw error
    return (await moveOn(services, seen)) ? 'failed' : undefined
  }
  if (!(await moveOn(services, seen))) return undefined
  if (!email) return 'skipped'
  try {
    await services.sendEmail({ to: email.to, ...email.content, idempotencyKey: email.key })
    return 'sent'
  } catch {
    // Moved on already, so this period's summary is lost rather than sent twice.
    return 'failed'
  }
}

class Changed extends Error {}

/**
 * Moves `nextSummaryAt` to the next send time, guarded as conventions.md#functions says: staged
 * first, then the stored row is checked. False when the profile changed after the page was
 * read (an edit, or another run that got there first); it then gets nothing from this run.
 */
async function moveOn({ db, now }: Services, seen: Profiles): Promise<boolean> {
  const next = nextSummaryAt(seen.summaryFrequency, seen.timezone, now, seen.nextSummaryAt)
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.profiles,
        rowId: seen.$id,
        data: { nextSummaryAt: next },
      })
      // The stored row, not this transaction's view, which already has the new time.
      const stored = await db.getRow<Profiles>({
        databaseId: DATABASE_ID,
        tableId: TABLES.profiles,
        rowId: seen.$id,
      })
      if (
        stored.nextSummaryAt !== seen.nextSummaryAt ||
        stored.summaryFrequency !== seen.summaryFrequency ||
        stored.timezone !== seen.timezone
      ) {
        throw new Changed()
      }
    })
    return true
  } catch (error) {
    if (error instanceof Changed) return false
    // Changed or deleted after staging.
    if (error instanceof AppwriteException && (error.code === 404 || error.code === 409)) {
      return false
    }
    throw error
  }
}

/**
 * The summary email for the period the profile's `nextSummaryAt` closes (ledger.md#reports),
 * or undefined with no verified email to send it to, or nothing to say: no shares in the
 * period and every balance at 0. Balances are as of the period's end.
 */
async function summaryOf(
  services: Services,
  profile: Profiles,
  links: Links,
): Promise<{ to: string; content: EmailContent; key: string } | undefined> {
  const to = await verifiedEmail(services, profile.$id)
  if (!to) return undefined
  const sendDate = localToday(profile.timezone, new Date(profile.nextSummaryAt as string))
  const period = summaryPeriod(profile.summaryFrequency as PeriodCycle, sendDate)
  const groups = await joinedGroups(services, profile.personId)
  // Nothing to say, and Appwrite refuses an `equal` with no values.
  if (groups.length === 0) return undefined
  // idx_person_date
  const shares = await everyRow<Shares>(services, TABLES.shares, [
    Query.equal('personId', profile.personId),
    Query.lessThanEqual('date', period.end),
    Query.equal(
      'groupId',
      groups.map((group) => group.$id),
    ),
  ])
  const inPeriod = shares.filter((share) => share.date >= period.start)
  const balances = groups
    .map((group) => ({
      groupName: group.name,
      currency: group.currency,
      // Only this person's shares, so one net.
      cents:
        netsFromShares(shares.filter((share) => share.groupId === group.$id))[0]?.netCents ?? 0,
    }))
    .filter((balance) => balance.cents !== 0)
  if (inPeriod.length === 0 && balances.length === 0) return undefined
  const reports = buildPersonalReport(
    profile.personId,
    inPeriod,
    groups.map((group) => ({ id: group.$id, type: group.type, currency: group.currency })),
  )
  return {
    to,
    content: summaryEmail({
      periodStart: period.start,
      periodEnd: period.end,
      reports,
      balances,
      url: links.home,
      profileUrl: links.profile,
    }),
    key: `summary-${profile.$id}-${period.end}`,
  }
}

/**
 * The groups whose money the summary covers: the ones the person joined, so an `active` or
 * `left` member row, archived groups included (ledger.md#reports, D-016).
 */
async function joinedGroups({ db }: Services, personId: string): Promise<Groups[]> {
  // idx_person_status
  const members = await everyRow<Members>({ db }, TABLES.members, [
    Query.equal('personId', personId),
    Query.equal('status', ['active', 'left']),
  ])
  return Promise.all(
    members.map(({ groupId }) =>
      db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId }),
    ),
  )
}

// Only to the account's own email, and only once it's verified (scheduling.md, step 4).
async function verifiedEmail({ users }: Services, userId: string): Promise<string | undefined> {
  try {
    const user = await users.get({ userId })
    return user.emailVerification && user.email ? user.email : undefined
  } catch (error) {
    // The account was deleted.
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}

// All matching rows, however far the run has got: a summary needs every one.
async function everyRow<R extends Models.Row>(
  { db }: Pick<Services, 'db'>,
  tableId: TableId,
  queries: string[],
): Promise<R[]> {
  const rows: R[] = []
  for await (const row of pages<R>({ db, outOfTime: () => false }, tableId, queries)) {
    rows.push(row)
  }
  return rows
}
