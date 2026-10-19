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
  getRowOrNull,
  invalid,
  nextCloseAtFor,
  parseBody,
  teamRead,
  tryAgain,
} from '../shared'

/** `groups PATCH /groups/{id}` (admin): changes only the fields given, and returns the group. */
export async function updateGroup(
  { db, teams, now }: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<Groups> {
  const { settings, ...columns } = parseBody(updateGroupBodySchema, body)
  const { person, group } = await requireMember(db, teams, userId, groupId, {
    roles: ['admin'],
  })
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
    // The activity row keeps no email addresses (security-and-privacy.md), only how many.
    before.settings = withoutAddresses(storedSettings)
    after.settings = withoutAddresses(settings)
  }
  if (Object.keys(after).length === 0) return group

  const cycle = columns.statementCycle ?? group.statementCycle
  const anchor = columns.cycleAnchor ?? storedAnchor(group)
  // periodFor() counts weekly and fortnightly periods from the anchor.
  if ((cycle === 'weekly' || cycle === 'fortnightly') && anchor === null) {
    throw invalid(`A ${cycle} cycle needs cycleAnchor.`)
  }
  if ('region' in after) checkRegion(columns.region as string)

  const data: Record<string, unknown> = { ...after }
  if ('settings' in after) {
    delete data.settings
    data.settingsJson = JSON.stringify(settings)
  }
  // data-model.md#groups: a new cycle, anchor or time zone moves the next statement. One that
  // is already due stays, so the statements cron still drafts the period that just ended and
  // then moves it on; without a cycle there is none.
  if ('statementCycle' in after || 'cycleAnchor' in after || 'timezone' in after) {
    const stored = group.nextCloseAt
    // Compared as instants: Appwrite may return the stored datetime with an offset, not Z.
    const due = cycle !== 'none' && stored !== null && Date.parse(stored) <= now.getTime()
    data.nextCloseAt = due
      ? stored
      : nextCloseAtFor(cycle, anchor, columns.timezone ?? group.timezone, now)
  }
  const changed = Object.keys(after)
  await conflictAsTryAgain(() =>
    withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.groups,
        rowId: groupId,
        data,
        permissions: teamRead(groupId),
      })
      // Stage, then check (conventions.md): a change to the group since requireMember read it
      // would make `before` and nextCloseAt stale, and a first transaction committed before the
      // group row was staged is seen here. Either refusal rolls the change back.
      const current = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
      if (current?.$updatedAt !== group.$updatedAt) throw tryAgain()
      if ('currency' in after) {
        const first = await findFirst(db, TABLES.transactions, [Query.equal('groupId', groupId)])
        if (first) throw invalid("The currency can't change after the group's first transaction.")
      }
      await tx.write(
        activityWrite(
          groupId,
          person.$id,
          'group.updated',
          `Changed the group's ${changed.join(', ')}`,
          now,
          { changes: { before: withoutName(before), after: withoutName(after) } },
        ),
      )
    }),
  )
  return db.getRow<Groups>({ databaseId: DATABASE_ID, tableId: TABLES.groups, rowId: groupId })
}

function storedAnchor(group: Groups): LocalDate | null {
  return group.cycleAnchor === null ? null : parseLocalDate(group.cycleAnchor)
}

/**
 * The changes for the activity row, which never holds a name (data-model.md#activity): a pair
 * group's name is what its creator calls the other person. The summary still says it changed.
 */
function withoutName({ name: _, ...fields }: Record<string, unknown>): object {
  return fields
}

/** Employer settings with `recipients` as a count, for the activity row. */
function withoutAddresses(settings: GroupSettings): object {
  return 'recipients' in settings
    ? { ...settings, recipients: settings.recipients.length }
    : settings
}
