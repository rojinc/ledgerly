import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { route } from '@ledgerly/server/http/create-handler'
import {
  activityWrite,
  changedColumns,
  getTransaction,
  guardTransaction,
  invalid,
  ledgerRoute,
  listItems,
  listShares,
  loadLedger,
  money,
  parseBody,
  plan,
  readView,
  replaceRows,
  requireCreatorOrAdmin,
  requireNotFinalizing,
  requireNotTooFarAhead,
  requireUnlocked,
  shareColumns,
  teamRead,
  transactionColumns,
} from './transactions-shared'

export const updateTransactionSchema = transactionInputSchema

/**
 * `PATCH /transactions/{id}` (functions-api.md#ledger): replaces the transaction with the
 * body, rebuilds its shares and items, and records before and after in an activity row
 * (ledger.md#editing). Its status stays: posting a due bill is `/post`.
 */
export const updateTransaction = route(
  'PATCH',
  '/transactions/:id',
  ({ userId, params, body, db }) =>
    ledgerRoute(async () => {
      const input = parseBody(updateTransactionSchema, body)
      if (input.id !== params.id) invalid('The body’s id must match the transaction.')
      const existing = await getTransaction(db, params.id)
      const membership = await requireMember(db, userId, existing.groupId, {
        roles: ['admin', 'member'],
      })
      requireCreatorOrAdmin(membership, existing)
      if (input.groupId !== existing.groupId) invalid('A transaction can’t move to another group.')
      if (input.kind !== existing.kind) invalid('A transaction’s kind can’t change.')
      if (existing.status === 'void') invalid('A voided transaction can’t be edited.')
      if (existing.status === 'running') invalid('Stop the timer before editing this shift.')
      if (
        existing.kind === 'bill' &&
        (input.bill?.status === 'due') !== (existing.status === 'due')
      ) {
        invalid('Mark a due bill as paid with “post”, not by editing it.')
      }
      requireUnlocked(existing)
      const now = new Date()
      requireNotTooFarAhead(input.date, membership.group, now)
      if (input.receiptFileIds?.length) invalid('Receipts can’t be attached yet.')

      const planned = plan(input, existing.status, await loadLedger(db, membership))
      const content = transactionColumns(input, planned)
      const columns = {
        ...content,
        // scheduling.md: an edited occurrence is kept apart from its schedule from now on.
        overridden: existing.scheduleId !== null || existing.overridden,
        // A new due date gets its own reminder (functions-api.md#ledger).
        remindedAt: planned.dueOn === existing.dueOn ? existing.remindedAt : null,
      }
      const [oldShares, oldItems] = await Promise.all([
        listShares(db, existing.$id),
        listItems(db, existing.$id),
      ])
      const row = { $id: existing.$id, ...columns }
      const shareData = planned.shares.map((share) => shareColumns(row, share))
      const itemData = planned.items.map((item) => ({ transactionId: existing.$id, ...item }))
      // What the edit changes, for the activity row and to skip an edit that changes nothing.
      const changes = changedColumns(existing as unknown as Record<string, unknown>, content)
      const unchanged =
        Object.keys(changes).length === 0 &&
        sameRows(oldShares, shareData) &&
        sameRows(oldItems, itemData)
      if (unchanged) return readView(db, existing.$id)
      await requireNotFinalizing(db, existing.groupId, [existing.date, input.date])

      const person = membership.person.$id
      const permissions = teamRead(existing.groupId)
      await withTransaction(db, async (tx) => {
        await guardTransaction(tx, db, existing.$id, person, [existing.status])
        await tx.write(
          { action: 'update', tableId: TABLES.transactions, rowId: existing.$id, data: columns },
          ...replaceRows(TABLES.shares, oldShares, shareData, permissions),
          ...replaceRows(TABLES.items, oldItems, itemData, permissions),
          activityWrite(
            row,
            person,
            'transaction.updated',
            changes.totalCents
              ? `Changed “${input.description}”: ${money(existing.totalCents, membership.group)} → ${money(planned.totalCents, membership.group)}`
              : `Changed “${input.description}”`,
            changes,
            now,
          ),
        )
      })
      return readView(db, existing.$id)
    }),
)

// Rows hold the same data, in the same order, as `data`.
function sameRows(
  rows: readonly Record<string, unknown>[],
  data: readonly Record<string, unknown>[],
) {
  return (
    rows.length === data.length &&
    data.every((want, index) => Object.keys(changedColumns(rows[index] ?? {}, want)).length === 0)
  )
}
