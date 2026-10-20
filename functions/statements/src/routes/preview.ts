import { compareDates, type LocalDate } from '@ledgerly/core/dates/local-date'
import { localToday } from '@ledgerly/core/dates/time-zone'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { previewStatementBodySchema } from '@ledgerly/core/schemas/statements'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { closeStart, periodEndingOn } from '../period'
import type { Services } from '../services'
import { parseBody } from '../shared'
import { computeSnapshot } from '../snapshot'

/**
 * `statements POST /statements/preview` (any member): the snapshot a statement ending on
 * `periodEnd` (default: today in the group's time zone) would have now. Nothing is saved. It
 * starts where a close would (statements.md#6-close-a-period-now-post-statementsclose), so "the
 * current period so far" matches what an admin would draft; on a day a statement already covers,
 * where the cycle period does.
 */
export async function previewStatement(
  { db, teams, now }: Services,
  userId: string,
  body: unknown,
): Promise<{ snapshot: StatementSnapshot }> {
  const { groupId, periodEnd } = parseBody(previewStatementBodySchema, body)
  const { group } = await requireMember(db, teams, userId, groupId, { allowArchived: true })
  const end = (periodEnd as LocalDate | undefined) ?? localToday(group.timezone, now)
  const start = await closeStart(db, group, end)
  const period = compareDates(start, end) <= 0 ? { start, end } : periodEndingOn(group, end)
  const { snapshot } = await computeSnapshot(db, group, period, now)
  return { snapshot }
}
