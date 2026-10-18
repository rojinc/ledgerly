import { localToday } from '@ledgerly/core/dates/time-zone'
import type { Groups, Persons, Profiles } from '@ledgerly/core/generated/rows'
import { groupSettingsSchema } from '@ledgerly/core/schemas/groups'
import { bootstrapBodySchema } from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, ensureTeam } from '@ledgerly/server/appwrite/teams'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
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
} from '../rows'
import type { AccountUser, Services } from '../services'
import { claim, type VerifiedIdentity, verifiedIdentities } from './claim'

export type BootstrapResult = {
  profile: Profiles
  personId: string
  personalGroupId: string
  linkedGroupIds: string[]
}

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
  { db, teams, now }: Services,
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
    await withTransaction(db, async (tx) => {
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
        if (!stored || !(isPlaceholder(stored) || stored.userId === userId)) {
          throw new AppError('CONFLICT', 'Your account changed while we set it up. Try again.')
        }
      }
    })
  } catch (error) {
    // A bootstrap for the same user that ran at the same time created the profile first.
    if (!isAppwriteError(error, 409)) throw error
    const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
    if (!profile) throw error
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
