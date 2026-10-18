import type { Groups, Members, Persons, Profiles } from '@ledgerly/core/generated/rows'
import { createGroupBodySchema, type GroupSettings } from '@ledgerly/core/schemas/groups'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { addToTeam, type TeamsApi } from '@ledgerly/server/appwrite/teams'
import { type Write, withTransaction } from '@ledgerly/server/appwrite/transaction'
import { AppError } from '@ledgerly/server/http/app-error'
import { type PersonInput, resolvePerson } from '@ledgerly/server/identity/resolve-person'
import { ID, Query } from 'node-appwrite'
import type { Services } from '../services'
import {
  activityWrite,
  checkRegion,
  conflictAsTryAgain,
  getRowOrNull,
  invalid,
  isAppwriteError,
  nextCloseAtFor,
  parseBody,
  teamRead,
  today,
} from '../shared'

export type CreateGroupResult = { group: Groups; members: Members[] }

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
  if (!profile || !creator) throw new AppError('NOT_FOUND', 'Set up your account first.')

  // functions-api.md#idempotency: the client chose the ID, so a retry finds the group.
  const existing = await getRowOrNull<Groups>(db, TABLES.groups, input.id)
  if (existing) {
    if (existing.ownerPersonId !== creator.$id) throw new AppError('CONFLICT', ID_TAKEN)
    return { group: existing, members: await membersOf(db, existing.$id) }
  }

  const region = input.region ?? profile.region
  checkRegion(region)
  const timezone = input.timezone ?? profile.timezone
  const statementCycle = input.statementCycle ?? (input.type === 'employer' ? 'monthly' : 'none')
  const cycleAnchor = input.cycleAnchor ?? null
  const joinedOn = today({ timezone }, now)
  const permissions = teamRead(input.id)

  // Team ID = group ID (D-004). The team and the creator's membership come before the
  // transaction, so no committed row names a missing team; a team left by a failed attempt
  // grants nothing without the group row. Nobody else is ever added here (D-016).
  await claimTeam(teams, input.id, input.name, userId)
  await addToTeam(teams, input.id, userId)

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
      // The schema requires a counterpart exactly for employer and pair groups.
      if (input.counterpart && input.type !== 'house') {
        const counterpart = await resolveCounterpart(db, input.counterpart, region, tx.id)
        if (counterpart.personId === creator.$id) {
          throw invalid("You can't be your own counterpart.")
        }
        writes.push(...counterpart.writes, {
          action: 'create',
          tableId: TABLES.members,
          rowId: ID.unique(),
          data: {
            groupId: input.id,
            personId: counterpart.personId,
            displayName: input.counterpart.displayName,
            role: COUNTERPART_ROLE[input.type],
            // Even a registered person: they join the group themselves (D-016).
            status: 'placeholder',
            joinedOn,
          },
          permissions,
        })
      }
      writes.push(
        activityWrite(
          input.id,
          creator.$id,
          'group.created',
          `${creator.displayName} created ${input.name}`,
          now,
        ),
      )
      if (input.counterpart && input.type !== 'house') {
        // identity-and-invites.md#adding-someone-to-a-group, step 5: the counterpart is added too.
        writes.push(
          activityWrite(
            input.id,
            creator.$id,
            'member.added',
            `${input.counterpart.displayName} was added`,
            now,
          ),
        )
      }
      await tx.write(...writes)
    }),
  )
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
  const taken = memberships.some((membership) => {
    // TeamsApi's type leaves roles out, but Appwrite returns them. Missing roles fail closed.
    const { roles } = membership as { roles?: string[] }
    return membership.userId !== userId || roles === undefined || roles.includes('owner')
  })
  if (taken) throw new AppError('CONFLICT', ID_TAKEN)
}

// The counterpart's person; an invalid email or phone is the caller's mistake.
async function resolveCounterpart(db: Db, input: PersonInput, region: string, txId: string) {
  try {
    return await resolvePerson(db, input, region, txId)
  } catch (error) {
    if (error instanceof RangeError) throw invalid('The email or phone number is not valid.')
    throw error
  }
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
