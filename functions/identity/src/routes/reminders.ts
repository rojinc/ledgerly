import { REMINDER_LIMITS } from '@ledgerly/core/constants/limits'
import type { Groups, Identities, Members, Persons, Reminders } from '@ledgerly/core/generated/rows'
import { identityKey, normalizeEmail } from '@ledgerly/core/identity/normalize'
import { type SendReminderResult, sendReminderBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { EmailError } from '@ledgerly/server/email/send-email'
import { reminderEmail } from '@ledgerly/server/email/templates'
import { AppError } from '@ledgerly/server/http/app-error'
import { randomId } from '@ledgerly/server/identity/random-id'
import { readGroupNets } from '@ledgerly/server/ledger/balances'
import { ID, Permission, Query, Role } from 'node-appwrite'
import { parseBody } from '../parse-body'
import { getRowOrNull, isAppwriteError, tryAgain } from '../rows'
import type { Services } from '../services'

// Fixed messages: none repeats the address typed (identity-and-invites.md#reminders).
const WRONG_ADDRESS = "That isn't an address this group has for them. Use one you added them with."
const NOTHING_OWED = 'Nothing is owed to you in this group.'
const TOO_MANY = 'Too many reminders. Try again in a few days.'
const NOT_SENT = 'We couldn’t send the reminder. Try again later.'
const DAY_MS = 24 * 60 * 60 * 1000
// Far more than any real chain: a loop in mergedInto would otherwise never end.
const MAX_MERGES = 20
// A pair has two member rows, and a merge can leave a few more.
const MAX_PAIR_ROWS = 10
// A retry sends again only while Resend still holds the key (24 hours), with an hour to spare.
const KEY_LIVE_MS = 23 * 60 * 60 * 1000

/**
 * `identity POST /reminders` (F-63, identity-and-invites.md#reminders): emails the other member
 * of a pair group a reminder that they owe the caller, at an address the caller typed that the
 * group already holds for them. Rate-limited, and the same whether or not they have an account.
 * The reminder is committed before the email goes out, so parallel requests can't send past
 * the limits; a retry with the same `id` may send again under the same Resend key (step 3).
 */
export async function sendReminder(
  services: Services,
  userId: string,
  body: unknown,
): Promise<SendReminderResult> {
  const { id, groupId, email } = parseBody(sendReminderBodySchema, body)
  const { db, teams, users, now } = services
  const { person, member, group } = await requireMember(db, teams, userId, groupId, {
    roles: ['admin', 'member'],
  })
  // requireMember lets in someone who moved out of a house; a reminder needs a joined member.
  if (member.status !== 'active') {
    throw new AppError('NOT_A_MEMBER', "You're not a member of this group.")
  }
  if (!(await users.get({ userId })).emailVerification) {
    throw new AppError('FORBIDDEN', 'Verify your email address before sending reminders.')
  }
  if (group.type !== 'pair') {
    throw new AppError('VALIDATION_FAILED', 'Reminders are for lend & borrow only.')
  }
  const stored = await getRowOrNull<Reminders>(db, TABLES.reminders, id)
  const owedCents =
    (await readGroupNets(db, group)).find((net) => net.personId === person.$id)?.netCents ?? 0
  const url = appLink(services.appUrl)
  const send = () =>
    deliver(services, { id, email, senderName: member.displayName, owedCents, group, url })

  if (stored) {
    // Step 3: a retry. It sends again only while the Resend key is live and every check still
    // passes for the address typed now; otherwise it just answers.
    checkSender(stored, person.$id, groupId)
    const live = now.getTime() - Date.parse(stored.sentAt) < KEY_LIVE_MS
    if (live && owedCents > 0 && (await stillReachable(db, groupId, person.$id, email))) {
      await send()
    }
    return { sentAt: stored.sentAt }
  }
  if (owedCents <= 0) throw new AppError('VALIDATION_FAILED', NOTHING_OWED)
  const recipient = await recipientOf(db, groupId, person.$id, email)
  const committed = await commitReminder(db, { id, groupId, sender: person.$id, recipient }, now)
  await send()
  return { sentAt: committed.sentAt }
}

/** Step 8: the email, under the reminder's own key. INTERNAL if it may not have gone out. */
async function deliver(
  services: Services,
  input: {
    id: string
    email: string
    senderName: string
    owedCents: number
    group: Groups
    url: string
  },
): Promise<void> {
  try {
    // Resend sends one email per key within 24 hours, so a retry isn't delivered twice.
    await services.sendEmail({
      // As stored: identityKey() matched the address in this form.
      to: normalizeEmail(input.email),
      ...reminderEmail({
        senderName: input.senderName,
        amountCents: input.owedCents,
        currency: input.group.currency,
        url: input.url,
      }),
      idempotencyKey: `person-reminder-${input.id}`,
    })
  } catch (error) {
    // Sent already under this key, with other content: it counts as sent.
    if (error instanceof EmailError && ALREADY_SENT.has(error.type)) return
    // Resend's type and status, never its message, which can quote the address.
    const cause =
      error instanceof EmailError
        ? `EmailError ${error.type} ${error.status ?? ''}`.trim()
        : 'Error'
    console.error(`reminder ${input.id} not sent: ${cause}`)
    throw new AppError('INTERNAL', NOT_SENT)
  }
}

/** Whether step 5 and the recipient's deletedAt check pass again, for a retry. */
async function stillReachable(
  db: Db,
  groupId: string,
  senderId: string,
  email: string,
): Promise<boolean> {
  try {
    const recipient = await recipientOf(db, groupId, senderId, email)
    return !(await getRowOrNull<Persons>(db, TABLES.persons, recipient))?.deletedAt
  } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_FAILED') return false
    throw error
  }
}

/**
 * Steps 6 and 7: guards on both persons, a fresh look at them, the limits, then the reminder
 * and its activity row, committed. A commit lost to a parallel call with this `id`, or a limit
 * reached by that call's row, answers from its row instead.
 */
async function commitReminder(
  db: Db,
  {
    id,
    groupId,
    sender,
    recipient,
  }: { id: string; groupId: string; sender: string; recipient: string },
  now: Date,
): Promise<Reminders> {
  const sentAt = now.toISOString()
  try {
    await withTransaction(db, async (tx) => {
      await tx.write(
        { action: 'update', tableId: TABLES.persons, rowId: sender, data: { rev: randomId() } },
        { action: 'update', tableId: TABLES.persons, rowId: recipient, data: { rev: randomId() } },
      )
      // The stored rows, not this transaction's view: an account deletion may have started.
      if ((await getRowOrNull<Persons>(db, TABLES.persons, sender))?.deletedAt !== null) {
        throw new AppError('UNAUTHENTICATED', 'Log in to continue.')
      }
      const to = await getRowOrNull<Persons>(db, TABLES.persons, recipient)
      if (to?.deletedAt !== null) throw new AppError('VALIDATION_FAILED', WRONG_ADDRESS)
      // A merge's step 1 marked the recipient meanwhile: the retry resolves to who they became,
      // so no reminder or activity row names a person the merge has already moved past.
      if (to.mergedInto) throw tryAgain()
      await checkLimits(db, { sentBy: sender, toPersonId: recipient, groupId }, now)
      await tx.write(
        {
          action: 'create',
          tableId: TABLES.reminders,
          rowId: id,
          data: { groupId, sentBy: sender, toPersonId: recipient, channel: 'email', sentAt },
          // Server only, like identities.
          permissions: [],
        },
        {
          action: 'create',
          tableId: TABLES.activity,
          rowId: ID.unique(),
          data: {
            groupId,
            actorPersonId: sender,
            action: 'reminder.sent',
            // No name, amount or address (data-model.md#activity): the feed shows
            // "<subject> was sent a reminder".
            subjectPersonId: recipient,
            summary: 'was sent a reminder',
            at: sentAt,
          },
          permissions: [Permission.read(Role.team(groupId))],
        },
      )
    })
  } catch (error) {
    const raced =
      isAppwriteError(error, 409) || (error instanceof AppError && error.code === 'RATE_LIMITED')
    if (!raced) throw error
    const stored = await getRowOrNull<Reminders>(db, TABLES.reminders, id)
    if (stored) return checkSender(stored, sender, groupId)
    if (error instanceof AppError) throw error
    throw tryAgain()
  }
  return {
    $id: id,
    groupId,
    sentBy: sender,
    toPersonId: recipient,
    channel: 'email',
    sentAt,
  } as Reminders
}

/** The stored reminder, if this caller sent it in this group; anyone else gets CONFLICT. */
function checkSender(stored: Reminders, sentBy: string, groupId: string): Reminders {
  if (stored.sentBy !== sentBy || stored.groupId !== groupId) {
    throw new AppError('CONFLICT', 'This reminder was already used.')
  }
  return stored
}

/**
 * The person the pair's other member is now (after merges), if `email` is one of their
 * identities as stored. Otherwise the same VALIDATION_FAILED for every reason, so it shows
 * nothing more: a wrong address, or no other member. A deleted person is caught after the guards.
 */
async function recipientOf(
  db: Db,
  groupId: string,
  senderId: string,
  email: string,
): Promise<string> {
  // A pair has two member rows; one left behind by a person merged into the sender resolves to
  // the sender, so every row is resolved and the sender's own are skipped.
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', groupId), Query.limit(MAX_PAIR_ROWS)],
    total: false,
  })
  let other: string | undefined
  for (const row of rows) {
    const resolved = await finalPerson(db, row.personId)
    if (resolved && resolved !== senderId) {
      other = resolved
      break
    }
  }
  const { rows: identities } = await db.listRows<Identities>({
    databaseId: DATABASE_ID,
    tableId: TABLES.identities,
    queries: [Query.equal('key', identityKey('email', email)), Query.limit(1)],
    total: false,
  })
  const owner = identities[0] && (await finalPerson(db, identities[0].personId))
  if (!other || !owner || other !== owner) {
    throw new AppError('VALIDATION_FAILED', WRONG_ADDRESS)
  }
  return other
}

/** The person `personId` ends at, following `mergedInto` through every merge. */
async function finalPerson(db: Db, personId: string): Promise<string | undefined> {
  let id = personId
  for (let hop = 0; hop < MAX_MERGES; hop++) {
    const person = await getRowOrNull<Persons>(db, TABLES.persons, id)
    if (!person) return undefined
    if (!person.mergedInto) return person.$id
    id = person.mergedInto
  }
  return undefined
}

/** RATE_LIMITED if any of REMINDER_LIMITS is reached, counting committed rows. */
async function checkLimits(
  db: Db,
  { sentBy, toPersonId, groupId }: Pick<Reminders, 'sentBy' | 'toPersonId' | 'groupId'>,
  now: Date,
): Promise<void> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString()
  const { perSenderPerGroup, perRecipient, perSender } = REMINDER_LIMITS
  const checks: Array<[number, string[]]> = [
    [
      perSenderPerGroup.count,
      [
        Query.equal('sentBy', sentBy),
        Query.equal('groupId', groupId),
        Query.greaterThan('sentAt', since(perSenderPerGroup.days)),
      ],
    ],
    [
      perRecipient.count,
      [
        Query.equal('toPersonId', toPersonId),
        Query.greaterThan('sentAt', since(perRecipient.days)),
      ],
    ],
    [
      perSender.count,
      [Query.equal('sentBy', sentBy), Query.greaterThan('sentAt', since(perSender.days))],
    ],
  ]
  for (const [limit, queries] of checks) {
    const { rows } = await db.listRows<Reminders>({
      databaseId: DATABASE_ID,
      tableId: TABLES.reminders,
      queries: [...queries, Query.limit(limit)],
      total: false,
    })
    if (rows.length >= limit) throw new AppError('RATE_LIMITED', TOO_MANY)
  }
}

// Resend's answer for a key it has already sent, with other content (the balance changed). A
// parallel call still sending it (`concurrent_idempotent_requests`) may yet fail, so that one is
// INTERNAL and the app tries again.
const ALREADY_SENT: ReadonlySet<string> = new Set(['invalid_idempotent_request'])

// Checked before anything is stored, so a missing APP_URL stores nothing.
function appLink(appUrl: string): string {
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error('APP_URL is not set. Add it as an Appwrite project variable.')
  }
  return appUrl.replace(/\/+$/, '')
}
