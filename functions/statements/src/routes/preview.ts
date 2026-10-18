import { localToday } from '@ledgerly/core/dates/time-zone'
import type { StatementSnapshot } from '@ledgerly/core/schemas/statements'
import { previewStatementBodySchema } from '@ledgerly/core/schemas/statements'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { periodEndingOn } from '../period'
import type { Services } from '../services'
import { parseBody } from '../shared'
import { computeSnapshot } from '../snapshot'

/**
 * `statements POST /statements/preview` (any member): the snapshot a statement ending on
 * `periodEnd` (default: today in the group's time zone) would have now. Nothing is saved.
 */
export async function previewStatement(
  { db, now }: Services,
  userId: string,
  body: unknown,
): Promise<{ snapshot: StatementSnapshot }> {
  const { groupId, periodEnd } = parseBody(previewStatementBodySchema, body)
  const { group } = await requireMember(db, userId, groupId, { allowArchived: true })
  const end = periodEnd ?? localToday(group.timezone, now)
  const { snapshot } = await computeSnapshot(db, group, periodEndingOn(group, end), now)
  return { snapshot }
}
