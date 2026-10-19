import type { IdentitiesType, Members, Persons } from '@ledgerly/core/generated/rows'
import { identityKey } from '@ledgerly/core/identity/normalize'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import type { ClaimResult } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { ID, Query } from 'node-appwrite'
import { joinGroup } from '../join-group'
import { parseBody } from '../parse-body'
import {
  conflictAsTryAgain,
  findIdentity,
  findPersonOfUser,
  getRowOrNull,
  guardPerson,
  isAppwriteError,
  SET_UP_FIRST,
} from '../rows'
import type { AccountUser, Services } from '../services'

export type VerifiedIdentity = { type: IdentitiesType; key: string }

const PAGE_SIZE = 100

/** `identity POST /claim` */
export async function postClaim(
  services: Services,
  userId: string,
  body: unknown,
): Promise<ClaimResult> {
  parseBody(emptyBodySchema, body ?? {})
  const user = await services.users.get({ userId })
  return { linkedGroupIds: await claim(services, userId, verifiedIdentities(user)) }
}

/**
 * Claim step 1: the user's verified email and phone as identity keys, email first. Appwrite
 * may accept one that normalize.ts rejects (a quoted email, a number newer than the phone
 * metadata); it is skipped, and the log names only its type, so one odd identity never breaks
 * every login.
 */
export function verifiedIdentities(user: AccountUser): VerifiedIdentity[] {
  const candidates: Array<[IdentitiesType, string, boolean]> = [
    ['email', user.email, user.emailVerification],
    ['phone', user.phone, user.phoneVerification],
  ]
  const identities: VerifiedIdentity[] = []
  for (const [type, value, verified] of candidates) {
    if (!verified || !value) continue
    try {
      identities.push({ type, key: identityKey(type, value) })
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      console.warn(`skipped an unusable verified ${type}`)
    }
  }
  return identities
}

/**
 * identity-and-invites.md#claim-linking-records-to-a-new-account, steps 2–4, for the caller's
 * own person. Reads only stored data, so a repeated or interrupted claim finishes the job.
 * Returns the groups joined by this call.
 */
export async function claim(
  services: Services,
  userId: string,
  identities: VerifiedIdentity[],
): Promise<string[]> {
  const person = await findPersonOfUser(services.db, userId)
  // A person with deletedAt is never resolved from a userId (identity-and-invites.md#order).
  // Each write below checks again (guardPerson).
  if (!person || person.deletedAt) throw setUpFirst()
  for (const identity of identities) {
    try {
      await claimIdentity(services, person.$id, identity)
    } catch (error) {
      if (!isAppwriteError(error, 409)) throw error
      // Another claim created the same key first (`key` is unique), so look again.
      await conflictAsTryAgain(() => claimIdentity(services, person.$id, identity))
    }
  }
  const linked: string[] = []
  for (const member of await rowsToJoin(services.db, person)) {
    if (await joinGroup(services, userId, person.$id, member, setUpFirst)) {
      linked.push(member.groupId)
    }
  }
  return linked
}

function setUpFirst(): AppError {
  return new AppError('NOT_FOUND', SET_UP_FIRST)
}

// Step 2, for one verified identity.
async function claimIdentity(
  { db, now }: Services,
  personId: string,
  { type, key }: VerifiedIdentity,
): Promise<void> {
  const identity = await findIdentity(db, key)
  if (!identity) {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'create',
        tableId: TABLES.identities,
        rowId: ID.unique(),
        data: { key, type, personId, verified: true, verifiedAt: now.toISOString() },
        permissions: [],
      })
      await guardPerson(tx, db, personId, setUpFirst)
    })
    return
  }
  if (identity.personId === personId) {
    if (identity.verified && identity.verifiedAt) return
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.identities,
        rowId: identity.$id,
        data: { verified: true, verifiedAt: identity.verifiedAt ?? now.toISOString() },
      })
      await guardPerson(tx, db, personId, setUpFirst)
    })
    return
  }
  // Someone else's: a registered person keeps it. A placeholder would have to be merged into
  // the caller's person, which is #39; until then it stays where it is. The log is a fixed
  // line, never the key (security-and-privacy.md).
  const owner = await getRowOrNull<Persons>(db, TABLES.persons, identity.personId)
  if (owner && !owner.userId) console.warn('claim needs a merge; skipped')
}

// Step 3: the person's `placeholder` rows added strictly before `claimedAt`, while they had no
// account (D-016). Rows added later are left for the user to join themselves.
async function rowsToJoin(db: Db, person: Persons): Promise<Members[]> {
  const claimedAt = person.claimedAt ? Date.parse(person.claimedAt) : Number.NEGATIVE_INFINITY
  const rows: Members[] = []
  let cursor: string | undefined
  for (;;) {
    const { rows: page } = await db.listRows<Members>({
      databaseId: DATABASE_ID,
      tableId: TABLES.members,
      queries: [
        Query.equal('personId', person.$id),
        Query.equal('status', 'placeholder'),
        Query.orderAsc('$createdAt'),
        Query.limit(PAGE_SIZE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    for (const row of page) {
      // Oldest first, so the first row added after claimedAt ends the list.
      if (!(Date.parse(row.$createdAt) < claimedAt)) return rows
      rows.push(row)
    }
    if (page.length < PAGE_SIZE) return rows
    cursor = page.at(-1)?.$id
  }
}
