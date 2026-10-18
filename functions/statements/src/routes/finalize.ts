import { addDays, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type {
  Groups,
  Persons,
  Profiles,
  Statements,
  Transactions,
} from '@ledgerly/core/generated/rows'
import { finalizeStatementBodySchema } from '@ledgerly/core/schemas/statements'
import { netsFromShares } from '@ledgerly/core/settle/nets'
import { checkSnapshot } from '@ledgerly/core/statements/snapshot'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction, writeInBatches } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { renderInvoicePdf } from '@ledgerly/server/pdf/invoice-pdf'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getRowOrNull,
  getStatement,
  groupGuard,
  invalid,
  listAll,
  parseBody,
  snapshotOf,
  teamRead,
  tryAgain,
  updateStatement,
} from '../shared'
import { computeSnapshot, sharesOf } from '../snapshot'
import { sendInvoice } from './send'

/**
 * `statements POST /statements/{id}/finalize` (admin; called async): statements.md#2-finalize.
 * Each step is recorded on the statement before the next starts, so an interrupted finalize is
 * called again and goes on where it stopped.
 */
export async function finalizeRoute(
  services: Services,
  userId: string,
  statementId: string,
  body: unknown,
): Promise<Statements> {
  const { send } = parseBody(finalizeStatementBodySchema, body)
  const statement = await getStatement(services.db, statementId)
  const { person, group } = await requireMember(services.db, userId, statement.groupId, {
    roles: ['admin'],
  })
  return finalizeStatement(services, group, statement, person.$id, send)
}

/** Finalizes `statement`; the statements job auto-finalizes with no actor. */
export async function finalizeStatement(
  services: Services,
  group: Groups,
  statement: Statements,
  actorPersonId: string | null,
  send: boolean,
): Promise<Statements> {
  const { db } = services
  if (statement.status === 'void') throw invalid('A void statement can’t be finalized.')
  if (statement.type !== 'invoice') throw invalid('House divides are not available yet.')
  let current = statement
  return conflictAsTryAgain(async () => {
    if (current.status !== 'final') {
      await requireOldestUnfinished(db, current)
      if (current.status === 'draft') current = await startFinalizing(db, group, current)
      if (current.number === null) current = await numberInvoice(db, group, current)
      if (current.issuedOn === null) current = await lockAndIssue(services, group, current)
      if (current.pdfFileId === null) current = await renderPdf(services, current)
      current = await markFinal(services, current, actorPersonId)
    }
    if (send && current.sentAt === null)
      current = await sendInvoice(services, group, current, actorPersonId)
    // The row as stored, with Appwrite's own fields up to date.
    return getStatement(db, current.$id)
  })
}

/** statements.md#core-rules, rule 5: periods lock in order. */
async function requireOldestUnfinished(db: Db, statement: Statements): Promise<void> {
  const {
    rows: [oldest],
  } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', statement.groupId),
      Query.equal('status', ['draft', 'finalizing']),
      Query.orderAsc('periodEnd'),
      Query.limit(1),
    ],
    total: false,
  })
  if (oldest && oldest.$id !== statement.$id) {
    throw new AppError('CONFLICT', 'Finalize the earlier statement of this group first.')
  }
}

/**
 * Step 1: `finalizing`, and a guard write to the group row in the same transaction, so a ledger write
 * that checked for finalizing statements before this fails its commit (ledger.md#concurrency),
 * and so does a void or reissue in the group. Rule 5 is checked again after staging.
 */
async function startFinalizing(db: Db, group: Groups, statement: Statements): Promise<Statements> {
  return updateStatement(db, statement, { status: 'finalizing' }, [groupGuard(group)], () =>
    requireOldestUnfinished(db, statement),
  )
}

/**
 * Step 2: the issuer's next invoice number, in the same transaction as the statement's, so
 * no number is ever lost. The profile is staged before it's checked, so two finalizes for
 * one worker can't take the same number.
 */
async function numberInvoice(db: Db, group: Groups, statement: Statements): Promise<Statements> {
  const person = await db.getRow<Persons>({
    databaseId: DATABASE_ID,
    tableId: TABLES.persons,
    rowId: group.ownerPersonId,
  })
  if (!person.userId) throw new Error('An invoice issuer always has an account')
  const profile = await db.getRow<Profiles>({
    databaseId: DATABASE_ID,
    tableId: TABLES.profiles,
    rowId: person.userId,
  })
  const number = profile.lastInvoiceNumber + 1
  const displayNumber = `${profile.invoicePrefix}${String(number).padStart(4, '0')}`
  await withTransaction(db, async (tx) => {
    await tx.write(
      {
        action: 'update',
        tableId: TABLES.profiles,
        rowId: profile.$id,
        data: { lastInvoiceNumber: number },
      },
      {
        action: 'update',
        tableId: TABLES.statements,
        rowId: statement.$id,
        data: { number, displayNumber },
      },
    )
    const [stored, row] = await Promise.all([
      getRowOrNull<Profiles>(db, TABLES.profiles, profile.$id),
      getRowOrNull<Statements>(db, TABLES.statements, statement.$id),
    ])
    if (stored?.lastInvoiceNumber !== profile.lastInvoiceNumber || row?.number !== null) {
      throw tryAgain()
    }
  })
  return { ...statement, number, displayNumber }
}

/**
 * Steps 3 to 6: the snapshot of what's being locked, the locks, and the check
 * against a fresh sum of every locked share. If the check fails, everything is unlocked and
 * the statement goes back to `draft`. Then the snapshot is stored with `issuedOn` and `dueOn`,
 * before anything is rendered, so a run on another day prints the same dates.
 */
async function lockAndIssue(
  services: Services,
  group: Groups,
  statement: Statements,
): Promise<Statements> {
  const { db, now } = services
  const period = {
    start: statement.periodStart as LocalDate,
    end: statement.periodEnd as LocalDate,
  }
  const { snapshot, unlockedIds } = await computeSnapshot(db, group, period, now, statement.$id)
  await writeInBatches(
    db,
    unlockedIds.map((rowId) => ({
      action: 'update',
      tableId: TABLES.transactions,
      rowId,
      data: { statementId: statement.$id },
    })),
  )
  const problems = checkSnapshot(snapshot, await lockedBalances(db, group.$id))
  if (problems.length > 0) {
    await unlock(db, statement.$id)
    await updateStatement(db, statement, { status: 'draft' })
    // IDs and problem names only (security-and-privacy.md).
    console.error(`statements: statement ${statement.$id} failed its check: ${problems.join(', ')}`)
    throw new AppError(
      'INVARIANT_VIOLATION',
      'The statement didn’t add up, so it wasn’t finalized. It is a draft again.',
    )
  }
  const issuedOn = localToday(group.timezone, now)
  const dueOn = snapshot.invoice ? addDays(issuedOn, snapshot.invoice.paymentTermsDays) : null
  if (snapshot.invoice && dueOn) snapshot.invoice.dueOn = dueOn
  return updateStatement(db, statement, {
    snapshotJson: JSON.stringify(snapshot),
    issuedOn,
    dueOn,
  })
}

/** Every person's balance from all the locked shares in the group (finalize step 5). */
async function lockedBalances(db: Db, groupId: string) {
  const locked = await listAll<Transactions>(db, TABLES.transactions, [
    Query.equal('groupId', groupId),
    Query.isNotNull('statementId'),
  ])
  const shares = await sharesOf(db, locked)
  return netsFromShares([...shares.values()].flat())
}

/** Takes this statement's locks off again (a failed check, or a void). */
export async function unlock(db: Db, statementId: string): Promise<void> {
  const locked = await listAll<Transactions>(db, TABLES.transactions, [
    Query.equal('statementId', statementId),
  ])
  await writeInBatches(
    db,
    locked.map((row) => ({
      action: 'update',
      tableId: TABLES.transactions,
      rowId: row.$id,
      data: { statementId: null },
    })),
  )
}

/** Step 7: the PDF, uploaded with the statement's ID as its file ID, readable by the team. */
async function renderPdf({ db, files }: Services, statement: Statements): Promise<Statements> {
  const snapshot = snapshotOf(statement)
  const displayNumber = statement.displayNumber ?? ''
  const pdf = await renderInvoicePdf(snapshot, {
    displayNumber,
    issuedOn: statement.issuedOn as LocalDate,
  })
  await files.upload(statement.$id, `${displayNumber}.pdf`, pdf, teamRead(statement.groupId))
  return updateStatement(db, statement, { pdfFileId: statement.$id })
}

/** Step 8. */
async function markFinal(
  { db, now }: Services,
  statement: Statements,
  actorPersonId: string | null,
): Promise<Statements> {
  return updateStatement(db, statement, { status: 'final', finalizedBy: actorPersonId }, [
    activityWrite(
      statement.groupId,
      actorPersonId,
      'statement.finalized',
      `Invoice ${statement.displayNumber} finalized`,
      now,
    ),
  ])
}
