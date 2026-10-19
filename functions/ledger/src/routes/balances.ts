import type { Balances } from '@ledgerly/core/schemas/ledger'
import { suggestTransfers } from '@ledgerly/core/settle/suggest-transfers'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { readGroupNets } from '@ledgerly/server/ledger/balances'
import type { ServicesFor } from '../services'

/**
 * `GET /groups/{groupId}/balances` (functions-api.md#ledger; ledger.md#balances): each person's
 * net in the group, from their shares, and the transfers that would settle it. Worked out on
 * read until the `balances` table comes (M4). Archived groups can still be read.
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
      const people = await readGroupNets(db, group)
      try {
        return { people, transfers: suggestTransfers(people) }
      } catch (error) {
        // A whole read that doesn't add up to 0 (I-1).
        if (error instanceof RangeError) {
          throw new AppError('INVARIANT_VIOLATION', 'This group’s balances don’t add up.')
        }
        throw error
      }
    },
  )
