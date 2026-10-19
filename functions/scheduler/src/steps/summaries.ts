import type { PeriodCycle } from '@ledgerly/core/dates/periods'
import { nextSummaryAt, summaryPeriod } from '@ledgerly/core/dates/summary-period'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Members, Profiles, Shares } from '@ledgerly/core/generated/rows'
import { buildPersonalReport } from '@ledgerly/core/reports/personal-report'
import { netsFromShares } from '@ledgerly/core/settle/nets'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { isInTeam } from '@ledgerly/server/appwrite/teams'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { EmailError } from '@ledgerly/server/email/send-email'
import { type EmailContent, summaryEmail } from '@ledgerly/server/email/templates'
import { logProblem } from '@ledgerly/server/http/log'
import { AppwriteException, Query } from 'node-appwrite'
import { allRows, pages } from '../pages'
import { appBase, type Services } from '../services'
import { NEVER_SENT } from './reminders'

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
    } catch (error) {
      // The next run tries it again: nextSummaryAt hasn't moved.
      logProblem('summary_failed', { profileId: profile.$id, error })
      counts.failed += 1
    }
  }
  return counts
}

/**
 * Builds the summary, then moves `nextSummaryAt` on and sends it (`moveOn`). A failed read is
 * tried again next run. With nothing to send (`none`, no verified email, an empty period), it
 * still moves on.
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
    // One that can never be built (an amount too big to show, a query Appwrite refuses) would
    // fail on every run, and a group row gone only meets a deleted person, who gets none: these
    // move on and count as failed. Anything else leaves it for the next run: a timeout, a rate
    // limit, an outage, a key missing a scope or a table missing, so a config error fixed later
    // loses no period.
    if (!lasting(error)) throw error
    logProblem('summary_failed', { profileId: seen.$id, error })
    return (await moveOn(services, seen)) ? 'failed' : undefined
  }
  return moveOn(services, seen, email)
}

// A row gone, not a table or route missing (as transaction.ts's ROW_GONE).
const ROW_GONE = ['row_not_found', 'document_not_found']

function lasting(error: unknown): boolean {
  if (error instanceof RangeError) return true
  if (!(error instanceof AppwriteException)) return false
  return error.code === 400 || (error.code === 404 && ROW_GONE.includes(error.type))
}

class Changed extends Error {}

/**
 * Moves `nextSummaryAt` to the next send time and sends `email`, as reminders do
 * (scheduling.md#step-4-summary-emails, conventions.md#functions): the new time is staged, the
 * stored row is checked, and the email goes out before the commit, with a key Resend delivers
 * once within 24 hours. A failed send rolls the move back, so the next run tries again; an
 * email Resend will never take moves on and counts as failed. Undefined when the profile
 * changed after the page was read (an edit, or another run that got there first): it gets
 * nothing from this run.
 */
async function moveOn(
  { db, now, sendEmail }: Services,
  seen: Profiles,
  email?: { to: string; content: EmailContent; key: string },
): Promise<keyof SummaryCounts | undefined> {
  const next = nextSummaryAt(seen.summaryFrequency, seen.timezone, now, seen.nextSummaryAt)
  let outcome = 'skipped' as keyof SummaryCounts
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
      if (!email) return
      try {
        await sendEmail({ to: email.to, ...email.content, idempotencyKey: email.key })
        outcome = 'sent'
      } catch (error) {
        if (!(error instanceof EmailError && NEVER_SENT.has(error.type))) throw error
        outcome = 'failed'
      }
    })
    return outcome
  } catch (error) {
    if (error instanceof Changed) return undefined
    // Changed or deleted after staging: the next run looks at it again. An email that went out
    // still counts; Resend won't deliver it twice within 24 hours.
    if (error instanceof AppwriteException && (error.code === 404 || error.code === 409)) {
      return outcome === 'sent' ? 'sent' : undefined
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
  const groups = await joinedGroups(services, profile)
  // idx_person_date, for at most 100 groups at a time (Appwrite's cap on `equal`'s values).
  // Every one, however far the run has got: a summary needs them all.
  const shares: Shares[] = []
  for (let start = 0; start < groups.length; start += PAGE_GROUPS) {
    const ids = groups.slice(start, start + PAGE_GROUPS).map((group) => group.$id)
    shares.push(
      ...(await allRows<Shares>(services.db, TABLES.shares, [
        Query.equal('personId', profile.personId),
        Query.lessThanEqual('date', period.end),
        Query.equal('groupId', ids),
      ])),
    )
  }
  const inPeriod = shares.filter((share) => share.date >= period.start)
  const owing = groups
    .map((group) => ({
      group,
      // Only this person's shares, so one net.
      cents:
        netsFromShares(shares.filter((share) => share.groupId === group.$id))[0]?.netCents ?? 0,
    }))
    .filter(({ cents }) => cents !== 0)
  const balances = await Promise.all(
    owing.map(async ({ group, cents }) => ({
      groupName: await nameFor(services, group, profile),
      currency: group.currency,
      cents,
    })),
  )
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

const PAGE_GROUPS = 100

/**
 * The groups whose money the summary covers: the ones the person joined and can still open,
 * archived groups included (ledger.md#reports, D-016). An `active` member row, or a `left` one
 * while they're still in the group's team: someone who moved out is, someone who left on their
 * own isn't (permissions.md#members).
 */
async function joinedGroups({ db, teams }: Services, profile: Profiles): Promise<Groups[]> {
  // idx_person_status
  const members = await allRows<Members>(db, TABLES.members, [
    Query.equal('personId', profile.personId),
    Query.equal('status', ['active', 'left']),
  ])
  const open = await Promise.all(
    members.map(
      (member) => member.status === 'active' || isInTeam(teams, member.groupId, profile.$id),
    ),
  )
  return Promise.all(
    members
      .filter((_, index) => open[index])
      .map(({ groupId }) =>
        db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId }),
      ),
  )
}

/**
 * The group's name as the app shows it to this person: a pair group's own `name` is its
 * creator's label for the other member, which may be this person, so a pair is named by its
 * other member (#145).
 */
async function nameFor({ db }: Services, group: Groups, profile: Profiles): Promise<string> {
  if (group.type !== 'pair') return group.name
  const members = await allRows<Members>(db, TABLES.members, [Query.equal('groupId', group.$id)])
  return members.find((member) => member.personId !== profile.personId)?.displayName ?? group.name
}

// Only to the account's own email, once it's verified, and not once the account is blocked:
// deleting it blocks it first (scheduling.md, step 4).
async function verifiedEmail({ users }: Services, userId: string): Promise<string | undefined> {
  try {
    const user = await users.get({ userId })
    return user.status && user.emailVerification && user.email ? user.email : undefined
  } catch (error) {
    // The account was deleted.
    if (error instanceof AppwriteException && error.code === 404) return undefined
    throw error
  }
}
