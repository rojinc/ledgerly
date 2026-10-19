import { receiptsBodySchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMemberOf } from '@ledgerly/server/auth/require-member'
import { route } from '@ledgerly/server/http/create-handler'
import {
  activityWrite,
  getTransaction,
  guardGroup,
  guardTransaction,
  invalid,
  ledgerRoute,
  NO_SUCH_TRANSACTION,
  parseBody,
  readView,
  requireCreatorOrAdmin,
  requireNotFinalizing,
  requireUnlocked,
  Unchanged,
} from '@ledgerly/server/ledger/transactions'
import { attachReceipts, receiptsColumn, sameReceipts } from '../receipts'
import type { ServicesFor } from '../services'

export { receiptsBodySchema }

/**
 * `POST /transactions/{id}/receipts` (functions-api.md#ledger): sets the transaction's receipt
 * list, after checking each new file and limiting it to the group's team (permissions.md#storage).
 * It changes nothing else, so it builds no shares and guards no member rows. Sending the stored
 * list again writes nothing.
 */
export const updateReceipts = (services: ServicesFor) =>
  route('POST', '/transactions/:id/receipts', ({ userId, params, body, db, headers }) =>
    ledgerRoute(async () => {
      const { receiptFileIds } = parseBody(receiptsBodySchema, body)
      const found = await getTransaction(db, params.id)
      const { teams, files } = services({ headers })
      const membership = await requireMemberOf(
        db,
        teams,
        userId,
        found.groupId,
        NO_SUCH_TRANSACTION,
        {
          roles: ['admin', 'member'],
        },
      )
      requireCreatorOrAdmin(membership, found)
      if (found.status === 'void') invalid('A voided transaction can’t be edited.')
      if (found.status === 'running') invalid('Stop the timer before editing this shift.')
      requireUnlocked(found)

      const person = membership.person.$id
      try {
        await withTransaction(db, async (tx) => {
          // Everything below reads the row as it is now, so a void, lock or other receipt
          // change that committed meanwhile is never undone.
          const existing = await guardTransaction(tx, db, found.$id, person, [
            'scheduled',
            'due',
            'posted',
          ])
          const before = existing.receiptFileIds ?? []
          if (sameReceipts(before, receiptFileIds)) throw new Unchanged()
          await guardGroup(tx, db, membership.group)
          await requireNotFinalizing(db, existing.groupId, [existing.date])
          const now = new Date()
          await attachReceipts(files, db, tx, {
            groupId: existing.groupId,
            transactionId: existing.$id,
            fileIds: receiptFileIds,
            stored: before,
            now,
          })
          await tx.write(
            {
              action: 'update',
              tableId: TABLES.transactions,
              rowId: existing.$id,
              data: {
                receiptFileIds: receiptsColumn(receiptFileIds),
                // scheduling.md: an edited occurrence is kept apart from its schedule from now on.
                overridden: existing.scheduleId !== null || existing.overridden,
              },
            },
            activityWrite(
              existing,
              person,
              'transaction.updated',
              `Changed the receipts on “${existing.description}”`,
              { receiptFileIds: { before, after: receiptFileIds } },
              now,
            ),
          )
        })
      } catch (error) {
        if (!(error instanceof Unchanged)) throw error
      }
      return readView(db, found.$id)
    }),
  )
