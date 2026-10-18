import { AppwriteException } from 'node-appwrite'
import type { TeamsApi } from './teams'

type Membership = { $id: string; userId: string; roles: string[] }
type Query = { method: string; attribute?: string; values?: unknown[] }

/**
 * In-memory Teams for tests, with Appwrite's errors: 409 for a team that already exists or a
 * user who is already a member, 404 for a missing team or membership. Seed it with
 * `{ teamId: [userId, ...] }`. Only adds users by ID, as functions do with the server key.
 */
export class FakeTeams implements TeamsApi {
  private teams = new Map<string, { name: string; memberships: Membership[] }>()
  private sequence = 0

  constructor(seed: Record<string, string[]> = {}) {
    for (const [teamId, userIds] of Object.entries(seed)) {
      this.teams.set(teamId, {
        name: teamId,
        memberships: userIds.map((userId) => this.membership(userId, [])),
      })
    }
  }

  /** The team's memberships, for assertions; undefined when the team doesn't exist. */
  members(teamId: string): Membership[] | undefined {
    return this.teams.get(teamId)?.memberships.map((membership) => structuredClone(membership))
  }

  /** Every team ID, in creation order. */
  teamIds(): string[] {
    return [...this.teams.keys()]
  }

  async create(params: { teamId: string; name: string }): Promise<{ $id: string }> {
    if (this.teams.has(params.teamId)) {
      throw new AppwriteException('Team already exists', 409, 'team_already_exists')
    }
    this.teams.set(params.teamId, { name: params.name, memberships: [] })
    return { $id: params.teamId }
  }

  async createMembership(params: {
    teamId: string
    roles: string[]
    userId?: string
  }): Promise<Membership> {
    const team = this.team(params.teamId)
    if (params.userId === undefined) throw new Error('FakeTeams only adds users by ID')
    const { userId } = params
    if (team.memberships.some((membership) => membership.userId === userId)) {
      throw new AppwriteException('User is already a member', 409, 'membership_already_confirmed')
    }
    const membership = this.membership(userId, params.roles)
    team.memberships.push(membership)
    return structuredClone(membership)
  }

  async listMemberships(params: {
    teamId: string
    queries?: string[]
  }): Promise<{ total: number; memberships: Membership[] }> {
    let memberships = this.team(params.teamId).memberships
    let limit = 25
    for (const { method, attribute, values = [] } of (params.queries ?? []).map(
      (query) => JSON.parse(query) as Query,
    )) {
      if (method === 'equal' && attribute === 'userId') {
        memberships = memberships.filter((membership) => values.includes(membership.userId))
      } else if (method === 'limit') {
        limit = Number(values[0])
      } else {
        throw new Error(`FakeTeams does not support the "${method}" query`)
      }
    }
    return {
      total: memberships.length,
      memberships: memberships.slice(0, limit).map((membership) => structuredClone(membership)),
    }
  }

  async deleteMembership(params: { teamId: string; membershipId: string }): Promise<object> {
    const team = this.team(params.teamId)
    const index = team.memberships.findIndex((membership) => membership.$id === params.membershipId)
    if (index === -1) {
      throw new AppwriteException('Membership not found', 404, 'membership_not_found')
    }
    team.memberships.splice(index, 1)
    return {}
  }

  private team(teamId: string) {
    const team = this.teams.get(teamId)
    if (!team) throw new AppwriteException('Team not found', 404, 'team_not_found')
    return team
  }

  private membership(userId: string, roles: string[]): Membership {
    this.sequence += 1
    return { $id: `membership${this.sequence}`, userId, roles: [...roles] }
  }
}
