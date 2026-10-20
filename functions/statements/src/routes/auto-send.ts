import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { EmailError } from '@ledgerly/server/email/send-email'
import { autoSendFailedEmail } from '@ledgerly/server/email/templates'
import { AppError } from '@ledgerly/server/http/app-error'
import { logProblem } from '@ledgerly/server/http/log'
import { Query } from 'node-appwrite'
import { joinedAdmins, verifiedEmails } from '../people'
import type { Services } from '../services'
import { getRowOrNull, invalid, listAll, snapshotOf, updateStatement } from '../shared'
import { sendInvoice } from './send'

// Inside Resend's 24 hours for an idempotency key, so every try in the window reuses the same
// keys and the employer gets the invoice once (statements.md#auto-send).
const WINDOW_MS = 23 * 60 * 60 * 1000

// Resend's answers that a retry with the same keys can't change.
const PERMANENT = ['validation_error', 'invalid_idempotent_request']

/** When the job's window to email an invoice it finalizes ends (finalize step 8). */
export function autoSendUntil(now: Date): string {
  return new Date(now.getTime() + WINDOW_MS).toISOString()
}

/** Whether the group's admins asked the job to email what it auto-finalizes. */
export function autoSends(group: Groups): boolean {
  const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
  return settings.type === 'employer' && settings.autoSend === true
}

/**
 * The job's auto-send step (statements.md#auto-send): emails each final invoice whose window is
 * open and that isn't sent yet, as an admin's Send does but with no actor, until `outOfTime`
 * says so or Resend says to slow down. What's left waits for the next run.
 */
export async function sendDueInvoices(services: Services, outOfTime: () => boolean): Promise<void> {
  // idx_autoSendUntil
  const open = await listAll<Statements>(services.db, TABLES.statements, [
    Query.greaterThan('autoSendUntil', services.now.toISOString()),
    Query.equal('status', 'final'),
    Query.isNull('sentAt'),
  ])
  for (const { $id } of open) {
    if (outOfTime()) return
    try {
      if (!(await sendOne(services, $id))) return
    } catch (error) {
      // A read that failed: this one waits for the next run, and the rest go on.
      logProblem('auto_send_failed', { statementId: $id, error })
    }
  }
}

// False when Resend's rate limit ends the step for this run.
async function sendOne(services: Services, statementId: string): Promise<boolean> {
  const { db, now } = services
  // As they are now: a void, an admin's Send or a settings change may have come first.
  const statement = await getRowOrNull<Statements>(db, TABLES.statements, statementId)
  if (
    statement?.status !== 'final' ||
    statement.sentAt !== null ||
    (statement.autoSendUntil ?? '') <= now.toISOString()
  ) {
    return true
  }
  const group = await getRowOrNull<Groups>(db, TABLES.groups, statement.groupId)
  if (!group || group.archivedAt || !autoSends(group)) return true
  try {
    // An admin's Send goes without the worker's reply-to and copy; this one doesn't.
    const workerId = snapshotOf(statement).issuer?.personId ?? ''
    if (!(await verifiedEmails(db, [workerId])).get(workerId)?.length) {
      throw invalid('The worker has no verified email for the reply-to and copy.')
    }
    await sendInvoice(services, group, statement, null)
    return true
  } catch (error) {
    // A Send or a void that got in first leaves nothing to do, or to tell.
    const current = await getRowOrNull<Statements>(db, TABLES.statements, statementId)
    if (current?.status !== 'final' || current.sentAt !== null) return true
    logProblem('auto_send_failed', { statementId, error })
    if (isPermanent(error)) {
      // No later run tries.
      await updateStatement(db, current, { autoSendUntil: now.toISOString() }).catch(
        (closing: unknown) => logProblem('auto_send_failed', { statementId, error: closing }),
      )
    }
    await tellAdmins(services, group, current)
    // Resend's limit is shared: the rest waits for the next run.
    return !(error instanceof EmailError && error.status === 429)
  }
}

function isPermanent(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'VALIDATION_FAILED'
  return error instanceof EmailError && PERMANENT.includes(error.type)
}

// "Invoice INV-0010 for Acme couldn't be emailed", to every joined admin. One key per admin,
// so each gets it once however many runs fail inside the window. Best effort.
async function tellAdmins(services: Services, group: Groups, statement: Statements): Promise<void> {
  try {
    const admins = await joinedAdmins(services.db, group.$id)
    const emails = await verifiedEmails(
      services.db,
      admins.map((admin) => admin.personId),
    )
    const content = autoSendFailedEmail({
      displayNumber: statement.displayNumber ?? '',
      groupName: group.name,
      url: `${services.appUrl}/groups/${group.$id}/statements/${statement.$id}`,
    })
    for (const admin of admins) {
      const to = emails.get(admin.personId)
      if (!to?.length) continue
      await services
        .sendEmail({
          to,
          ...content,
          idempotencyKey: `auto-send-failed/${statement.$id}/${admin.personId}`,
        })
        .catch((error: unknown) =>
          logProblem('auto_send_notice_failed', { statementId: statement.$id, error }),
        )
    }
  } catch (error) {
    logProblem('auto_send_notice_failed', { statementId: statement.$id, error })
  }
}
