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
import { markMerged } from '../merge'
import { parseBody } from '../parse-body'
import {
  conflictAsTryAgain,
  findIdentity,
  findPersonOfUser,
  isAppwriteError,
  SET_UP_FIRST,
} from '../rows'
import { finishMerges, MERGE_BUDGET_MS } from '../run-merge'
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
  if (!person) throw new AppError('NOT_FOUND', SET_UP_FIRST)
  const deadline = Date.now() + MERGE_BUDGET_MS
  await claimIdentities(services, person.$id, identities)
  // Every merge into this person that isn't finished: one just marked, or one cut off before.
  // A merge that fails is left for the next claim, so it never stops a login.
  const merges = await finishMerges(services, userId, person.$id, deadline).catch((error) => {
    console.warn(`merge into ${person.$id} stopped: ${errorName(error)}`)
    return { joined: [], finished: 0 }
  })
  // A finished merge moved P's identities here, the claimed one too: it's verified now.
  if (merges.finished > 0) await claimIdentities(services, person.$id, identities)
  const linked = new Set(merges.joined)
  for (const member of await rowsToJoin(services.db, person)) {
    if (await joinGroup(services, userId, person.$id, member)) linked.add(member.groupId)
  }
  return [...linked]
}

// Step 2, for each verified identity.
async function claimIdentities(
  services: Services,
  personId: string,
  identities: VerifiedIdentity[],
): Promise<void> {
  const verified = identities.map((identity) => identity.key)
  for (const identity of identities) {
    try {
      await claimIdentity(services, personId, identity, verified)
    } catch (error) {
      if (!isAppwriteError(error, 409)) throw error
      // Another claim created the same key first (`key` is unique), so look again.
      await conflictAsTryAgain(() => claimIdentity(services, personId, identity, verified))
    }
  }
}

// Step 2, for one verified identity.
async function claimIdentity(
  { db, now }: Services,
  personId: string,
  { type, key }: VerifiedIdentity,
  verified: readonly string[],
): Promise<void> {
  const identity = await findIdentity(db, key)
  if (!identity) {
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'create',
        tableId: TABLES.identities,
        rowId: ID.unique(),
        data: { key, type, personId, verified: true, verifiedAt: now.toISOString() },
        permissions: [],
      }),
    )
    return
  }
  if (identity.personId === personId) {
    if (identity.verified && identity.verifiedAt) return
    await withTransaction(db, (tx) =>
      tx.write({
        action: 'update',
        tableId: TABLES.identities,
        rowId: identity.$id,
        data: { verified: true, verifiedAt: identity.verifiedAt ?? now.toISOString() },
      }),
    )
    return
  }
  // Someone else's: a registered person keeps it. A placeholder is the same human as the
  // caller, so it's merged into the caller's person: step 1 marks it here, and the claim
  // carries the merge on (`finishMerges`). markMerged leaves alone a person with an account,
  // or one another adoption or merge got first. Only the keys the user verified move to them.
  await markMerged(db, identity.personId, personId, verified)
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

/** An error's code or class name, never its message, which may quote stored data. */
function errorName(error: unknown): string {
  if (error instanceof AppError) return error.code
  if (isAppwriteError(error, 409)) return 'conflict'
  return error instanceof Error ? error.name : 'unknown'
}
