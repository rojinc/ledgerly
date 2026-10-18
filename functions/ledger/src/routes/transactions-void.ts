import { voidTransactionBodySchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { route } from '@ledgerly/server/http/create-handler'
import {
  activityWrite,
  getTransaction,
  guardTransaction,
  invalid,
  ledgerRoute,
  listShares,
  parseBody,
  readView,
  requireCreatorOrAdmin,
  requireNotFinalizing,
  requireUnlocked,
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
      const existing = await getTransaction(db, params.id)
      const membership = await requireMember(db, userId, existing.groupId, {
        roles: ['admin', 'member'],
      })
      requireCreatorOrAdmin(membership, existing)
      requireUnlocked(existing)
      if (existing.status === 'void') invalid('This transaction is already voided.')
      const shares = await listShares(db, existing.$id)
      await requireNotFinalizing(db, existing.groupId, [existing.date])

      const person = membership.person.$id
      const before = existing.status
      await withTransaction(db, async (tx) => {
        await guardTransaction(tx, db, existing.$id, person, [before])
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
              status: { before, after: 'void' },
              voidReason: { before: null, after: reason },
            },
            new Date(),
          ),
        )
      })
      return readView(db, existing.$id)
    }),
)
