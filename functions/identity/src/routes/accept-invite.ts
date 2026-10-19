import { createHash } from 'node:crypto'
import type { Invites, Persons } from '@ledgerly/core/generated/rows'
import { acceptInviteBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { mergedTarget } from '@ledgerly/server/identity/resolve-person'
import { Query } from 'node-appwrite'
import { joinGroup } from '../join-group'
import { parseBody } from '../parse-body'
import {
  findIdentity,
  findPersonOfUser,
  getRowOrNull,
  isAppwriteError,
  SET_UP_FIRST,
  tryAgain,
} from '../rows'
import type { Services } from '../services'
import { claim, verifiedIdentities } from './claim'
import { ownMemberRow } from './pending-groups'

// One message for an unknown, expired or used token, so the answer never says which.
const INVALID = "This invite link isn't valid. It may have expired or been used already."

// functions-api.md#identity.
type AcceptInviteResult = { groupId: string } | { needsVerification: 'email' | 'phone' }

/** Thrown inside the transaction when another accept set `acceptedAt` first. */
class AlreadyAccepted extends Error {}

/**
 * `identity POST /invites/accept` (identity-and-invites.md#invites).
 *
 * Order, so an accept cut off anywhere can be run again: Claim, then the join, and `acceptedAt`
 * last. Every step before it is safe to repeat, and until it is set the invite is still open.
 * Once it is set, the invite answers `{ groupId }` only to the person its identity belongs to
 * (`isTheirs`) and INVITE_INVALID to anyone else, writing nothing: so a retry after a lost
 * response, or a second accept running at the same time, gets the same answer as the first,
 * while someone else holding a used link learns nothing. An expired invite refuses everyone.
 */
export async function acceptInvite(
  services: Services,
  userId: string,
  body: unknown,
): Promise<AcceptInviteResult> {
  const { token } = parseBody(acceptInviteBodySchema, body)
  const { db, now } = services

  // Step 1. Any text up to 128 characters is hashed like a real token, so a malformed one is
  // just one that isn't found.
  const invite = await findInvite(db, createHash('sha256').update(token).digest('hex'))
  if (!invite || now.getTime() >= Date.parse(invite.expiresAt)) throw invalid()

  // Step 2: the account's verified email or phone, normalised, is the invite's identityKey.
  const identities = verifiedIdentities(await services.users.get({ userId }))
  const verified = identities.some(({ key }) => key === invite.identityKey)
  const found = await findPersonOfUser(db, userId)
  // A person with deletedAt is never resolved from a userId (identity-and-invites.md#order).
  const person = found?.deletedAt ? undefined : found
  if (invite.acceptedAt) {
    if (verified && person && (await isTheirs(db, invite, person))) {
      return { groupId: invite.groupId }
    }
    throw invalid()
  }
  // Before anything is written.
  if (!verified) return { needsVerification: invite.channel === 'sms' ? 'phone' : 'email' }
  if (!person) throw setUpFirst()

  // Step 3. Claim links the identity to the caller's person: kept, adopted at bootstrap, or a
  // placeholder merged into it. One that stays another registered person's isn't the caller's
  // to accept.
  await claim(services, userId, identities)
  if (!(await isTheirs(db, invite, person))) throw invalid()
  // The caller's own row, not `memberId`, which a merge may have deleted or an admin removed.
  // Only a `placeholder` row is joined: any other has joined already, or left on its own, which
  // is final, and joinGroup puts the user in the team before it looks at the row.
  const member = await ownMemberRow(db, invite.groupId, person.$id)
  if (member?.status === 'placeholder') {
    await joinGroup(services, userId, person.$id, member, setUpFirst)
  }

  // Step 4.
  await setAcceptedAt(db, invite.$id, now)
  return { groupId: invite.groupId }
}

// uniq_tokenHash: at most one.
async function findInvite(db: Db, tokenHash: string): Promise<Invites | undefined> {
  const { rows } = await db.listRows<Invites>({
    databaseId: DATABASE_ID,
    tableId: TABLES.invites,
    queries: [Query.equal('tokenHash', tokenHash), Query.limit(1)],
    total: false,
  })
  return rows[0]
}

/**
 * Whether the invite's identity is the person's: its row is on the person, or on a placeholder
 * merged into it whose identities haven't moved yet. A key belongs to one person at a time, and
 * a registered person's never moves, so this is also who accepted it.
 */
async function isTheirs(db: Db, invite: Invites, person: Persons): Promise<boolean> {
  const identity = await findIdentity(db, invite.identityKey)
  return identity !== undefined && (await mergedTarget(db, identity.personId)) === person.$id
}

/**
 * Step 4, the last write, once: staged, then the stored row checked (transaction.ts), so of two
 * accepts at once only the first to commit sets it. The other, by the same person (`isTheirs`
 * held for it), leaves the stored time as it is and answers the same.
 */
async function setAcceptedAt(db: Db, inviteId: string, now: Date): Promise<void> {
  try {
    await withTransaction(db, async (tx) => {
      await tx.write({
        action: 'update',
        tableId: TABLES.invites,
        rowId: inviteId,
        data: { acceptedAt: now.toISOString() },
      })
      // The stored row, not this transaction's view, which has the new acceptedAt.
      const stored = await getRowOrNull<Invites>(db, TABLES.invites, inviteId)
      if (stored?.acceptedAt) throw new AlreadyAccepted()
    })
  } catch (error) {
    if (!(error instanceof AlreadyAccepted || isAppwriteError(error, 409))) throw error
    // Set by another accept between this one's staging and commit, or before it: done. Any
    // other conflict leaves it unset, so the app tries again.
    const stored = await getRowOrNull<Invites>(db, TABLES.invites, inviteId)
    if (!stored?.acceptedAt) throw tryAgain()
  }
}

function invalid(): AppError {
  return new AppError('INVITE_INVALID', INVALID)
}

// As claim answers a deleted person's account, and joinGroup once a deletion passes its lookup.
function setUpFirst(): AppError {
  return new AppError('NOT_FOUND', SET_UP_FIRST)
}
