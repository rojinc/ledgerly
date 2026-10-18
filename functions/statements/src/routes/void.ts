import type { Statements } from '@ledgerly/core/generated/rows'
import { voidStatementBodySchema } from '@ledgerly/core/schemas/statements'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  getStatement,
  groupGuard,
  invalid,
  latestFinal,
  parseBody,
  updateStatement,
} from '../shared'
import { unlock } from './finalize'

/**
 * `statements POST /statements/{id}/void` (admin): only the group's latest final statement, so
 * openings never break (statements.md#4-void). It becomes `void`, then its transactions are
 * unlocked; the snapshot and PDF stay. The reason goes in the activity row.
 */
export async function voidRoute(
  { db, now }: Services,
  userId: string,
  statementId: string,
  body: unknown,
): Promise<Statements> {
  const { reason } = parseBody(voidStatementBodySchema, body)
  const statement = await getStatement(db, statementId)
  const { person, group } = await requireMember(db, userId, statement.groupId, {
    roles: ['admin'],
  })
  // A retry, or a void interrupted while unlocking: finish taking the locks off.
  if (statement.status === 'void') {
    await unlock(db, statementId)
    return statement
  }
  if (statement.status !== 'final') throw invalid('Only a final statement can be voided.')
  return conflictAsTryAgain(async () => {
    // The group row is staged too, so a finalize that starts meanwhile (its step 1 writes the
    // group row) fails one of the two commits. Then, from the stored rows: still the latest
    // final, and no later statement half-way through finalizing on top of it.
    await updateStatement(
      db,
      statement,
      { status: 'void' },
      [
        groupGuard(group),
        activityWrite(
          statement.groupId,
          person.$id,
          'statement.voided',
          `${statement.displayNumber ?? 'Statement'} voided`,
          now,
          { before: { status: 'final' }, after: { status: 'void', reason } },
        ),
      ],
      async () => {
        if ((await latestFinal(db, group.$id))?.$id !== statementId) {
          throw invalid('Only the latest final statement can be voided.')
        }
        if (await isFinalizing(db, group.$id)) {
          throw new AppError(
            'CONFLICT',
            'A statement of this group is being finalized. Try again soon.',
          )
        }
      },
    )
    // Void first, so nothing finalizes against this statement's opening while the locks come
    // off; unlocking is idempotent, so an interrupted void is finished by calling it again.
    await unlock(db, statementId)
    return getStatement(db, statementId)
  })
}

async function isFinalizing(db: Services['db'], groupId: string): Promise<boolean> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [Query.equal('groupId', groupId), Query.equal('status', 'finalizing'), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}
