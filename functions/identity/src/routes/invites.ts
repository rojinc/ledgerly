import { createHash, randomBytes } from 'node:crypto'
import type { Invites, Members, Persons } from '@ledgerly/core/generated/rows'
import { identityKey, normalizeEmail } from '@ledgerly/core/identity/normalize'
import { createInviteBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { inviteEmail } from '@ledgerly/server/email/templates'
import { AppError } from '@ledgerly/server/http/app-error'
import { atMissLimit, countCheck, takeBack } from '@ledgerly/server/identity/address-misses'
import { randomId } from '@ledgerly/server/identity/random-id'
import { mergedTarget } from '@ledgerly/server/identity/resolve-person'
import { ID, type Models, Query } from 'node-appwrite'
import { parseBody } from '../parse-body'
import { conflictAsTryAgain, findIdentity, getRowOrNull, isAppwriteError } from '../rows'
import type { Services } from '../services'

const DAY_MS = 86_400_000
const EXPIRES_AFTER_MS = 14 * DAY_MS
// security-and-privacy.md#threats-and-controls: rolling windows, counted on
// idx_invitedBy_sentAt and idx_identity_sentAt.
const PER_INVITER = { column: 'invitedBy', max: 20, windowMs: DAY_MS } as const
const PER_IDENTITY = { column: 'identityKey', max: 3, windowMs: 7 * DAY_MS } as const

// One message for an address nobody has and for someone else's, so the answer never shows
// which addresses exist (identity-and-invites.md#adding-someone-to-a-group, accepted risks).
const NOT_THEIR_EMAIL = "This email address isn't one this person was added with."
const TOO_MANY = 'Too many invites have been sent. Try again later.'
const NOT_IN_GROUP = 'This member is not in the group.'
const JOINED = 'Only someone who has not joined the group yet can be invited.'

type InviteRow = Omit<Invites, keyof Models.Row>

/**
 * `identity POST /invites` (identity-and-invites.md#invites): emails a link to a `placeholder`
 * member, only at the address the caller typed, which must already be one of that member's
 * identities. The writes, the email and the response are the same whether or not the person has
 * an account. SMS comes with #40.
 */
export async function createInvite(
  services: Services,
  userId: string,
  body: unknown,
): Promise<Pick<Invites, 'sentAt' | 'expiresAt'>> {
  const { groupId, memberId, email } = parseBody(createInviteBodySchema, body)
  if (email === undefined) throw invalid('Invites by text message are not available yet.')
  const { db, now } = services

  // Step 1: the rule for adding members (groups add-member.ts, permissions.md#roles): an admin,
  // or in a house a member too. Then a verified email (F-02).
  const { person, member, group } = await requireMember(db, services.teams, userId, groupId, {
    roles: ['admin', 'member'],
  })
  if (member.role !== 'admin' && group.type !== 'house') {
    throw new AppError('FORBIDDEN', "Your role in this group can't do this.")
  }
  if (!(await services.users.get({ userId })).emailVerification) {
    throw new AppError('FORBIDDEN', 'Verify your email address before you send invites.')
  }

  // Step 2. The body schema checks the email with the same rules as normalizeEmail, so neither
  // of these throws.
  const target = await getRowOrNull<Members>(db, TABLES.members, memberId)
  if (target?.groupId !== groupId) {
    throw new AppError('NOT_FOUND', NOT_IN_GROUP)
  }
  if (target.status !== 'placeholder') throw invalid(JOINED)

  // Step 4: a random token, stored only as its hash. The email (step 5) is built before anything
  // is committed, the address check's count included, so a missing APP_URL (the template refuses
  // a link that isn't http(s)) writes nothing.
  const token = randomBytes(32).toString('base64url')
  const inviteId = ID.unique()
  const sentAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + EXPIRES_AFTER_MS).toISOString()
  const content = inviteEmail({
    inviterName: member.displayName,
    groupName: group.name,
    // The token goes in the fragment, which browsers never send to a server.
    url: `${services.appUrl.replace(/\/+$/, '')}/invite#${token}`,
  })

  // Step 2's address check, counted first, per sender, with reminders' (#274): at the limit,
  // RATE_LIMITED with nothing written, right or wrong. Otherwise the count commits before the
  // address is looked at, so a conflict there (CONFLICT) tells the sender nothing, and a right
  // address takes it back when its invite commits (step 3).
  if (atMissLimit(person, now)) throw tooMany()
  const window = await countCheck(db, person.$id, now, tooMany)
  const address = normalizeEmail(email)
  const key = identityKey('email', address)
  if ((await findIdentity(db, key))?.personId !== target.personId) throw invalid(NOT_THEIR_EMAIL)

  const row: InviteRow = {
    groupId,
    memberId,
    identityKey: key,
    // SHA-256 hex of the token as sent; accept hashes the token it is given the same way.
    tokenHash: createHash('sha256').update(token).digest('hex'),
    channel: 'email',
    invitedBy: person.$id,
    sentAt,
    expiresAt,
    acceptedAt: null,
  }
  const commit = () => commitWithinLimits(db, inviteId, row, target.personId, now, window)
  try {
    await commit()
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
    // Another invite by this inviter, or to this person, a count of the inviter's, or a deletion
    // of one it guarded, committed after this one's guard was staged: check again, once, so it
    // is refused if that invite took the last place or that deletion has started, and takes its
    // count back from the count as it is now. The member row first, as step 2 reads it, so a
    // target removed meanwhile gets step 2's answer before any guard is staged.
    await requireTarget(db, row, target.personId)
    await conflictAsTryAgain(commit)
  }

  // Step 5, after the commit, so a failed send (INTERNAL) still counts toward the limits.
  await services.sendEmail({ to: address, ...content, idempotencyKey: `invite/${inviteId}` })
  return { sentAt, expiresAt }
}

/**
 * Step 3: commits the invite row, and takes back the count the inviter's address check took in
 * `window` (#274), unless the account deletion of the inviter, the target, or the person the
 * target ends at after merges has started, or a limit is reached, with nothing committed
 * otherwise. A guard write (a fresh `rev`) on each of their persons rows is staged before reading
 * them and counting (conventions.md#functions), so an invite by the same inviter, or to the same
 * person, a count of the inviter's, or a deletion of any of them, that commits after that fails
 * this commit: a burst can't pass the count together, and the retry sees the deletion.
 */
async function commitWithinLimits(
  db: Db,
  inviteId: string,
  row: InviteRow,
  targetPersonId: string,
  now: Date,
  window: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.write(guard(row.invitedBy), guard(targetPersonId))
    // A placeholder mid-merge holds only keys the person it ends at verified, until the merge
    // moves them, last, so the address is that person's. Read after the target's guard: a merge
    // that marks it later fails this commit.
    const invited = [targetPersonId]
    const end = await endOf(db, targetPersonId)
    if (end !== targetPersonId && end !== row.invitedBy) {
      await tx.write(guard(end))
      invited.push(end)
    }
    // The stored rows, not this transaction's view: an account deletion may have started.
    const inviter = await getRowOrNull<Persons>(db, TABLES.persons, row.invitedBy)
    if (inviter?.deletedAt !== null) {
      throw new AppError('UNAUTHENTICATED', 'Log in to continue.')
    }
    // The member row as stored, after its person's guard: a removal or a join also writes that
    // person, so one that commits after this read fails this commit, and the retry reads it
    // again (permissions.md#leaving-a-group). No second address-miss limit check: the address
    // check paid its count before it ran (#274).
    await requireTarget(db, row, targetPersonId)
    for (const personId of invited) {
      const person = await getRowOrNull<Persons>(db, TABLES.persons, personId)
      // A target whose person is gone gets step 2's answer: an account deletion keeps the row,
      // and so does scheduler step 5c, so this shows no deletion.
      if (!person && personId === targetPersonId) throw new AppError('NOT_FOUND', NOT_IN_GROUP)
      // As a wrong address, so the answer doesn't show the deletion.
      if (person?.deletedAt !== null) throw invalid(NOT_THEIR_EMAIL)
    }
    if (
      (await reached(db, PER_INVITER, row.invitedBy, now)) ||
      (await reached(db, PER_IDENTITY, row.identityKey, now))
    ) {
      throw tooMany()
    }
    await tx.write(
      {
        action: 'create',
        tableId: TABLES.invites,
        rowId: inviteId,
        data: row,
        permissions: [],
      },
      // Sent to, so the check takes its count back, from the inviter's row as stored after its
      // guard, if it's still the window the count was taken in (step 2).
      ...takeBack(row.invitedBy, inviter, window),
    )
  })
}

function guard(personId: string): Write {
  return { action: 'update', tableId: TABLES.persons, rowId: personId, data: { rev: randomId() } }
}

/** The target's member row as stored, answered as step 2 answers. */
async function requireTarget(db: Db, row: InviteRow, personId: string): Promise<void> {
  const target = await getRowOrNull<Members>(db, TABLES.members, row.memberId)
  if (target?.groupId !== row.groupId || target.personId !== personId) {
    throw new AppError('NOT_FOUND', NOT_IN_GROUP)
  }
  if (target.status !== 'placeholder') throw invalid(JOINED)
}

/**
 * Where the target's merges end (mergedTarget). A target whose person is gone ends at itself, so
 * the reads after it answer for it, as step 2 does; any other row that's gone still fails.
 */
async function endOf(db: Db, personId: string): Promise<string> {
  try {
    return await mergedTarget(db, personId)
  } catch (error) {
    if (isAppwriteError(error, 404) && !(await getRowOrNull(db, TABLES.persons, personId))) {
      return personId
    }
    throw error
  }
}

// Whether `max` invites were already sent within the window: an invite sent exactly
// `windowMs` ago no longer counts. Reads at most `max` rows, which is enough to tell.
async function reached(
  db: Db,
  limit: typeof PER_INVITER | typeof PER_IDENTITY,
  value: string,
  now: Date,
): Promise<boolean> {
  const { rows } = await db.listRows<Invites>({
    databaseId: DATABASE_ID,
    tableId: TABLES.invites,
    queries: [
      Query.equal(limit.column, value),
      Query.greaterThan('sentAt', new Date(now.getTime() - limit.windowMs).toISOString()),
      Query.limit(limit.max),
    ],
    total: false,
  })
  return rows.length >= limit.max
}

function invalid(message: string): AppError {
  return new AppError('VALIDATION_FAILED', message)
}

function tooMany(): AppError {
  return new AppError('RATE_LIMITED', TOO_MANY)
}
