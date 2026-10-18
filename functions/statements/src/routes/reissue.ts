import type { Statements } from '@ledgerly/core/generated/rows'
import { reissueStatementBodySchema } from '@ledgerly/core/schemas/statements'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { ID, Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  groupGuard,
  invalid,
  latestFinal,
  parseBody,
  teamRead,
  tryAgain,
} from '../shared'
import { computeSnapshot, statementTypeOf } from '../snapshot'

/**
 * `statements POST /statements/reissue` (admin): a new draft for the range, to redo a period
 * after a void (statements.md#4-void). `nextCloseAt` stays. Asking again while that draft is
 * still unfinished returns it, so a retry makes no second draft.
 */
export async function reissueStatement(
  { db, now }: Services,
  userId: string,
  body: unknown,
): Promise<Statements> {
  const { groupId, periodStart, periodEnd } = parseBody(reissueStatementBodySchema, body)
  const { person, group } = await requireMember(db, userId, groupId, { roles: ['admin'] })
  if (statementTypeOf(group) === 'divide') throw invalid('House divides are not available yet.')
  const existing = await unfinishedFor(db, groupId, periodStart, periodEnd)
  if (existing) return existing
  const period = { start: periodStart, end: periodEnd }
  const { snapshot } = await computeSnapshot(db, group, period, now)
  const statementId = ID.unique()
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      // The group row is staged first, so a reissue, void or finalize in the group at the same
      // moment fails one of the commits. Then, from the stored rows:
      await tx.write(groupGuard(group))
      // A draft that ends on or before the latest final one could never be finalized: its
      // opening would come from before that statement, and it would block every later one.
      const latest = await latestFinal(db, groupId)
      if (latest && latest.periodEnd >= periodEnd) {
        throw invalid('This period is already final. Void the latest statement first to redo it.')
      }
      // Another request made this draft meanwhile: the retry gets it back.
      if (await unfinishedFor(db, groupId, periodStart, periodEnd)) throw tryAgain()
      await tx.write(
        {
          action: 'create',
          tableId: TABLES.statements,
          rowId: statementId,
          data: {
            groupId,
            type: 'invoice',
            periodStart,
            periodEnd,
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
          permissions: teamRead(groupId),
        },
        activityWrite(
          groupId,
          person.$id,
          'statement.reissued',
          `Statement for ${periodStart} to ${periodEnd} drafted again`,
          now,
        ),
      )
    }),
  )
  return db.getRow<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    rowId: statementId,
  })
}

/** The group's draft or finalizing statement for exactly this range, if there is one. */
async function unfinishedFor(
  db: Db,
  groupId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Statements | undefined> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('periodStart', periodStart),
      Query.equal('periodEnd', periodEnd),
      Query.equal('status', ['draft', 'finalizing']),
      Query.limit(1),
    ],
    total: false,
  })
  return rows[0]
}
