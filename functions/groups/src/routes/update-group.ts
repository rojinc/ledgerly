import { type LocalDate, parseLocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups } from '@ledgerly/core/generated/rows'
import type { GroupSettings } from '@ledgerly/core/schemas/groups'
import { updateGroupBodySchema } from '@ledgerly/core/schemas/groups'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  checkRegion,
  conflictAsTryAgain,
  findFirst,
  invalid,
  nextCloseAtFor,
  parseBody,
  teamRead,
} from '../shared'

/** `groups PATCH /groups/{id}` (admin): changes only the fields given, and returns the group. */
export async function updateGroup(
  { db, now }: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<Groups> {
  const { settings, ...columns } = parseBody(updateGroupBodySchema, body)
  const { person, member, group } = await requireMember(db, userId, groupId, { roles: ['admin'] })
  const storedSettings = JSON.parse(group.settingsJson) as GroupSettings
  if (settings && settings.type !== storedSettings.type) {
    throw invalid('The settings must match the group type.')
  }

  // The fields that actually change, before and after.
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(columns) as Array<[keyof typeof columns, unknown]>) {
    if (value !== undefined && value !== group[key]) {
      before[key] = group[key]
      after[key] = value
    }
  }
  if (settings && JSON.stringify(settings) !== group.settingsJson) {
    before.settings = storedSettings
    after.settings = settings
  }
  if (Object.keys(after).length === 0) return group

  const cycle = columns.statementCycle ?? group.statementCycle
  const anchor = columns.cycleAnchor ?? storedAnchor(group)
  // periodFor() counts weekly and fortnightly periods from the anchor.
  if ((cycle === 'weekly' || cycle === 'fortnightly') && anchor === null) {
    throw invalid(`A ${cycle} cycle needs cycleAnchor.`)
  }
  if ('region' in after) checkRegion(columns.region as string)
  if ('currency' in after) {
    const transaction = await findFirst(db, TABLES.transactions, [Query.equal('groupId', groupId)])
    if (transaction) {
      throw invalid("The currency can't change after the group's first transaction.")
    }
  }

  const data: Record<string, unknown> = { ...after }
  if ('settings' in after) {
    delete data.settings
    data.settingsJson = JSON.stringify(settings)
  }
  // data-model.md#groups: a new cycle, anchor or time zone moves the next statement.
  if ('statementCycle' in after || 'cycleAnchor' in after || 'timezone' in after) {
    data.nextCloseAt = nextCloseAtFor(cycle, anchor, columns.timezone ?? group.timezone, now)
  }
  const changed = Object.keys(after)
  await conflictAsTryAgain(() =>
    withTransaction(db, (tx) =>
      tx.write(
        {
          action: 'update',
          tableId: TABLES.groups,
          rowId: groupId,
          data,
          permissions: teamRead(groupId),
        },
        activityWrite(
          groupId,
          person.$id,
          'group.updated',
          `${member.displayName} changed the group's ${changed.join(', ')}`,
          now,
          { before, after },
        ),
      ),
    ),
  )
  return db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId })
}

function storedAnchor(group: Groups): LocalDate | null {
  return group.cycleAnchor === null ? null : parseLocalDate(group.cycleAnchor)
}
