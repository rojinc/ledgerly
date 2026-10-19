import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Members, Transactions } from '@ledgerly/core/generated/rows'
import { useQuery } from '@tanstack/react-query'
import { Query } from 'react-native-appwrite'
import { DATABASE_ID, tablesDB, teams } from './appwrite'

// The same reads as the web (apps/web: use-groups.ts, use-month-transactions.ts, use-shifts.ts).
// Reads only: every write goes through a function (D-003).

// Appwrite's limit for one page and for the values of one Query.equal.
const PAGE = 100

/** The groups the user has joined: their teams, since team ID = group ID (D-004). */
export function useGroups(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['groups', userId],
    enabled,
    queryFn: async () => {
      const groups: Groups[] = []
      for (let offset = 0; ; offset += PAGE) {
        const { teams: page } = await teams.list({
          queries: [Query.limit(PAGE), Query.offset(offset)],
        })
        if (page.length > 0) {
          const { rows } = await tablesDB.listRows<Groups>({
            databaseId: DATABASE_ID,
            tableId: 'groups',
            queries: [
              Query.equal(
                '$id',
                page.map((team) => team.$id),
              ),
              Query.limit(PAGE),
            ],
          })
          groups.push(...rows)
        }
        if (page.length < PAGE) break
      }
      return groups.sort((a, b) => a.name.localeCompare(b.name))
    },
  })
}

/** Every `transactions` row `queries` match, in cursor pages of 100, by date. */
async function listAll(queries: string[]): Promise<Transactions[]> {
  const rows: Transactions[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await tablesDB.listRows<Transactions>({
      databaseId: DATABASE_ID,
      tableId: 'transactions',
      queries: [
        ...queries,
        Query.orderAsc('date'),
        Query.limit(PAGE),
        ...(cursor === undefined ? [] : [Query.cursorAfter(cursor)]),
      ],
    })
    rows.push(...page.rows)
    if (page.rows.length < PAGE) return rows
    cursor = page.rows.at(-1)?.$id
  }
}

/** Every transaction dated `start` to `end` in `groupIds`, on `idx_group_date`, by date. */
export function useMonth(userId: string, groupIds: string[], start: LocalDate, end: LocalDate) {
  return useQuery({
    queryKey: ['calendar', userId, start, end, groupIds],
    enabled: groupIds.length > 0,
    queryFn: async () => {
      const items: Transactions[] = []
      for (let index = 0; index < groupIds.length; index += PAGE) {
        items.push(
          ...(await listAll([
            Query.equal('groupId', groupIds.slice(index, index + PAGE)),
            Query.greaterThanEqual('date', start),
            Query.lessThanEqual('date', end),
            Query.select(['$id', 'groupId', 'kind', 'status', 'date', 'description', 'totalCents']),
          ])),
        )
      }
      return items.sort((a, b) => a.date.localeCompare(b.date))
    },
  })
}

/** The caller's running timer in `groupIds` (not archived), on `idx_group_status_date`. */
export function useRunningTimer(personId: string, groupIds: string[]) {
  return useQuery({
    queryKey: ['running', personId, groupIds],
    enabled: groupIds.length > 0,
    queryFn: async () => {
      for (let index = 0; index < groupIds.length; index += PAGE) {
        const running = (
          await listAll([
            Query.equal('groupId', groupIds.slice(index, index + PAGE)),
            Query.equal('status', 'running'),
          ])
        ).find((row) => row.createdBy === personId)
        if (running) return running
      }
      return null
    },
  })
}

/** The caller's role in each group they have joined, from their own member rows. */
export function useMyRoles(personId: string, groupIds: string[]) {
  return useQuery({
    queryKey: ['roles', personId, groupIds],
    enabled: groupIds.length > 0,
    queryFn: async () => {
      const roles = new Map<string, Members['role']>()
      for (let index = 0; index < groupIds.length; index += PAGE) {
        const { rows } = await tablesDB.listRows<Members>({
          databaseId: DATABASE_ID,
          tableId: 'members',
          queries: [
            Query.equal('groupId', groupIds.slice(index, index + PAGE)),
            Query.equal('personId', personId),
            Query.limit(PAGE),
          ],
        })
        for (const row of rows) if (row.status !== 'placeholder') roles.set(row.groupId, row.role)
      }
      return roles
    },
  })
}
