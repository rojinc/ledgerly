import type { Groups, Shares } from '@ledgerly/core/generated/rows'
import type { Balances } from '@ledgerly/core/schemas/ledger'
import { type Net, netsFromShares } from '@ledgerly/core/settle/nets'
import { suggestTransfers, type Transfer } from '@ledgerly/core/settle/suggest-transfers'
import type { Db } from '@ledgerly/server/appwrite/client'
import { DATABASE_ID, TABLES } from '@ledgerly/server/appwrite/tables'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { readBalances } from '@ledgerly/server/ledger/balances'
import { listAll } from '@ledgerly/server/ledger/transactions'
import { AppwriteException, Query } from 'node-appwrite'
import type { ServicesFor } from '../services'

const READS = 3

/**
 * `GET /groups/{groupId}/balances` (functions-api.md#ledger; ledger.md#balances): each person's
 * net in the group and the transfers that would settle it, from the group's `balances` row.
 * Archived groups can still be read.
 */
export const groupBalances = (services: ServicesFor) =>
  route(
    'GET',
    '/groups/:groupId/balances',
    async ({ userId, params, db, headers }): Promise<Balances> => {
      const { group } = await requireMember(
        db,
        services({ headers }).teams,
        userId,
        params.groupId,
        { allowArchived: true },
      )
      const row = await readBalances(db, group.$id)
      if (row) {
        const people = row.map(({ personId, netCents }) => ({ personId, netCents }))
        const transfers = settle(people)
        if (transfers) return { people, transfers }
      }
      // No row yet (not backfilled), or a row that's broken: the shares are the truth.
      if (row !== undefined) {
        console.error(`balances: the row of group ${group.$id} can't be read or doesn't add up; summed the shares`)
      }
      return freshBalances(db, group)
    },
  )

/**
 * The balances summed from every share, read a page at a time. Every write of shares also
 * writes a fresh `rev` to the group row (ledger.md#concurrency), so the same `rev` before and
 * after means no write committed in between: the read is whole. Otherwise it is read again.
 */
async function freshBalances(db: Db, group: Groups): Promise<Balances> {
  let before = group
  for (let read = 0; read < READS; read++) {
    const shares = await readShares(db, group.$id)
    const after = await db.getRow<Groups>({
      databaseId: DATABASE_ID,
      tableId: TABLES.groups,
      rowId: group.$id,
    })
    if (shares && after.rev === before.rev) {
      const people = netsFromShares(shares)
      const transfers = settle(people)
      // A whole read that doesn't add up to 0 (I-1).
      if (!transfers) {
        throw new AppError('INVARIANT_VIOLATION', 'This group’s balances don’t add up.')
      }
      return { people, transfers }
    }
    before = after
  }
  throw new AppError('CONFLICT', 'The group changed while it was read. Try again.')
}

/** The transfers that settle `people`, or undefined when their nets don't add up to 0. */
function settle(people: Net[]): Transfer[] | undefined {
  try {
    return suggestTransfers(people)
  } catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
}

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
