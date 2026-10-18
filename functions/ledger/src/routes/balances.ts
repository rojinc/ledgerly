import type { Groups, Shares } from '@ledgerly/core/generated/rows'
import { type Net, netsFromShares } from '@ledgerly/core/settle/nets'
import { suggestTransfers, type Transfer } from '@ledgerly/core/settle/suggest-transfers'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { AppwriteException, Query } from 'node-appwrite'
import { listAll } from './transactions-shared'

export type Balances = { people: Net[]; transfers: Transfer[] }

const READS = 3

/**
 * `GET /groups/{groupId}/balances` (functions-api.md#ledger; ledger.md#balances): each person's
 * net in the group, from their shares, and the transfers that would settle it. Worked out on
 * read until the `balances` table comes (M4). Archived groups can still be read.
 */
export const groupBalances = route(
  'GET',
  '/groups/:groupId/balances',
  async ({ userId, params, db }): Promise<Balances> => {
    let { group } = await requireMember(db, userId, params.groupId, { allowArchived: true })
    // The shares are read a page at a time. Every write of shares also writes a fresh `rev` to
    // the group row (ledger.md#concurrency), so the same `rev` before and after means no write
    // committed in between: the read is whole. Otherwise it is read again.
    for (let read = 0; read < READS; read++) {
      const shares = await readShares(db, group.$id)
      const after = await db.getRow<Groups>({
        databaseId: DATABASE_ID,
        tableId: TABLES.groups,
        rowId: group.$id,
      })
      if (shares && after.rev === group.rev) {
        const people = netsFromShares(shares)
        try {
          return { people, transfers: suggestTransfers(people) }
        } catch (error) {
          // A whole read that doesn't add up to 0 (I-1).
          if (error instanceof RangeError) {
            throw new AppError('INVARIANT_VIOLATION', 'This group’s balances don’t add up.')
          }
          throw error
        }
      }
      group = after
    }
    throw new AppError('CONFLICT', 'The group changed while it was read. Try again.')
  },
)

/** Every share in the group, or undefined when a page's cursor row was deleted meanwhile. */
async function readShares(db: Db, groupId: string): Promise<Shares[] | undefined> {
  try {
    return await listAll<Shares>(db, TABLES.shares, [Query.equal('groupId', groupId)])
  } catch (error) {
    if (error instanceof AppwriteException && error.type === 'general_cursor_not_found') {
      return undefined
    }
    throw error
  }
}
