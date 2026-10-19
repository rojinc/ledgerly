import { createHash, randomBytes } from 'node:crypto'
import type { Invites, Members } from '@ledgerly/core/generated/rows'
import { identityKey, normalizeEmail, normalizePhone } from '@ledgerly/core/identity/normalize'
import { createInviteBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { inviteEmail } from '@ledgerly/server/email/templates'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { inviteSms } from '@ledgerly/server/sms/templates'
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
const NOT_THEIRS = {
  email: "This email address isn't one this person was added with.",
  sms: "This phone number isn't one this person was added with.",
} as const
// Fixed, so it never repeats what was typed.
const NOT_A_PHONE = "This phone number isn't valid."

type InviteRow = Omit<Invites, keyof Models.Row>

/**
 * `identity POST /invites` (identity-and-invites.md#invites): emails or texts a link to a
 * `placeholder` member, only at the address or number the caller typed, which must already be one
 * of that member's identities. The writes, the message and the response are the same whether or
 * not the person has an account.
 */
export async function createInvite(
  services: Services,
  userId: string,
  body: unknown,
): Promise<Pick<Invites, 'sentAt' | 'expiresAt'>> {
  const { groupId, memberId, email, phone } = parseBody(createInviteBodySchema, body)
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

  // Step 2.
  const target = await getRowOrNull<Members>(db, TABLES.members, memberId)
  if (target?.groupId !== groupId) {
    throw new AppError('NOT_FOUND', 'This member is not in the group.')
  }
  if (target.status !== 'placeholder') {
    throw invalid('Only someone who has not joined the group yet can be invited.')
  }
  const { channel, to, key } = recipient(email, phone, group.region)
  if ((await findIdentity(db, key))?.personId !== target.personId) {
    throw invalid(NOT_THEIRS[channel])
  }

  // Step 4: a random token, stored only as its hash. The message (step 5) is built before
  // anything is committed, so a missing APP_URL (the templates refuse a link that isn't http(s))
  // writes nothing.
  const token = randomBytes(32).toString('base64url')
  const inviteId = ID.unique()
  const sentAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + EXPIRES_AFTER_MS).toISOString()
  const message = {
    inviterName: member.displayName,
    groupName: group.name,
    // The token goes in the fragment, which browsers never send to a server.
    url: `${services.appUrl.replace(/\/+$/, '')}/invite#${token}`,
  }
  const idempotencyKey = `invite/${inviteId}`
  let send: () => Promise<unknown>
  if (channel === 'email') {
    const content = inviteEmail(message)
    send = () => services.sendEmail({ to, ...content, idempotencyKey })
  } else {
    const text = inviteSms(message)
    send = () => services.sendSms({ to, text, idempotencyKey })
  }
  const row: InviteRow = {
    groupId,
    memberId,
    identityKey: key,
    // SHA-256 hex of the token as sent; accept hashes the token it is given the same way.
    tokenHash: createHash('sha256').update(token).digest('hex'),
    channel,
    invitedBy: person.$id,
    sentAt,
    expiresAt,
    acceptedAt: null,
  }
  const commit = () => commitWithinLimits(db, inviteId, row, target.personId, now)
  try {
    await commit()
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
    // Another invite by this inviter, or to this person, committed after this one's guard was
    // staged: count again, once, so it is refused if it took the last place.
    await conflictAsTryAgain(commit)
  }

  // Step 5, after the commit, so a failed send (INTERNAL) still counts toward the limits.
  await send()
  return { sentAt, expiresAt }
}

/**
 * Step 2: where the invite goes, normalised, and its identity key. The body schema checks an
 * email with the same rules as normalizeEmail, so only a phone can be refused here. A phone
 * typed without a country code is read as one from the group's region
 * (identity-and-invites.md#normalising-identities).
 */
function recipient(
  email: string | undefined,
  phone: string | undefined,
  region: string,
): { channel: InviteRow['channel']; to: string; key: string } {
  if (email !== undefined) {
    const to = normalizeEmail(email)
    return { channel: 'email', to, key: identityKey('email', to) }
  }
  try {
    // The schema gives exactly one of email or phone.
    const to = normalizePhone(phone ?? '', region)
    return { channel: 'sms', to, key: identityKey('phone', to) }
  } catch (error) {
    if (error instanceof RangeError) throw invalid(NOT_A_PHONE)
    throw error
  }
}

/**
 * Step 3: commits the invite row unless a limit is reached, RATE_LIMITED otherwise, with nothing
 * committed. A guard write (a fresh `rev`) on the inviter's and the target's persons rows is
 * staged before counting (conventions.md#functions), so an invite by the same inviter, or to the
 * same person, that commits after that fails this commit: a burst can't pass the count together.
 */
async function commitWithinLimits(
  db: Db,
  inviteId: string,
  row: InviteRow,
  targetPersonId: string,
  now: Date,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.write(guard(row.invitedBy), guard(targetPersonId))
    if (
      (await reached(db, PER_INVITER, row.invitedBy, now)) ||
      (await reached(db, PER_IDENTITY, row.identityKey, now))
    ) {
      throw new AppError('RATE_LIMITED', 'Too many invites have been sent. Try again later.')
    }
    await tx.write({
      action: 'create',
      tableId: TABLES.invites,
      rowId: inviteId,
      data: row,
      permissions: [],
    })
  })
}

function guard(personId: string): Write {
  return { action: 'update', tableId: TABLES.persons, rowId: personId, data: { rev: randomId() } }
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
