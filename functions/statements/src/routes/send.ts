import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Members, Persons, Statements } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { isInTeam } from '@ledgerly/server/appwrite/teams'
import { requireMemberOf } from '@ledgerly/server/auth/require-member'
import { divideEmail, invoiceEmail } from '@ledgerly/server/email/templates'
import { Query } from 'node-appwrite'
import { verifiedEmails } from '../people'
import type { Services } from '../services'
import {
  activityWrite,
  chunks,
  conflictAsTryAgain,
  getRowOrNull,
  getStatement,
  invalid,
  listAll,
  NO_SUCH_STATEMENT,
  snapshotOf,
  statementName,
  updateStatement,
} from '../shared'

// Divide emails sent at once: 15 housemates fit well inside a request's 30 seconds.
const SEND_AT_ONCE = 5

/** `statements POST /statements/{id}/send` (admin, final only): sends or resends it. */
export async function sendRoute(
  services: Services,
  userId: string,
  statementId: string,
): Promise<{ sentAt: string }> {
  const statement = await getStatement(services.db, statementId)
  const { person, group } = await requireMemberOf(
    services.db,
    services.teams,
    userId,
    statement.groupId,
    NO_SUCH_STATEMENT,
    { roles: ['admin'] },
  )
  if (statement.status !== 'final') throw invalid('Only a final statement can be sent.')
  const sent = await conflictAsTryAgain(() => sendStatement(services, group, statement, person.$id))
  return { sentAt: sent.sentAt as string }
}

/** The invoice to the employer, or the divide to each housemate (statements.md#3-send-and-resend). */
export function sendStatement(
  services: Services,
  group: Groups,
  statement: Statements,
  actorPersonId: string | null,
): Promise<Statements> {
  return statement.type === 'divide'
    ? sendDivide(services, group, statement, actorPersonId)
    : sendInvoice(services, group, statement, actorPersonId)
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
  // conventions.md: one key per email. A retry before sentAt is stored finds the same sentAt,
  // so it reuses the keys and Resend delivers each email once; a resend after that gets new ones.
  const key = `invoice/${statement.$id}/${statement.sentAt ?? 'first'}`
  await services.sendEmail({
    to: recipients,
    ...content,
    replyTo: workerEmail,
    idempotencyKey: `${key}/employer`,
  })
  if (workerEmail) {
    await services.sendEmail({ to: workerEmail, ...content, idempotencyKey: `${key}/copy` })
  }
  return updateStatement(db, statement, { sentAt: now.toISOString() }, [
    activityWrite(
      statement.groupId,
      actorPersonId,
      'statement.sent',
      `${statementName(statement)} sent`,
      now,
    ),
  ])
}

/**
 * statements.md#3-send-and-resend: each housemate gets their own email, at their verified
 * addresses, with where they stand, their own transfers and the PDF. That's every `active`
 * member, and everyone who moved out (`left`, still in the team) and is in the divide's
 * `people`. Each email has its own idempotency key, so a retried request delivers none twice,
 * and `sentAt` is stored only once all have gone.
 */
async function sendDivide(
  services: Services,
  group: Groups,
  statement: Statements,
  actorPersonId: string | null,
): Promise<Statements> {
  const { db, files, now } = services
  if (!statement.pdfFileId) throw new Error('A final divide has a PDF')
  const snapshot = snapshotOf(statement)
  const people = new Map(snapshot.people.map((person) => [person.personId, person]))
  const members = await listAll<Members>(db, TABLES.members, [
    Query.equal('groupId', group.$id),
    Query.equal('status', ['active', 'left']),
  ])
  const housemates: Members[] = []
  for (const member of members) {
    if (member.status === 'active') housemates.push(member)
    else if (people.has(member.personId) && (await movedOut(services, group, member))) {
      housemates.push(member)
    }
  }
  const emails = await verifiedEmails(
    db,
    housemates.map((housemate) => housemate.personId),
  )
  const recipients = housemates.filter((housemate) => emails.get(housemate.personId)?.length)
  if (recipients.length === 0) {
    throw invalid('Nobody in this house has a verified email to send the divide to.')
  }
  const pdf = await files.download(statement.pdfFileId)
  const nameOf = (personId: string) => people.get(personId)?.name ?? ''
  // conventions.md: one key per email, from the sentAt read before sending.
  const key = `divide/${statement.$id}/${statement.sentAt ?? 'first'}`
  for (const batch of chunks(recipients, SEND_AT_ONCE)) {
    await Promise.all(
      batch.map((housemate) =>
        services.sendEmail({
          // Only their own addresses: no email names another housemate's.
          to: emails.get(housemate.personId) as string[],
          ...divideEmail({
            groupName: group.name,
            periodStart: snapshot.period.start,
            periodEnd: snapshot.period.end,
            currency: snapshot.group.currency,
            closingCents: people.get(housemate.personId)?.closingCents ?? 0,
            pays: snapshot.transfers
              .filter((transfer) => transfer.fromPersonId === housemate.personId)
              .map((transfer) => ({ name: nameOf(transfer.toPersonId), cents: transfer.cents })),
            receives: snapshot.transfers
              .filter((transfer) => transfer.toPersonId === housemate.personId)
              .map((transfer) => ({ name: nameOf(transfer.fromPersonId), cents: transfer.cents })),
            url: `${services.appUrl}/groups/${group.$id}/statements/${statement.$id}`,
            pdf,
          }),
          idempotencyKey: `${key}/${housemate.personId}`,
        }),
      ),
    )
  }
  return updateStatement(db, statement, { sentAt: now.toISOString() }, [
    activityWrite(
      statement.groupId,
      actorPersonId,
      'statement.sent',
      `${statementName(statement)} sent`,
      now,
    ),
  ])
}

/** A `left` member who moved out is still in the team; one who left on their own isn't. */
async function movedOut(services: Services, group: Groups, member: Members): Promise<boolean> {
  const person = await getRowOrNull<Persons>(services.db, TABLES.persons, member.personId)
  return (
    Boolean(person?.userId) && (await isInTeam(services.teams, group.$id, person?.userId ?? ''))
  )
}
