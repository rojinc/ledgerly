import { postTransactionBodySchema } from '@ledgerly/core/schemas/ledger'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMemberOf } from '@ledgerly/server/auth/require-member'
import { route } from '@ledgerly/server/http/create-handler'
import { postInTransaction } from '@ledgerly/server/ledger/post'
import {
  getTransaction,
  invalid,
  ledgerRoute,
  loadLedger,
  NO_SUCH_TRANSACTION,
  parseBody,
  readView,
  requireCreatorOrAdmin,
  requireUnlocked,
  Unchanged,
} from '@ledgerly/server/ledger/transactions'
import type { ServicesFor } from '../services'

export { postTransactionBodySchema }

/**
 * `POST /transactions/{id}/post` (functions-api.md#ledger): turns a `scheduled` or `due`
 * transaction into a `posted` one with shares, with the body's date, payers and shift
 * changes. A due bill is posted when it's paid, on the day it was paid.
 */
export const postTransaction = (services: ServicesFor) =>
  route('POST', '/transactions/:id/post', ({ userId, params, body, db, headers }) =>
    ledgerRoute(async () => {
      const changes = parseBody(postTransactionBodySchema, body)
      const found = await getTransaction(db, params.id)
      const membership = await requireMemberOf(
        db,
        services({ headers }).teams,
        userId,
        found.groupId,
        NO_SUCH_TRANSACTION,
        {
          roles: ['admin', 'member'],
        },
      )
      requireCreatorOrAdmin(membership, found)
      requireUnlocked(found)
      if (!['scheduled', 'due', 'posted'].includes(found.status)) {
        invalid('Only a scheduled or due transaction can be posted.')
      }
      if (changes.shift && found.kind !== 'shift') invalid('Only a shift has minutes and a rate.')
      const now = new Date()
      const ledger = await loadLedger(db, membership)

      const person = membership.person.$id
      try {
        await withTransaction(db, (tx) =>
          postInTransaction(tx, db, {
            rowId: found.$id,
            group: membership.group,
            ledger,
            actorPersonId: person,
            updatedBy: person,
            changes,
            now,
          }),
        )
      } catch (error) {
        if (!(error instanceof Unchanged)) throw error
      }
      return readView(db, found.$id)
    }),
  )
