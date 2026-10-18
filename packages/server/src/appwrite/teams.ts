import { AppwriteException, type Models, Query } from 'node-appwrite'

/**
 * The parts of Teams that functions use. The real `Teams` and `FakeTeams` (fake-teams.ts) both
 * satisfy it. Team ID = group ID (D-004); only functions change memberships (permissions.md#teams).
 */
export interface TeamsApi {
  create(params: { teamId: string; name: string; roles?: string[] }): Promise<unknown>
  createMembership(params: { teamId: string; roles: string[]; userId?: string }): Promise<unknown>
  listMemberships(params: {
    teamId: string
    queries?: string[]
  }): Promise<{ memberships: Array<Pick<Models.Membership, '$id' | 'userId'>> }>
  deleteMembership(params: { teamId: string; membershipId: string }): Promise<unknown>
}

// Memberships never get a team role, `owner` least of all: an owner could manage the team from
// the client. Authority lives in `members.role` (D-004).
const NO_ROLES: string[] = []

/** Creates the team. One that already exists counts as done, so a retry is safe. */
export async function ensureTeam(teams: TeamsApi, teamId: string, name: string): Promise<void> {
  await doneIfExists(teams.create({ teamId, name, roles: NO_ROLES }))
}

/** Adds the user to the team. "Already a member" counts as done, so a retry is safe. */
export async function addToTeam(teams: TeamsApi, teamId: string, userId: string): Promise<void> {
  await doneIfExists(teams.createMembership({ teamId, userId, roles: NO_ROLES }))
}

/** Removes the user from the team; a membership or team that is already gone counts as done. */
export async function removeFromTeam(
  teams: TeamsApi,
  teamId: string,
  userId: string,
): Promise<void> {
  try {
    const { memberships } = await teams.listMemberships({
      teamId,
      queries: [Query.equal('userId', userId), Query.limit(1)],
    })
    for (const membership of memberships) {
      await teams.deleteMembership({ teamId, membershipId: membership.$id })
    }
  } catch (error) {
    if (!(error instanceof AppwriteException && error.code === 404)) throw error
  }
}

async function doneIfExists(request: Promise<unknown>): Promise<void> {
  try {
    await request
  } catch (error) {
    if (!(error instanceof AppwriteException && error.code === 409)) throw error
  }
}
