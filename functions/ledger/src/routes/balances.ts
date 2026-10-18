import type { Shares } from '@ledgerly/core/generated/rows'
import { type Net, netsFromShares } from '@ledgerly/core/settle/nets'
import { suggestTransfers, type Transfer } from '@ledgerly/core/settle/suggest-transfers'
import type { Db } from '@ledgerly/server/appwrite/client'
import { TABLES } from '@ledgerly/server/appwrite/tables'
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
    await requireMember(db, userId, params.groupId, { allowArchived: true })
    // The shares are read a page at a time, so a write that commits between two pages can tear
    // one read. It is read again; shares that still don't add up to 0 are broken (I-1).
    let broken = false
    for (let read = 0; read < READS; read++) {
      const people = await readNets(db, params.groupId)
      broken = people !== undefined
      if (!people) continue
      try {
        return { people, transfers: suggestTransfers(people) }
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
      }
    }
    throw broken
      ? new AppError('INVARIANT_VIOLATION', 'This group’s balances don’t add up.')
      : new AppError('CONFLICT', 'The group changed while it was read. Try again.')
  },
)

/** The nets from every share in the group, or undefined when a page's cursor row was deleted. */
async function readNets(db: Db, groupId: string): Promise<Net[] | undefined> {
  try {
    const shares = await listAll<Shares>(db, TABLES.shares, [Query.equal('groupId', groupId)])
    return netsFromShares(shares)
  } catch (error) {
    // The last share of a page was deleted (a void or an edit) before the next page was read.
    if (error instanceof AppwriteException && error.type === 'general_cursor_not_found') {
      return undefined
    }
    throw error
  }
}
