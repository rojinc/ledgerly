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
import { checkSnapshot } from '@ledgerly/core/statements/snapshot'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMemberOf } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { logProblem } from '@ledgerly/server/http/log'
import { renderDividePdf } from '@ledgerly/server/pdf/divide-pdf'
import { renderInvoicePdf } from '@ledgerly/server/pdf/invoice-pdf'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  chunks,
  conflictAsTryAgain,
  getRowOrNull,
  getStatement,
  groupGuard,
  invalid,
  isAppwriteError,
  listAll,
  NO_SUCH_STATEMENT,
  parseBody,
  snapshotOf,
  statementName,
  teamRead,
  tryAgain,
  updateStatement,
} from '../shared'
import { computeSnapshot, type Membership, sharesInGroup, sharesOf } from '../snapshot'
import { autoSends, autoSendUntil } from './auto-send'
import { sendStatement } from './send'

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
  const { person, group } = await requireMemberOf(
    services.db,
    services.teams,
    userId,
    statement.groupId,
    NO_SUCH_STATEMENT,
    { roles: ['admin'] },
  )
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
  let current = statement
  return conflictAsTryAgain(async () => {
    if (current.status !== 'final') {
      await requireOldestUnfinished(db, current)
      if (current.status === 'draft') current = await startFinalizing(db, group, current)
      // A divide has no number, and never touches a profile, on a resume too (step 2).
      if (current.type === 'invoice' && current.number === null) {
        current = await numberInvoice(db, group, current)
      }
      if (current.issuedOn === null) current = await lockAndIssue(services, group, current)
      if (current.pdfFileId === null) current = await renderPdf(services, current)
      current = await markFinal(services, group, current, actorPersonId)
    }
    if (send && current.sentAt === null)
      current = await sendStatement(services, group, current, actorPersonId)
    // The row as stored, with Appwrite's own fields up to date.
    return getStatement(db, current.$id)
  })
}

/** statements.md#core-rules, rule 5: periods lock in order. */
async function requireOldestUnfinished(db: Db, statement: Statements): Promise<void> {
  if (!(await isOldestUnfinished(db, statement))) {
    throw new AppError('CONFLICT', 'Finalize the earlier statement of this group first.')
  }
}

/** Whether no unfinished statement of the group comes before this one, so rule 5 lets it finalize. */
export async function isOldestUnfinished(db: Db, statement: Statements): Promise<boolean> {
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
  return !oldest || oldest.$id === statement.$id
}

/**
 * Step 1: `finalizing`, and a guard write to the group row in the same transaction, so a ledger write
 * that checked for finalizing statements before this fails its commit (ledger.md#concurrency),
 * and so does a void or reissue in the group. Rule 5 is checked again after staging, and so is
 * the stored group: an archive that committed since the first read would otherwise leave this
 * statement `finalizing` in a group where no finalize can finish it (#190).
 */
async function startFinalizing(db: Db, group: Groups, statement: Statements): Promise<Statements> {
  return updateStatement(db, statement, { status: 'finalizing' }, [groupGuard(group)], async () => {
    const stored = await getRowOrNull<Groups>(db, TABLES.groups, group.$id)
    if (stored?.archivedAt) {
      throw new AppError('ARCHIVED', 'This group is archived, so it can no longer be changed.')
    }
    await requireOldestUnfinished(db, statement)
  })
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
 * Steps 3 to 6: the snapshot of what's being locked, the locks, and the check against a fresh
 * sum of every locked share. If the check fails, the statement goes back to `draft`, and only
 * then are its locks taken off. Then the snapshot is stored with `issuedOn` and `dueOn`, before
 * anything is rendered, so a run on another day prints the same dates.
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
  await finishVoids(db, group.$id)
  const { snapshot, unlockedIds, membership } = await computeSnapshot(
    db,
    group,
    period,
    now,
    statement.$id,
  )
  await lock(db, statement, unlockedIds)
  const problems = checkSnapshot(snapshot, await lockedBalances(db, group.$id, membership))
  if (problems.length > 0) {
    // Back to draft only if no other run of this finalize got past its check meanwhile: it
    // would have stored issuedOn, and its locks must stay. That's checked before anything is
    // unlocked, and a draft's leftover locks are this statement's again on its next finalize.
    await unlock(db, await updateStatement(db, statement, { status: 'draft', issuedOn: null }))
    logProblem('snapshot_check_failed', { statementId: statement.$id, problems })
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

/**
 * Every person's balance from all the locked shares in the group (finalize step 5), with merged
 * people counted as the snapshot counted them.
 */
async function lockedBalances(db: Db, groupId: string, membership: Membership) {
  const locked = await listAll<Transactions>(db, TABLES.transactions, [
    Query.equal('groupId', groupId),
    Query.isNotNull('statementId'),
  ])
  const shares = await sharesOf(db, locked)
  return sharesInGroup(db, membership, [...shares.values()].flat())
}

/**
 * Step 3 starts by finishing the unlock of every void statement of the group
 * (`idx_group_period`). A void unlocks after it commits, so one still unlocking, or stopped half
 * way, would otherwise leave its transactions out of this snapshot. No void can start once this
 * statement is `finalizing` (statements.md#4-void).
 */
async function finishVoids(db: Db, groupId: string): Promise<void> {
  const voids = await listAll<Statements>(db, TABLES.statements, [
    Query.equal('groupId', groupId),
    Query.equal('status', 'void'),
  ])
  for (const row of voids) await unlock(db, row)
}

// One guard write to the group row, and the rest of a database transaction's 90 writes.
const UNLOCK_BATCH = 89
// Times a batch whose commit lost to another write in the group is staged again (statements.md).
const LOCK_RETRIES = 3

/**
 * Step 4: locks the transactions to the statement, a batch per database transaction. Each batch
 * stages a guard write to the group row with its locks, then checks the stored statement is
 * still finalizing and not yet issued. So a run that read the statement before another run's
 * check failed, set it back to draft and an admin discarded it, never locks a row to a statement
 * that's gone (I-7), and the discard, which writes the group row too, fails one of the commits.
 */
async function lock(db: Db, statement: Statements, ids: readonly string[]): Promise<void> {
  for (const batch of chunks(ids, UNLOCK_BATCH)) {
    for (let misses = 0; ; ) {
      try {
        await withTransaction(db, async (tx) => {
          await tx.write(
            groupGuard({ $id: statement.groupId }),
            ...batch.map((rowId) => ({
              action: 'update' as const,
              tableId: TABLES.transactions,
              rowId,
              data: { statementId: statement.$id },
            })),
          )
          const stored = await getRowOrNull<Statements>(db, TABLES.statements, statement.$id)
          if (stored?.status !== 'finalizing' || stored.issuedOn !== null) throw tryAgain()
        })
        break
      } catch (error) {
        // Another write in the group committed first: stage the batch again.
        if (!isAppwriteError(error, 409) || ++misses > LOCK_RETRIES) throw error
      }
    }
  }
}

// Batches in a row that found their rows locked again meanwhile, before giving up.
const UNLOCK_MISSES = 3

/** A row in the batch is no longer locked to the statement: read the batch again. */
class Relocked extends Error {}

/**
 * Takes the statement's locks off (a failed check, or a void), a batch per database
 * transaction, from the `idx_statementId` rows still locked to it. Each batch stages its writes
 * and a guard write to the group row, then checks the stored rows: the statement still has the
 * status and issue date the caller left it with (a run that starts finalizing it again writes
 * the group row too), and each row is still locked to it. So a lock written by anyone else is
 * never taken off (I-7); a batch that finds one is read again without it.
 */
export async function unlock(db: Db, statement: Statements): Promise<void> {
  for (let misses = 0; ; ) {
    const { rows } = await db.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: TABLES.transactions,
      queries: [Query.equal('statementId', statement.$id), Query.limit(UNLOCK_BATCH)],
      total: false,
    })
    if (rows.length === 0) return
    const ids = rows.map((row) => row.$id)
    try {
      await withTransaction(db, async (tx) => {
        await tx.write(
          groupGuard({ $id: statement.groupId }),
          ...ids.map((rowId) => ({
            action: 'update' as const,
            tableId: TABLES.transactions,
            rowId,
            data: { statementId: null },
          })),
        )
        const stored = await getRowOrNull<Statements>(db, TABLES.statements, statement.$id)
        if (stored?.status !== statement.status || stored.issuedOn !== statement.issuedOn) {
          throw tryAgain()
        }
        const { rows: now } = await db.listRows<Transactions>({
          databaseId: DATABASE_ID,
          tableId: TABLES.transactions,
          queries: [Query.equal('$id', ids), Query.limit(ids.length)],
          total: false,
        })
        if (now.length !== ids.length || now.some((row) => row.statementId !== statement.$id)) {
          throw new Relocked()
        }
      })
      misses = 0
    } catch (error) {
      // Relocked before the batch staged, or after (the commit's 409): read the batch again.
      if (!(error instanceof Relocked || isAppwriteError(error, 409))) throw error
      if (++misses === UNLOCK_MISSES) throw tryAgain()
    }
  }
}

/** Step 7: the PDF, uploaded with the statement's ID as its file ID, readable by the team. */
async function renderPdf({ db, files }: Services, statement: Statements): Promise<Statements> {
  const snapshot = snapshotOf(statement)
  const [pdf, name] =
    statement.type === 'divide'
      ? [await renderDividePdf(snapshot), `divide-${statement.periodEnd}.pdf`]
      : [
          await renderInvoicePdf(snapshot, {
            displayNumber: statement.displayNumber ?? '',
            issuedOn: statement.issuedOn as LocalDate,
          }),
          `${statement.displayNumber ?? ''}.pdf`,
        ]
  await files.upload(statement.$id, name, pdf, teamRead(statement.groupId))
  return updateStatement(db, statement, { pdfFileId: statement.$id })
}

/**
 * Step 8. The job's finalize of an invoice with lines in a group with `autoSend` on also opens
 * the window in which the job emails it (statements.md#auto-send). One with no lines could ask
 * the employer for a balance they were already invoiced for.
 */
async function markFinal(
  { db, now }: Services,
  group: Groups,
  statement: Statements,
  actorPersonId: string | null,
): Promise<Statements> {
  const window =
    actorPersonId === null && autoSends(group) && snapshotOf(statement).lines.length > 0
      ? { autoSendUntil: autoSendUntil(now) }
      : {}
  return updateStatement(
    db,
    statement,
    { status: 'final', finalizedBy: actorPersonId, ...window },
    [
      activityWrite(
        statement.groupId,
        actorPersonId,
        'statement.finalized',
        `${statementName(statement)} finalized`,
        now,
      ),
    ],
  )
}
