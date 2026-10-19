import type { Groups } from '@ledgerly/core/generated/rows'
import type { Balances } from '@ledgerly/core/schemas/ledger'
import type { Net } from '@ledgerly/core/settle/nets'
import { suggestTransfers, type Transfer } from '@ledgerly/core/settle/suggest-transfers'
import type { Db } from '@ledgerly/server/appwrite/client'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { readBalances, readGroupNets } from '@ledgerly/server/ledger/balances'
import type { ServicesFor } from '../services'

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
        console.error(
          `balances: the row of group ${group.$id} can't be read or doesn't add up; summed the shares`,
        )
      }
      return freshBalances(db, group)
    },
  )

/**
 * The balances summed from every share, as a whole read (`readGroupNets`, which a reminder reads
 * too, so they can't disagree).
 */
async function freshBalances(db: Db, group: Groups): Promise<Balances> {
  const people = await readGroupNets(db, group)
  const transfers = settle(people)
  // A whole read that doesn't add up to 0 (I-1).
  if (!transfers) throw new AppError('INVARIANT_VIOLATION', 'This group’s balances don’t add up.')
  return { people, transfers }
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
