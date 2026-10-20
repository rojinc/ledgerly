import { compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Statements } from '@ledgerly/core/generated/rows'
import { closeStatementBodySchema } from '@ledgerly/core/schemas/statements'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { ID, Query } from 'node-appwrite'
import { closeEnd, closeStart, jobPeriodEnd } from '../period'
import type { Services } from '../services'
import {
  activityWrite,
  conflictAsTryAgain,
  draftSummary,
  draftWrite,
  getRowOrNull,
  groupGuard,
  invalid,
  isFinalizing,
  parseBody,
  tryAgain,
} from '../shared'
import { computeSnapshot, statementTypeOf } from '../snapshot'

/**
 * `statements POST /statements/close` (admin): drafts the group's next statement now, up to
 * `periodEnd`, without waiting for the job (statements.md#6-close-a-period-now-post-statementsclose).
 * `nextCloseAt` stays. Asking again while that draft is unfinished returns it.
 */
export async function closeStatement(
  { db, teams, now }: Services,
  userId: string,
  body: unknown,
): Promise<Statements> {
  const { groupId, periodEnd } = parseBody(closeStatementBodySchema, body)
  const { person, group } = await requireMember(db, teams, userId, groupId, { roles: ['admin'] })
  // VALIDATION_FAILED for a pair or a personal group, which have no statements.
  statementTypeOf(group)
  const end = (periodEnd as LocalDate | undefined) ?? closeEnd(group, now)
  const existing = await unfinishedEndingOn(db, groupId, end)
  if (existing) return existing
  const start = await closeStart(db, group, end)
  requireInRange(group, { start, end }, now)
  const period = { start, end }
  const { snapshot } = await computeSnapshot(db, group, period, now)
  const statementId = ID.unique()
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      // The group row is staged first, so a job run, close, reissue, discard or finalize in the
      // group at the same moment fails one of the commits. Then, from the stored rows:
      await tx.write(groupGuard(group))
      // Another request made this draft meanwhile: the retry gets it back.
      if (await unfinishedEndingOn(db, groupId, end)) throw tryAgain()
      const stored = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
      if (!stored || stored.archivedAt) {
        throw new AppError('ARCHIVED', 'This group is archived, so it can no longer be changed.')
      }
      // Periods lock in order (statements.md#core-rules, rule 5).
      if (await isFinalizing(db, groupId)) {
        throw new AppError(
          'CONFLICT',
          'A statement of this group is being finalized. Try again soon.',
        )
      }
      const draft = await oldestDraft(db, groupId)
      if (draft) {
        throw new AppError('CONFLICT', 'Finalize or discard the earlier draft first.', {
          draftId: draft.$id,
        })
      }
      // A statement drafted or discarded meanwhile moved the start.
      if ((await closeStart(db, stored, end)) !== start) throw tryAgain()
      requireInRange(stored, period, now)
      await tx.write(
        draftWrite(stored, statementId, period, snapshot),
        activityWrite(groupId, person.$id, 'statement.drafted', draftSummary(end), now),
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
 * VALIDATION_FAILED for a period that ends after today, before it starts, or after the period
 * the job drafts next, which the job would draft again on top of it.
 */
function requireInRange(group: Groups, period: { start: LocalDate; end: LocalDate }, now: Date) {
  if (compareDates(period.end, localToday(group.timezone, now)) > 0) {
    throw invalid('A period can’t be closed before it has ended. Pick today or an earlier day.')
  }
  if (compareDates(period.end, period.start) < 0) {
    throw invalid(`The next statement starts on ${period.start}. Pick that day or a later one.`)
  }
  const jobEnd = jobPeriodEnd(group)
  if (jobEnd && compareDates(period.end, jobEnd) > 0) {
    throw invalid(
      `This period ends on ${jobEnd}, and its statement is drafted then. Pick ${jobEnd} or an earlier day.`,
    )
  }
}

/** The group's draft or finalizing statement that ends on `end`, if there is one. */
async function unfinishedEndingOn(
  db: Db,
  groupId: string,
  end: LocalDate,
): Promise<Statements | undefined> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('periodEnd', end),
      Query.equal('status', ['draft', 'finalizing']),
      Query.limit(1),
    ],
    total: false,
  })
  return rows[0]
}

/** The group's oldest draft, which has to be finalized or discarded before a later period. */
async function oldestDraft(db: Db, groupId: string): Promise<Statements | undefined> {
  const { rows } = await db.listRows<Statements>({
    databaseId: DATABASE_ID,
    tableId: TABLES.statements,
    queries: [
      Query.equal('groupId', groupId),
      Query.equal('status', 'draft'),
      Query.orderAsc('periodEnd'),
      Query.limit(1),
    ],
    total: false,
  })
  return rows[0]
}
