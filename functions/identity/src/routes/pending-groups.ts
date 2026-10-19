import type { Groups, Members } from '@ledgerly/core/generated/rows'
import { emptyBodySchema } from '@ledgerly/core/schemas/common'
import type {
  JoinGroupResult,
  PendingGroup,
  PendingGroupsResult,
} from '@ledgerly/core/schemas/identity'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { isInTeam } from '@ledgerly/server/appwrite/teams'
import { AppError } from '@ledgerly/server/http/app-error'
import { Query } from 'node-appwrite'
import { joinGroup } from '../join-group'
import { parseBody } from '../parse-body'
import { findPersonOfUser, getRowOrNull, SET_UP_FIRST } from '../rows'
import type { Services } from '../services'

const PAGE_SIZE = 100

/**
 * `identity GET /groups/pending`: the groups where the caller's person is still a `placeholder`
 * member, archived ones included (functions-api.md#identity). Only what a pending list shows:
 * for a pair group, the other member's display name too, since the group's own name is what
 * its creator calls the caller.
 */
export async function listPendingGroups(
  { db }: Services,
  userId: string,
): Promise<PendingGroupsResult> {
  const person = await findPersonOfUser(db, userId)
  // A person with deletedAt is never resolved from a userId (identity-and-invites.md#order).
  if (!person || person.deletedAt) throw new AppError('NOT_FOUND', SET_UP_FIRST)
  const groupIds = (await placeholderRows(db, person.$id)).map((member) => member.groupId)
  const groups: PendingGroup[] = []
  for (let start = 0; start < groupIds.length; start += PAGE_SIZE) {
    const { rows } = await db.listRows<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      queries: [
        Query.equal('$id', groupIds.slice(start, start + PAGE_SIZE)),
        Query.limit(PAGE_SIZE),
      ],
      total: false,
    })
    for (const { $id, type, name, archivedAt } of rows) {
      groups.push({ id: $id, type, name, archivedAt })
    }
  }
  const names = await counterpartNames(
    db,
    person.$id,
    groups.filter((group) => group.type === 'pair').map((group) => group.id),
  )
  for (const group of groups) {
    const counterpartName = names.get(group.id)
    if (counterpartName !== undefined) group.counterpartName = counterpartName
  }
  const shown = (group: PendingGroup) => group.counterpartName ?? group.name
  return { groups: groups.sort((a, b) => shown(a).localeCompare(shown(b))) }
}

/**
 * The other member's display name in each pair group: a pair has exactly two members, so one
 * row per group. Only the name, never an email or phone.
 */
async function counterpartNames(
  db: Db,
  personId: string,
  groupIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (let start = 0; start < groupIds.length; start += PAGE_SIZE) {
    const { rows } = await db.listRows<Members>({
      databaseId: DATABASE_ID,
      tableId: TABLES.members,
      queries: [
        Query.equal('groupId', groupIds.slice(start, start + PAGE_SIZE)),
        Query.notEqual('personId', personId),
        Query.limit(PAGE_SIZE),
      ],
      total: false,
    })
    for (const row of rows) names.set(row.groupId, row.displayName)
  }
  return names
}

/**
 * `identity POST /groups/{id}/join` (identity-and-invites.md#joining-a-group). Reads the
 * caller's own member row before the group, so someone who isn't in it learns nothing. A row
 * already `active`, or `left` while still in the team (moved out), is returned unchanged without
 * touching the team, so a retry is safe; `left` and out of the team (left on their own) is
 * NOT_A_MEMBER.
 */
export async function joinPendingGroup(
  services: Services,
  userId: string,
  groupId: string,
  body: unknown,
): Promise<JoinGroupResult> {
  parseBody(emptyBodySchema, body ?? {})
  const { db } = services
  const found = await findPersonOfUser(db, userId)
  // Never a deleted account's person (identity-and-invites.md#order).
  const person = found?.deletedAt ? undefined : found
  let member = person ? await ownMemberRow(db, groupId, person.$id) : undefined
  if (!person || !member) throw notAMember()
  // Someone who left on their own is out of the team, and coming back isn't supported in v1;
  // a member who moved out (`left`, still in the team) gets the group as before.
  if (member.status === 'left' && !(await isInTeam(services.teams, groupId, userId))) {
    throw notAMember()
  }
  // Only now, so someone who isn't in the group learns nothing about it. A member row without
  // its group (a create that failed partway) must not join a team.
  const group = await getRowOrNull<Groups>(db, TABLES.groups, groupId)
  if (!group) throw notAMember()
  if (member.status === 'placeholder') {
    await joinGroup(services, userId, person.$id, member)
    // Joined now, or by a claim at the same time; gone or someone else's (removed or merged
    // meanwhile) means not a member, and joinGroup has taken back the team membership.
    member = await ownMemberRow(db, groupId, person.$id)
    if (!member || member.status === 'placeholder') throw notAMember()
  }
  return { group, member }
}

function notAMember(): AppError {
  return new AppError('NOT_A_MEMBER', "You're not a member of this group.")
}

// One row per person and group (members.uniq_group_person).
async function ownMemberRow(
  db: Db,
  groupId: string,
  personId: string,
): Promise<Members | undefined> {
  const { rows } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    tableId: TABLES.members,
    queries: [Query.equal('groupId', groupId), Query.equal('personId', personId), Query.limit(1)],
    total: false,
  })
  return rows[0]
}

// members.idx_person_status, a page at a time.
async function placeholderRows(db: Db, personId: string): Promise<Members[]> {
  const rows: Members[] = []
  let cursor: string | undefined
  for (;;) {
    const { rows: page } = await db.listRows<Members>({
      databaseId: DATABASE_ID,
      tableId: TABLES.members,
      queries: [
        Query.equal('personId', personId),
        Query.equal('status', 'placeholder'),
        Query.limit(PAGE_SIZE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
      total: false,
    })
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    cursor = page.at(-1)?.$id
  }
}
