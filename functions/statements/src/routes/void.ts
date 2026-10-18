import type { Statements } from '@ledgerly/core/generated/rows'
import { voidStatementBodySchema } from '@ledgerly/core/schemas/statements'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getStatement,
  invalid,
  parseBody,
  updateStatement,
} from '../shared'
import { unlock } from './finalize'

/**
 * `statements POST /statements/{id}/void` (admin): only the group's latest final statement, so
 * openings never break (statements.md#4-void). Its transactions are unlocked and it becomes
 * `void`; the snapshot and PDF stay. The reason goes in the activity row.
 */
export async function voidRoute(
  { db, now }: Services,
  userId: string,
  statementId: string,
  body: unknown,
): Promise<Statements> {
  const { reason } = parseBody(voidStatementBodySchema, body)
  const statement = await getStatement(db, statementId)
  const { person } = await requireMember(db, userId, statement.groupId, { roles: ['admin'] })
  // A retry, or a void interrupted while unlocking: finish taking the locks off.
  if (statement.status === 'void') {
    await unlock(db, statementId)
    return statement
  }
  if (statement.status !== 'final') throw invalid('Only a final statement can be voided.')
  const {
    rows: [latest],
  } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', statement.groupId),
      Query.equal('status', 'final'),
      Query.orderDesc('periodEnd'),
      Query.limit(1),
    ],
    total: false,
  })
  if (latest?.$id !== statementId) throw invalid('Only the latest final statement can be voided.')
  return conflictAsTryAgain(async () => {
    // Void first, so nothing finalizes against this statement's opening while the locks come
    // off; unlocking is idempotent, so an interrupted void is finished by calling it again.
    const voided = await updateStatement(db, statement, { status: 'void' }, [
      activityWrite(
        statement.groupId,
        person.$id,
        'statement.voided',
        `${statement.displayNumber ?? 'Statement'} voided`,
        now,
        { before: { status: 'final' }, after: { status: 'void', reason } },
      ),
    ])
    await unlock(db, statementId)
    return getStatement(db, voided.$id)
  })
}
