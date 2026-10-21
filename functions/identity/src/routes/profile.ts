import { nextSummaryAt } from '@ledgerly/core/dates/summary-period'
import type { Persons, Profiles } from '@ledgerly/core/generated/rows'
import { updateProfileBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { parseBody } from '../parse-body'
import { conflictAsTryAgain, getRowOrNull, guardPerson, SET_UP_FIRST, tryAgain } from '../rows'
import type { Services } from '../services'

const setUpFirst = () => new AppError('NOT_FOUND', SET_UP_FIRST)

/** `identity PATCH /profile`: changes only the fields given, and returns the profile row. */
export async function updateProfile(
  { db, now }: Services,
  userId: string,
  body: unknown,
): Promise<Profiles> {
  const { displayName, business, hoursCap, ...columns } = parseBody(updateProfileBodySchema, body)
  const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
  const person = profile && (await getRowOrNull<Persons>(db, TABLES.persons, profile.personId))
  // A person being deleted is no person (identity-and-invites.md#order): the profile outlives
  // step 2, and is gone from step 5, so the answer is the same the whole way through.
  if (!profile || !person || person.deletedAt) throw setUpFirst()
  const data: Record<string, unknown> = { ...columns }
  if (business !== undefined) data.businessJson = JSON.stringify(business)
  // F-82 (#53): the three columns are set together, or all emptied by `null`. The stored limit
  // sent again writes nothing.
  if (hoursCap !== undefined) {
    const cap = {
      hoursCapMinutes: hoursCap?.minutes ?? null,
      hoursCapPeriod: hoursCap?.period ?? null,
      hoursCapStartsOn: hoursCap?.startsOn ?? null,
    }
    const stored: Record<string, unknown> = profile
    if (Object.entries(cap).some(([column, value]) => (stored[column] ?? null) !== value)) {
      Object.assign(data, cap)
    }
  }
  // scheduling.md#step-4-summary-emails: a different frequency or timezone restarts the
  // summary schedule; `none` clears it.
  const frequency = columns.summaryFrequency ?? profile.summaryFrequency
  const timeZone = columns.timezone ?? profile.timezone
  if (frequency !== profile.summaryFrequency || timeZone !== profile.timezone) {
    data.nextSummaryAt = nextSummaryAt(frequency, timeZone, now)
  }
  const writes: Write[] = []
  const changesProfile = Object.keys(data).length > 0
  if (changesProfile) {
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
    await conflictAsTryAgain(() =>
      withTransaction(db, async (tx) => {
        await tx.write(...writes)
        // A deleted person's row keeps "Former member" for good (identity-and-invites.md#order),
        // so a name is never written after step 2: one that passed it since the read above is
        // refused here, and one that passes it later fails this commit.
        if (displayName !== undefined) await guardPerson(tx, db, profile.personId, setUpFirst)
        if (!changesProfile) return
        // Stage, then check (transaction.ts): nextSummaryAt above follows the frequency and
        // timezone read before staging, which another PATCH may have changed since. Read the
        // stored row, not this transaction's view, which already shows the new values.
        const stored = await profileRow(db, userId)
        if (
          stored.summaryFrequency !== profile.summaryFrequency ||
          stored.timezone !== profile.timezone
        ) {
          throw tryAgain()
        }
      }),
    )
  }
  return profileRow(db, userId)
}

function profileRow(db: Db, userId: string): Promise<Profiles> {
  return db.getRow<Profiles>({ databaseId: DATABASE_ID, tableId: TABLES.profiles, rowId: userId })
}
