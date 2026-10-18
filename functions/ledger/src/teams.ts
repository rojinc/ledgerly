import { clientFromRequest } from '@ledgerly/server/appwrite/client'
import type { TeamsApi } from '@ledgerly/server/appwrite/teams'
import { Teams } from 'node-appwrite'

type Memberships = Pick<TeamsApi, 'listMemberships'>

let make = (headers: Record<string, string>): Memberships => new Teams(clientFromRequest(headers))

/**
 * Teams with the per-execution API key, for requireMember. Built only when asked, since only a
 * `left` member needs it.
 */
export function teamsFor(headers: Record<string, string>): Memberships {
  return { listMemberships: (params) => make(headers).listMemberships(params) }
}

/** Tests only: answer with a fake instead. */
export function setTeamsForTests(teams: Memberships): void {
  make = () => teams
}
