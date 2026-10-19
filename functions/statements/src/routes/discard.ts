import type { Statements, Transactions } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMemberOf } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getRowOrNull,
  getStatement,
  groupGuard,
  invalid,
  NO_SUCH_STATEMENT,
  parseBody,
  statementName,
  tryAgain,
} from '../shared'
import { unlock } from './finalize'

/**
 * `statements POST /statements/{id}/discard` (admin, drafts only): deletes the draft
 * (statements.md#5-discard). `nextCloseAt` stays, and the draft's transactions land on the
 * next statement. Calling it again gets NOT_FOUND, which the app treats as done.
 */
export async function discardRoute(
  { db, teams, now }: Services,
  userId: string,
  statementId: string,
  body: unknown,
): Promise<Record<string, never>> {
  parseBody(emptyBodySchema, body ?? {})
  const statement = await getStatement(db, statementId)
  const { person, group } = await requireMemberOf(
    db,
    teams,
    userId,
    statement.groupId,
    NO_SUCH_STATEMENT,
    { roles: ['admin'] },
  )
  if (statement.status === 'finalizing') {
    throw new AppError(
      'CONFLICT',
      'This statement is being finalized. Finalize it again to finish.',
    )
  }
  if (statement.status !== 'draft') {
    throw invalid('Only a draft can be discarded. Void a final statement instead.')
  }
  // Finalize step 2 promises no invoice number is ever lost.
  if (statement.number !== null) {
    throw invalid('This invoice already has its number, so finalize it rather than discard it.')
  }
  return conflictAsTryAgain(async () => {
    // A finalize whose check failed, and whose unlock stopped half way, leaves locks behind.
    await unlock(db, statement)
    await withTransaction(db, async (tx) => {
      // The group row is staged too, so a finalize starting now (its step 1 writes the group
      // row) fails one of the two commits.
      await tx.write(
        { action: 'delete', tableId: TABLES.statements, rowId: statement.$id },
        groupGuard(group),
        activityWrite(
          group.$id,
          person.$id,
          'statement.discarded',
          `${statementName(statement)} discarded`,
          now,
        ),
      )
      // Then from the stored rows: a finalize that ran meanwhile may have numbered the draft,
      // failed its check and set it back to draft, or left a lock.
      const stored = await getRowOrNull<Statements>(db, TABLES.statements, statement.$id)
      if (stored?.status !== 'draft' || stored.number !== null) throw tryAgain()
      const { rows: locked } = await db.listRows<Transactions>({
        databaseId: DATABASE_ID,
        tableId: TABLES.transactions,
        queries: [Query.equal('statementId', statement.$id), Query.limit(1)],
        total: false,
      })
      if (locked.length > 0) throw tryAgain()
    })
    return {}
  })
}
