import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Statements } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMemberOf } from '@ledgerly/server/auth/require-member'
import type { Services } from '../services'
import {
  conflictAsTryAgain,
  getRowOrNull,
  getStatement,
  invalid,
  NO_SUCH_STATEMENT,
  parseBody,
} from '../shared'
import { computeSnapshot } from '../snapshot'

const DRAFTS_ONLY = 'Only a draft statement can be refreshed.'

/**
 * `statements POST /statements/{id}/refresh` (any member, drafts only): recalculates the
 * snapshot from the transactions as they are now (statements.md#1-draft).
 */
export async function refreshStatement(
  { db, teams, now }: Services,
  userId: string,
  statementId: string,
  body: unknown,
): Promise<Statements> {
  parseBody(emptyBodySchema, body ?? {})
  const statement = await getStatement(db, statementId)
  const { group } = await requireMemberOf(db, teams, userId, statement.groupId, NO_SUCH_STATEMENT)
  if (statement.status !== 'draft') throw invalid(DRAFTS_ONLY)
  const period = {
    start: statement.periodStart as LocalDate,
    end: statement.periodEnd as LocalDate,
  }
  const { snapshot } = await computeSnapshot(db, group, period, now)
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.statements,
        rowId: statementId,
        data: { snapshotJson: JSON.stringify(snapshot) },
      })
      // Stage, then check (conventions.md): a finalize that started meanwhile keeps its own
      // snapshot. Read the stored row, not this transaction's view.
      const current = await getRowOrNull<Statements>(db, TABLES.statements, statementId)
      if (current?.status !== 'draft') throw invalid(DRAFTS_ONLY)
    }),
  )
  return db.getRow<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    rowId: statementId,
  })
}
