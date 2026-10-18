import { nextSummaryAt } from '@ledgerly/core/dates/summary-period'
import type { Profiles } from '@ledgerly/core/generated/rows'
import { updateProfileBodySchema } from '@ledgerly/core/schemas/identity'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { parseBody } from '../parse-body'
import { conflictAsTryAgain, getRowOrNull, SET_UP_FIRST } from '../rows'
import type { Services } from '../services'

/** `identity PATCH /profile`: changes only the fields given, and returns the profile row. */
export async function updateProfile(
  { db, now }: Services,
  userId: string,
  body: unknown,
): Promise<Profiles> {
  const { displayName, business, ...columns } = parseBody(updateProfileBodySchema, body)
  const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
  if (!profile) throw new AppError('NOT_FOUND', SET_UP_FIRST)
  const data: Record<string, unknown> = { ...columns }
  if (business !== undefined) data.businessJson = JSON.stringify(business)
  // scheduling.md#step-4-summary-emails: a different frequency or timezone restarts the
  // summary schedule; `none` clears it.
  const frequency = columns.summaryFrequency ?? profile.summaryFrequency
  const timeZone = columns.timezone ?? profile.timezone
  if (frequency !== profile.summaryFrequency || timeZone !== profile.timezone) {
    data.nextSummaryAt = nextSummaryAt(frequency, timeZone, now)
  }
  const writes: Write[] = []
  if (Object.keys(data).length > 0) {
    writes.push({ action: 'update', tableId: TABLES.profiles, rowId: userId, data })
  }
  // Profiles have no name: a registered person's own name is persons.displayName.
  if (displayName !== undefined) {
    writes.push({
      action: 'update',
      tableId: TABLES.persons,
      rowId: profile.personId,
      data: { displayName },
    })
  }
  if (writes.length > 0) {
    await conflictAsTryAgain(() => withTransaction(db, (tx) => tx.write(...writes)))
  }
  return db.getRow<Profiles>({ databaseId: DATABASE_ID, tableId: TABLES.profiles, rowId: userId })
}
