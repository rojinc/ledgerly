import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { invoiceEmail } from '@ledgerly/server/email/templates'
import { verifiedEmails } from '../people'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getStatement,
  invalid,
  snapshotOf,
  updateStatement,
} from '../shared'

/** `statements POST /statements/{id}/send` (admin, final only): sends or resends the invoice. */
export async function sendRoute(
  services: Services,
  userId: string,
  statementId: string,
): Promise<{ sentAt: string }> {
  const statement = await getStatement(services.db, statementId)
  const { person, group } = await requireMember(services.db, userId, statement.groupId, {
    roles: ['admin'],
  })
  if (statement.status !== 'final') throw invalid('Only a final statement can be sent.')
  if (statement.type !== 'invoice') throw invalid('House divides are not available yet.')
  const sent = await conflictAsTryAgain(() => sendInvoice(services, group, statement, person.$id))
  return { sentAt: sent.sentAt as string }
}

/**
 * statements.md#3-send-and-resend: the invoice, with its PDF, to the group's billing emails,
 * reply-to the worker, and a copy to the worker. Each send has its own idempotency keys, so a
 * retried request isn't delivered twice but a resend is.
 */
export async function sendInvoice(
  services: Services,
  group: Groups,
  statement: Statements,
  actorPersonId: string | null,
): Promise<Statements> {
  const { db, files, now } = services
  const settings = groupSettingsSchema.parse(JSON.parse(group.settingsJson))
  const recipients = settings.type === 'employer' ? settings.recipients : []
  if (recipients.length === 0) throw invalid('Add a billing email to the group first.')
  const snapshot = snapshotOf(statement)
  const { issuer, invoice } = snapshot
  if (!issuer || !invoice?.dueOn || !statement.pdfFileId || !statement.displayNumber) {
    throw new Error('A final invoice has an issuer, a due date, a number and a PDF')
  }
  const [workerEmail] = (await verifiedEmails(db, [issuer.personId])).get(issuer.personId) ?? []
  const content = invoiceEmail({
    issuerName: issuer.business.businessName ?? issuer.name,
    displayNumber: statement.displayNumber,
    periodStart: snapshot.period.start,
    periodEnd: snapshot.period.end,
    balanceDueCents: invoice.balanceDueCents,
    currency: snapshot.group.currency,
    dueOn: invoice.dueOn as LocalDate,
    pdf: await files.download(statement.pdfFileId),
  })
  // A retry of this send finds the same sentAt, so it reuses the keys.
  const key = `invoice-${statement.$id}-${statement.sentAt ?? 'first'}`
  await services.sendEmail({
    to: recipients,
    ...content,
    replyTo: workerEmail,
    idempotencyKey: key,
  })
  if (workerEmail) {
    await services.sendEmail({ to: workerEmail, ...content, idempotencyKey: `${key}-copy` })
  }
  return updateStatement(db, statement, { sentAt: now.toISOString() }, [
    activityWrite(
      statement.groupId,
      actorPersonId,
      'statement.sent',
      `Invoice ${statement.displayNumber} sent`,
      now,
    ),
  ])
}
