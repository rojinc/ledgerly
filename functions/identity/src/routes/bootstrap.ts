import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Persons, Profiles } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { type BootstrapResult, bootstrapBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, ensureTeam } from '@ledgerly/server/appwrite/teams'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { logProblem } from '@ledgerly/server/http/log'
import { profileDefaults } from '@ledgerly/server/identity/defaults'
import { randomId } from '@ledgerly/server/identity/random-id'
import { ID, Permission, Query, Role } from 'node-appwrite'
import { parseBody } from '../parse-body'
import {
  findIdentity,
  findPersonOfUser,
  getRowOrNull,
  isAppwriteError,
  isPlaceholder,
  tryAgain,
  typedKeyDeletes,
} from '../rows'
import type { AccountUser, Services } from '../services'
import { claim, type VerifiedIdentity, verifiedIdentities } from './claim'

// The Appwrite label of a user whose account is being deleted (account's step 3).
const DELETED_LABEL = 'deleted'
const PERSONAL_GROUP_NAME = 'Personal'
const MAX_NAME_LENGTH = 100 // persons.displayName

/** `identity POST /bootstrap` (identity-and-invites.md#first-login-bootstrap): every login. */
export async function bootstrap(
  services: Services,
  userId: string,
  body: unknown,
): Promise<BootstrapResult> {
  const { timezone } = parseBody(bootstrapBodySchema, body)
  const { db } = services
  const user = await services.users.get({ userId })
  // identity-and-invites.md#order: a deleted account never gets a person or profile again.
  if (user.labels.includes(DELETED_LABEL) || (await hasDeletedPerson(db, userId))) {
    throw accountDeleted()
  }
  const identities = verifiedIdentities(user)
  // Step 1: with a profile, go straight to claim, so an interrupted claim always gets finished.
  const profile =
    (await getRowOrNull<Profiles>(db, TABLES.profiles, userId)) ??
    (await setUp(services, user, identities, timezone))
  // Step 3.
  const linkedGroupIds = await claim(services, userId, identities)
  const personalGroupId = await findPersonalGroupId(db, profile.personId)
  return { profile, personId: profile.personId, personalGroupId, linkedGroupIds }
}

// Step 2: the person, profile, personal group, its team and an admin membership. Returns the
// new profile, or the one a bootstrap for the same user running at the same time made first.
async function setUp(
  { db, teams, users, now }: Services,
  user: AccountUser,
  identities: VerifiedIdentity[],
  timeZone: string,
): Promise<Profiles> {
  const userId = user.$id
  const person = await planPerson(db, user, identities, now)
  const groupId = randomId()
  // The team and the user's membership come before the transaction, so no committed row ever
  // names a team that doesn't exist. If the transaction fails, the team is left without a
  // group row, so it grants nothing. Memberships never get a team role (teams.ts).
  await ensureTeam(teams, groupId, PERSONAL_GROUP_NAME)
  await addToTeam(teams, groupId, userId)
  const { region, currency } = profileDefaults(timeZone)
  const team = [Permission.read(Role.team(groupId))]
  try {
    const deleted = await withTransaction(db, async (tx) => {
      let typed = 0
      await tx.write(
        person.write,
        {
          action: 'create',
          tableId: TABLES.profiles,
          rowId: userId,
          data: { personId: person.personId, timezone: timeZone, region, currency },
          permissions: [Permission.read(Role.user(userId))],
        },
        {
          action: 'create',
          tableId: TABLES.groups,
          rowId: groupId,
          data: {
            type: 'personal',
            name: PERSONAL_GROUP_NAME,
            ownerPersonId: person.personId,
            currency,
            timezone: timeZone,
            region,
            statementCycle: 'none',
            settingsJson: JSON.stringify(groupSettingsSchema.parse({ type: 'personal' })),
          },
          permissions: team,
        },
        {
          action: 'create',
          tableId: TABLES.members,
          rowId: ID.unique(),
          data: {
            groupId,
            personId: person.personId,
            displayName: person.displayName,
            role: 'admin',
            status: 'active',
            joinedOn: localToday(timeZone, now),
          },
          permissions: team,
        },
      )
      if (person.adopted) {
        // Stage, then check (transaction.ts): the stored row, since this transaction's view
        // already has the new userId. Another user may have claimed the placeholder first.
        const stored = await getRowOrNull<Persons>(db, TABLES.persons, person.personId)
        if (!stored || !(isPlaceholder(stored) || stored.userId === userId)) throw tryAgain()
        // Only the keys the user verified stay theirs; the ones someone typed go, in this same
        // transaction (identity-and-invites.md#only-verified-keys-move).
        const deletes = await typedKeyDeletes(
          db,
          person.personId,
          identities.map((identity) => identity.key),
        )
        if (deletes.length > 0) await tx.write(...deletes)
        typed = deletes.length
      } else if (person.write.action === 'update') {
        // The same for their own person, whose deletion may have passed step 2 since the check
        // in `bootstrap`.
        const stored = await getRowOrNull<Persons>(db, TABLES.persons, person.personId)
        if (stored?.deletedAt) throw accountDeleted()
      }
      // On every path: a deletion's step 3 may have labelled the user since that check too.
      if ((await users.get({ userId })).labels.includes(DELETED_LABEL)) throw accountDeleted()
      return typed
    })
    // Once committed, so a lost race logs nothing. IDs and counts only.
    if (deleted > 0) logProblem('typed_keys_deleted', { personId: person.personId, count: deleted })
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
    // A bootstrap for the same user that ran at the same time created the profile first: use
    // it. Otherwise the placeholder changed after it was staged.
    const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
    if (!profile) throw tryAgain()
    return profile
  }
  return db.getRow<Profiles>({ databaseId: DATABASE_ID, tableId: TABLES.profiles, rowId: userId })
}

type PersonPlan = { personId: string; displayName: string; write: Write; adopted: boolean }

// The user's person: the one already theirs, else a placeholder one of their verified
// identities points at (adopt; email first), else a new one. persons.displayName becomes their
// own name, and claimedAt is set once.
async function planPerson(
  db: Db,
  user: AccountUser,
  identities: VerifiedIdentity[],
  now: Date,
): Promise<PersonPlan> {
  const name = ownName(user)
  const owner = [Permission.read(Role.user(user.$id))]
  const own = await findPersonOfUser(db, user.$id)
  if (own) {
    return {
      personId: own.$id,
      displayName: own.displayName,
      write: {
        action: 'update',
        tableId: TABLES.persons,
        rowId: own.$id,
        data: { claimedAt: own.claimedAt ?? now.toISOString() },
        permissions: owner,
      },
      adopted: false,
    }
  }
  for (const { key } of identities) {
    // Placeholder identity rows are never verified, so match on the key, not the flag.
    const identity = await findIdentity(db, key)
    const person = identity && (await getRowOrNull<Persons>(db, TABLES.persons, identity.personId))
    if (!person || !isPlaceholder(person)) continue
    const displayName = name ?? person.displayName
    return {
      personId: person.$id,
      displayName,
      write: {
        action: 'update',
        tableId: TABLES.persons,
        rowId: person.$id,
        data: { userId: user.$id, displayName, claimedAt: person.claimedAt ?? now.toISOString() },
        permissions: owner,
      },
      adopted: true,
    }
  }
  const personId = randomId()
  const displayName = name ?? 'Me'
  return {
    personId,
    displayName,
    write: {
      action: 'create',
      tableId: TABLES.persons,
      rowId: personId,
      data: { userId: user.$id, displayName, claimedAt: now.toISOString() },
      permissions: owner,
    },
    adopted: false,
  }
}

// The account's name, cut to fit persons.displayName; never made up from the email or phone.
function ownName(user: AccountUser): string | undefined {
  const name = [...user.name.trim()].slice(0, MAX_NAME_LENGTH).join('').trim()
  return name === '' ? undefined : name
}

// Being deleted, or deleted: the deletion passed its point of no return (`deletedAt`) for a
// person naming the user, or labelled the user (identity-and-invites.md#deleting-an-account-m4).
function accountDeleted(): AppError {
  return new AppError('UNAUTHENTICATED', 'This account has been deleted.')
}

// `idx_userId`
async function hasDeletedPerson(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.listRows<Persons>({
    databaseId: DATABASE_ID,
    tableId: TABLES.persons,
    queries: [Query.equal('userId', userId), Query.isNotNull('deletedAt'), Query.limit(1)],
    total: false,
  })
  return rows.length > 0
}

async function findPersonalGroupId(db: Db, personId: string): Promise<string> {
  const { rows } = await db.listRows<Groups>({
    databaseId: DATABASE_ID,
    tableId: TABLES.groups,
    queries: [
      Query.equal('ownerPersonId', personId),
      Query.equal('type', 'personal'),
      Query.limit(1),
    ],
    total: false,
  })
  const group = rows[0]
  if (!group) throw new Error('The personal group is missing')
  return group.$id
}
