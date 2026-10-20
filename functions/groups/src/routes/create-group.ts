import type { Groups, Members, Persons, Profiles } from '@ledgerly/core/generated/rows'
import type { CreateGroupResult } from '@ledgerly/core/schemas/groups'
import {
  type CreateGroupBody,
  createGroupBodySchema,
  type GroupSettings,
  groupSettingsSchema,
} from '@ledgerly/core/schemas/groups'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, removeFromTeam, type TeamsApi } from '@ledgerly/server/appwrite/teams'
import { type Tx, type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import {
  type PersonInput,
  type ResolvedPerson,
  resolvePerson,
} from '@ledgerly/server/identity/resolve-person'
import { ID, Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  aRole,
  checkRegion,
  conflictAsTryAgain,
  countTwoKeys,
  findFirst,
  getRowOrNull,
  invalid,
  isAppwriteError,
  nextCloseAtFor,
  parseBody,
  resolveGuarded,
  takeBackTwoKeys,
  teamRead,
  today,
} from '../shared'

// permissions.md#default-roles-by-group-type: the counterpart's role.
const COUNTERPART_ROLE = { employer: 'viewer', pair: 'admin' } as const

const ID_TAKEN = 'That ID is taken.'

/**
 * `groups POST /groups`: the group, its team holding only the creator, the creator as admin and,
 * for employer and pair groups, the counterpart as a placeholder (D-016). Repeating the request
 * returns what the first one made.
 */
export async function createGroup(
  { db, teams, now }: Services,
  userId: string,
  body: unknown,
): Promise<CreateGroupResult> {
  const input = parseBody(createGroupBodySchema, body)
  const profile = await getRowOrNull<Profiles>(db, TABLES.profiles, userId)
  const creator = profile && (await getRowOrNull<Persons>(db, TABLES.persons, profile.personId))
  // A person being deleted is no person (identity-and-invites.md#deleting-an-account-m4).
  if (!profile || !creator || creator.deletedAt) {
    throw new AppError('NOT_FOUND', 'Set up your account first.')
  }

  // functions-api.md#idempotency: the client chose the ID, so a retry finds the group. It is
  // the caller's only while they own it, are still in it, and asked for the same group.
  const existing = await getRowOrNull<Groups>(db, TABLES.groups, input.id)
  if (existing) {
    const own = await findFirst<Members>(db, TABLES.members, [
      Query.equal('groupId', existing.$id),
      Query.equal('personId', creator.$id),
    ])
    if (
      existing.ownerPersonId !== creator.$id ||
      own?.status !== 'active' ||
      !sameGroup(input, existing)
    ) {
      throw new AppError('CONFLICT', ID_TAKEN)
    }
    return { group: existing, members: await membersOf(db, existing.$id) }
  }

  const region = input.region ?? profile.region
  checkRegion(region)
  const timezone = input.timezone ?? profile.timezone
  const statementCycle = input.statementCycle ?? (input.type === 'employer' ? 'monthly' : 'none')
  const cycleAnchor = input.cycleAnchor ?? null
  const joinedOn = today({ timezone }, now)
  const permissions = teamRead(input.id)
  // The schema requires a counterpart exactly for employer and pair groups.
  const counterpartInput = input.type === 'house' ? undefined : input.counterpart
  const counterpartRole = input.type === 'house' ? undefined : COUNTERPART_ROLE[input.type]
  // A counterpart with both an email and a phone is counted first, before even the check that
  // it isn't the creator: that check answers only for an unknown email, so a guess pays either
  // way (#378).
  const window = counterpartInput
    ? await countTwoKeys(db, creator.$id, counterpartInput, region, now).catch(invalidKeys)
    : undefined
  // Validated before the team exists, so a refusal leaves no team behind. The transaction
  // resolves again, to stage what it finds then.
  if (counterpartInput) await resolveCounterpart(db, counterpartInput, region, creator.$id)

  // Team ID = group ID (D-004). The team and the creator's membership come before the
  // transaction, so no committed row names a missing team; a team left by a failed attempt
  // grants nothing without the group row. Nobody else is ever added here (D-016).
  await claimTeam(teams, input.id, input.name, userId)
  await addToTeam(teams, input.id, userId)
  // Another user creating the same ID at the same time can claim the team too: whoever finds
  // someone else in it backs out.
  const { memberships } = await teams.listMemberships({ teamId: input.id })
  if (memberships.length !== 1 || !holdsOnly(memberships, userId)) {
    await leaveTeam(teams, input.id, userId)
    throw new AppError('CONFLICT', ID_TAKEN)
  }

  try {
    await conflictAsTryAgain(() =>
      withTransaction(db, async (tx) => {
        const writes: Write[] = [
          {
            action: 'create',
            tableId: TABLES.groups,
            rowId: input.id,
            data: {
              type: input.type,
              name: input.name,
              ownerPersonId: creator.$id,
              currency: input.currency ?? profile.currency,
              timezone,
              region,
              statementCycle,
              cycleAnchor,
              nextCloseAt: nextCloseAtFor(statementCycle, cycleAnchor, timezone, now),
              settingsJson: JSON.stringify(input.settings ?? defaultSettings(input.type)),
              archivedAt: null,
            },
            permissions,
          },
          {
            action: 'create',
            tableId: TABLES.members,
            rowId: ID.unique(),
            data: {
              groupId: input.id,
              personId: creator.$id,
              displayName: creator.displayName,
              role: 'admin',
              status: 'active',
              joinedOn,
            },
            permissions,
          },
        ]
        // No names in activity rows (data-model.md#activity), not even the group's: a pair
        // group's is what its creator calls the other person.
        writes.push(activityWrite(input.id, creator.$id, 'group.created', 'Created the group', now))
        // Both are set for employer and pair groups; checking both narrows the role's type.
        if (counterpartInput && counterpartRole) {
          const counterpart = await resolveCounterpart(
            db,
            counterpartInput,
            region,
            creator.$id,
            tx,
          )
          await takeBackTwoKeys(tx, db, creator.$id, counterpartInput, region, window)
          writes.push(
            ...counterpart.writes,
            {
              action: 'create',
              tableId: TABLES.members,
              rowId: ID.unique(),
              data: {
                groupId: input.id,
                personId: counterpart.personId,
                displayName: counterpartInput.displayName,
                role: counterpartRole,
                // Even a registered person: they join the group themselves (D-016).
                status: 'placeholder',
                joinedOn,
              },
              permissions,
            },
            // identity-and-invites.md#adding-someone-to-a-group, step 5: the counterpart is added too.
            activityWrite(
              input.id,
              creator.$id,
              'member.added',
              `was added as ${aRole(counterpartRole)}`,
              now,
              { subjectPersonId: counterpart.personId },
            ),
          )
        }
        await tx.write(...writes)
      }),
    )
  } catch (error) {
    // The group isn't the caller's: it never committed, or another user's did. Out of the
    // team, so a failed attempt never leaves the caller in someone else's group.
    const stored = await getRowOrNull<Groups>(db, TABLES.groups, input.id)
    if (stored?.ownerPersonId === creator.$id) throw error
    await leaveTeam(teams, input.id, userId)
    if (stored) throw new AppError('CONFLICT', ID_TAKEN)
    throw error
  }
  const group = await db.getRow<Groups>({
    databaseId: DATABASE_ID,
    tableId: TABLES.groups,
    rowId: input.id,
  })
  return { group, members: await membersOf(db, input.id) }
}

/**
 * Creates the team. One that already exists is ours to use only when it is empty or holds just
 * the caller with no role, as an earlier try of this request leaves it. Anyone else in it, or
 * an `owner` (who could manage the team from the client), means CONFLICT.
 */
async function claimTeam(
  teams: TeamsApi,
  teamId: string,
  name: string,
  userId: string,
): Promise<void> {
  try {
    await teams.create({ teamId, name, roles: [] })
    return
  } catch (error) {
    if (!isAppwriteError(error, 409)) throw error
  }
  const { memberships } = await teams.listMemberships({ teamId })
  if (!holdsOnly(memberships, userId)) throw new AppError('CONFLICT', ID_TAKEN)
}

/** Whether every membership is the caller's, with no team role. */
function holdsOnly(memberships: Array<{ userId: string }>, userId: string): boolean {
  return memberships.every((membership) => {
    // TeamsApi's type leaves roles out, but Appwrite returns them. Missing roles fail closed.
    const { roles } = membership as { roles?: string[] }
    return membership.userId === userId && roles !== undefined && roles.length === 0
  })
}

/** Takes the caller back out of the team, best effort, trying twice: their error matters more. */
async function leaveTeam(teams: TeamsApi, teamId: string, userId: string): Promise<void> {
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      return await removeFromTeam(teams, teamId, userId)
    } catch {
      // Try once more, then give up: the team grants nothing without the group row.
    }
  }
}

/** Whether every field the body gave matches the stored group. The counterpart isn't compared. */
function sameGroup(input: CreateGroupBody, group: Groups): boolean {
  const { type, name, currency, timezone, region, statementCycle, cycleAnchor } = input
  const given = { type, name, currency, timezone, region, statementCycle, cycleAnchor }
  const columnsMatch = Object.entries(given).every(
    ([key, value]) => value === undefined || value === group[key as keyof typeof given],
  )
  if (!columnsMatch || input.settings === undefined) return columnsMatch
  // Both through the schema, so the keys are in the same order.
  const stored = groupSettingsSchema.safeParse(JSON.parse(group.settingsJson))
  return stored.success && JSON.stringify(stored.data) === JSON.stringify(input.settings)
}

// The counterpart's person; an invalid email or phone, or the creator's own, is the caller's
// mistake.
async function resolveCounterpart(
  db: Db,
  input: PersonInput,
  region: string,
  creatorId: string,
  // In the group's transaction, guarded; without one, only to check the input first.
  tx?: Tx,
) {
  let resolved: ResolvedPerson
  try {
    resolved = tx
      ? await resolveGuarded(tx, db, input, region)
      : await resolvePerson(db, input, region)
  } catch (error) {
    invalidKeys(error)
  }
  if (resolved.personId === creatorId) throw invalid("You can't be your own counterpart.")
  return resolved
}

// resolvePerson and countTwoKeys throw a RangeError for an email or phone they can't use.
function invalidKeys(error: unknown): never {
  if (error instanceof RangeError) throw invalid('The email or phone number is not valid.')
  throw error
}

function defaultSettings(type: 'house' | 'employer' | 'pair'): GroupSettings {
  switch (type) {
    case 'employer':
      return {
        type,
        defaultRateCents: 0,
        paymentTermsDays: 14,
        autoFinalize: false,
        recipients: [],
      }
    case 'house':
      return { type, autoFinalize: false, defaultBillSplit: 'days' }
    case 'pair':
      return { type }
  }
}

async function membersOf(db: Db, groupId: string): Promise<Members[]> {
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', groupId), Query.limit(100)],
    total: false,
  })
  return rows
}
