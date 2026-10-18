import { voidTransactionBodySchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { route } from '@ledgerly/server/http/create-handler'
import {
  activityWrite,
  getTransaction,
  guardGroup,
  guardTransaction,
  invalid,
  ledgerRoute,
  listShares,
  parseBody,
  readView,
  requireCreatorOrAdmin,
  requireNotFinalizing,
  requireUnlocked,
  Unchanged,
} from './transactions-shared'

export { voidTransactionBodySchema }

/**
 * `POST /transactions/{id}/void` (functions-api.md#ledger; ledger.md#editing): sets status
 * `void` with the reason and deletes the shares. The row, its items and its input stay, and a
 * voided schedule occurrence keeps blocking its re-creation (scheduling.md).
 */
export const voidTransaction = route(
  'POST',
  '/transactions/:id/void',
  ({ userId, params, body, db }) =>
    ledgerRoute(async () => {
      const { reason } = parseBody(voidTransactionBodySchema, body)
      const found = await getTransaction(db, params.id)
      const membership = await requireMember(db, userId, found.groupId, {
        roles: ['admin', 'member'],
      })
      requireCreatorOrAdmin(membership, found)
      requireUnlocked(found)

      const person = membership.person.$id
      try {
        await withTransaction(db, async (tx) => {
          // Everything below reads the row and its shares as they are now, so a share that an
          // edit added meanwhile is deleted too.
          const existing = await guardTransaction(tx, db, found.$id, person, [
            'scheduled',
            'running',
            'due',
            'posted',
            'void',
          ])
          if (existing.status === 'void') {
            // A retry of the same void gets the voided transaction back.
            if (existing.voidReason === reason) throw new Unchanged()
            invalid('This transaction is already voided.')
          }
          await guardGroup(tx, db, membership.group)
          await requireNotFinalizing(db, existing.groupId, [existing.date])
          const shares = await listShares(db, existing.$id)
          await tx.write(
            {
              action: 'update',
              tableId: TABLES.transactions,
              rowId: existing.$id,
              data: { status: 'void', voidReason: reason },
            },
            ...shares.map((share) => ({
              action: 'delete' as const,
              tableId: TABLES.shares,
              rowId: share.$id,
            })),
            activityWrite(
              existing,
              person,
              'transaction.voided',
              `Voided “${existing.description}”`,
              {
                status: { before: existing.status, after: 'void' },
                voidReason: { before: null, after: reason },
              },
              new Date(),
            ),
          )
        })
      } catch (error) {
        if (!(error instanceof Unchanged)) throw error
      }
      return readView(db, found.$id)
    }),
)
