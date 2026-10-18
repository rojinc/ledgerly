import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { statementReadyEmail } from '@ledgerly/server/email/templates'
import { ID, Query } from 'node-appwrite'
import { joinedAdmins, verifiedEmails } from '../people'
import { closeAfter, closingPeriod } from '../period'
import type { Services } from '../services'
import { activityWrite, getRowOrNull, teamRead } from '../shared'
import { computeSnapshot, statementTypeOf } from '../snapshot'
import { finalizeStatement } from './finalize'

// Inside the function's 300 s timeout (environments-and-deploys.md): what's left waits an hour.
const BUDGET_MS = 240_000
const PAGE_SIZE = 100

/** Another run drafted this group's period first. */
class AlreadyDrafted extends Error {}

/**
 * The statements job (cron `15 * * * *`, statements.md#1-draft): drafts the statement of every
 * employer group whose `nextCloseAt` has passed. House divides come with #46.
 */
export async function draftDueStatements(
  services: Services,
): Promise<{ drafted: number; failed: number }> {
  const started = Date.now()
  const seen = new Set<string>()
  let drafted = 0
  let failed = 0
  while (Date.now() - started < BUDGET_MS) {
    const { rows } = await services.db.listRows<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      queries: [
        Query.lessThanEqual('nextCloseAt', services.now.toISOString()),
        Query.equal('type', 'employer'),
        Query.orderAsc('nextCloseAt'),
        Query.limit(PAGE_SIZE),
      ],
      total: false,
    })
    // A drafted group's nextCloseAt moves on, so it usually leaves the list. One that's still
    // due (a job that fell behind) or that failed waits for the next run.
    const due = rows.filter((group) => !seen.has(group.$id))
    if (due.length === 0) break
    for (const group of due) {
      seen.add(group.$id)
      try {
        if (await draftFor(services, group as Groups & { nextCloseAt: string })) drafted += 1
      } catch (error) {
        failed += 1
        // IDs only: no names, amounts or addresses in logs (security-and-privacy.md).
        console.error(`statements: drafting failed for group ${group.$id}: ${describe(error)}`)
      }
    }
  }
  return { drafted, failed }
}

/**
 * In one database transaction: the draft, with its snapshot, and the group's next close. A run
 * that races another fails here, because the group row changed (statements.md#1-draft). Then
 * the admins are emailed. False if another run drafted it first.
 */
async function draftFor(
  services: Services,
  group: Groups & { nextCloseAt: string },
): Promise<boolean> {
  const { db, now } = services
  const period = closingPeriod(group)
  const { snapshot } = await computeSnapshot(db, group, period, now)
  const statementId = ID.unique()
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: group.$id,
        data: { nextCloseAt: closeAfter(group, period.end) },
      })
      // Stage, then check (conventions.md): a run that drafted this period first moved
      // nextCloseAt; an archive cleared it.
      const current = await getRowOrNull<Groups>(db, TABLES.groups, group.$id)
      if (current?.nextCloseAt !== group.nextCloseAt) throw new AlreadyDrafted()
      await tx.write(
        {
          action: 'create',
          tableId: TABLES.statements,
          rowId: statementId,
          data: {
            groupId: group.$id,
            type: statementTypeOf(group),
            periodStart: period.start,
            periodEnd: period.end,
            status: 'draft',
            number: null,
            displayNumber: null,
            issuedOn: null,
            dueOn: null,
            snapshotJson: JSON.stringify(snapshot),
            pdfFileId: null,
            sentAt: null,
            finalizedBy: null,
          },
          permissions: teamRead(group.$id),
        },
        activityWrite(group.$id, null, 'statement.drafted', draftSummary(period.end), now),
      )
    })
  } catch (error) {
    if (error instanceof AlreadyDrafted) return false
    throw error
  }
  await emailAdmins(services, group, statementId, period)
  if (autoFinalizes(group)) {
    const draft = await db.getRow<Statements>({
      databaseId: DATABASE_ID,
      tableId: TABLES.statements,
      rowId: statementId,
    })
    try {
      // No actor: the job finalizes it. Sending stays the admin's call.
      await finalizeStatement(services, group, draft, null, false)
    } catch (error) {
      // The draft stays for an admin to finalize.
      console.error(
        `statements: auto-finalize failed for statement ${statementId}: ${describe(error)}`,
      )
    }
  }
  return true
}

function autoFinalizes(group: Groups): boolean {
  const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
  return 'autoFinalize' in settings && settings.autoFinalize
}

/** "Your October invoice for Acme is ready to review", to every joined admin. Best effort. */
async function emailAdmins(
  services: Services,
  group: Groups,
  statementId: string,
  period: { start: LocalDate; end: LocalDate },
): Promise<void> {
  const admins = await joinedAdmins(services.db, group.$id)
  const emails = await verifiedEmails(
    services.db,
    admins.map((admin) => admin.personId),
  )
  const content = statementReadyEmail({
    type: statementTypeOf(group),
    groupName: group.name,
    periodStart: period.start,
    periodEnd: period.end,
    url: `${services.appUrl}/groups/${group.$id}/statements/${statementId}`,
  })
  for (const admin of admins) {
    const to = emails.get(admin.personId)
    if (!to?.length) continue
    try {
      await services.sendEmail({
        to,
        ...content,
        idempotencyKey: `ready-${statementId}-${admin.personId}`,
      })
    } catch (error) {
      // The draft is made; the email is a courtesy (the app lists drafts too).
      console.error(
        `statements: ready email failed for statement ${statementId}: ${describe(error)}`,
      )
    }
  }
}

function draftSummary(periodEnd: string): string {
  return `Statement for the period ending ${periodEnd} drafted`
}

// An error's name and message, never a stack or request data. EmailError and Appwrite messages
// hold no personal data.
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
}
