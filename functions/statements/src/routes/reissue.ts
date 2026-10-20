import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { reissueStatementBodySchema } from '@ledgerly/core/schemas/statements'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { ID, Query } from 'node-appwrite'
import { closingPeriodOf } from '../period'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  draftWrite,
  getRowOrNull,
  groupGuard,
  invalid,
  isFinalizing,
  latestFinal,
  parseBody,
  tryAgain,
} from '../shared'
import { computeSnapshot } from '../snapshot'

/**
 * `statements POST /statements/reissue` (admin): a new draft for the range, to redo a period
 * after a void (statements.md#4-void). `nextCloseAt` stays. Asking again while that draft is
 * still unfinished returns it, so a retry makes no second draft.
 */
export async function reissueStatement(
  { db, teams, now }: Services,
  userId: string,
  body: unknown,
): Promise<Statements> {
  const { groupId, periodStart, periodEnd } = parseBody(reissueStatementBodySchema, body)
  const { person, group } = await requireMember(db, teams, userId, groupId, { roles: ['admin'] })
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
      // Another request made this draft meanwhile: the retry gets it back.
      if (await unfinishedFor(db, groupId, periodStart, periodEnd)) throw tryAgain()
      await requireFinalizable(db, groupId, periodEnd)
      await tx.write(
        draftWrite(group, statementId, period, snapshot),
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

/**
 * Refuses a range whose draft could never be finalized, and so would block every later
 * statement (statements.md#4-void). Reads the stored rows, after the group row is staged.
 */
async function requireFinalizable(db: Db, groupId: string, periodEnd: string): Promise<void> {
  // The finalizing one's partial locks would break this draft's check, and this draft, being
  // earlier, would stop that one from finishing. Read before the latest final: finalize's last
  // step doesn't write the group row, so a statement turning final between the two reads is
  // seen by one of them.
  if (await isFinalizing(db, groupId)) {
    throw new AppError('CONFLICT', 'A statement of this group is being finalized. Try again soon.')
  }
  // Its opening would come from before that statement, and its check would count its locks.
  const latest = await latestFinal(db, groupId)
  if (latest && latest.periodEnd >= periodEnd) {
    throw invalid('This period is already final. Void the latest statement first to redo it.')
  }
  // The opening of a draft skips a final statement that ends on the same day, but its check
  // counts that statement's locks.
  if (await endsOn(db, groupId, periodEnd)) {
    throw invalid('Another statement of this group already ends on this day.')
  }
  // The job would draft that period again when it ends, on top of this one.
  const group = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
  if (group?.nextCloseAt) {
    const next = await closingPeriodOf(db, { ...group, nextCloseAt: group.nextCloseAt })
    if (periodEnd >= next.start) {
      throw invalid('This period hasn’t been drafted yet. It is drafted once it ends.')
    }
  }
}

/** Whether a statement of the group that isn't void ends on `periodEnd` (`idx_group_period`). */
async function endsOn(db: Db, groupId: string, periodEnd: string): Promise<boolean> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('periodEnd', periodEnd),
      Query.notEqual('status', 'void'),
      Query.limit(1),
    ],
    total: false,
  })
  return rows.length > 0
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
