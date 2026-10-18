import type { LocalDate } from '@ledgerly/core/dates/local-date'
import { postTransactionBodySchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { route } from '@ledgerly/server/http/create-handler'
import {
  activityWrite,
  changedColumns,
  getTransaction,
  guardGroupAndMembers,
  guardTransaction,
  invalid,
  ledgerRoute,
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
  storedInput,
  teamRead,
  Unchanged,
} from './transactions-shared'

export { postTransactionBodySchema }

/**
 * `POST /transactions/{id}/post` (functions-api.md#ledger): turns a `scheduled` or `due`
 * transaction into a `posted` one with shares, with the body's date, payers and shift
 * changes. A due bill is posted when it's paid, on the day it was paid.
 */
export const postTransaction = route(
  'POST',
  '/transactions/:id/post',
  ({ userId, params, body, db }) =>
    ledgerRoute(async () => {
      const changes = parseBody(postTransactionBodySchema, body)
      const found = await getTransaction(db, params.id)
      const membership = await requireMember(db, userId, found.groupId, {
        roles: ['admin', 'member'],
      })
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
        await withTransaction(db, async (tx) => {
          // Everything below reads the row, its items and stored input as they are now.
          const existing = await guardTransaction(tx, db, found.$id, person, [
            'scheduled',
            'due',
            'posted',
          ])
          const date = (changes.date ?? existing.date) as LocalDate
          requireNotTooFarAhead(date, membership.group, now)
          const stored = await storedInput(db, existing)
          const input = {
            ...stored,
            date,
            ...(changes.payers ? { payers: changes.payers } : {}),
            ...(stored.shift ? { shift: { ...stored.shift, ...changes.shift } } : {}),
            ...(stored.bill ? { bill: { ...stored.bill, status: 'paid' as const } } : {}),
          }
          // The shift's minutes × rate can only be checked against its stored values here, so
          // buildShares turns one past the maximum into VALIDATION_FAILED.
          const planned = plan(input, 'posted', ledger)
          const columns = {
            status: 'posted' as const,
            date,
            totalCents: planned.totalCents,
            inputJson: planned.inputJson,
          }
          const changed = changedColumns(existing as unknown as Record<string, unknown>, columns)
          if (existing.status === 'posted') {
            // A retry of a post that went through gets the posted transaction back.
            if (Object.keys(changed).length === 0) throw new Unchanged()
            invalid('Only a scheduled or due transaction can be posted.')
          }
          await requireNotFinalizing(db, existing.groupId, [existing.date, date])
          await guardGroupAndMembers(tx, db, membership.group, ledger, planned.shares)
          const oldShares = await listShares(db, existing.$id)
          const row = { ...existing, date }
          await tx.write(
            { action: 'update', tableId: TABLES.transactions, rowId: existing.$id, data: columns },
            // A transaction that isn't posted has no shares (I-6), so this replaces none.
            ...replaceRows(
              TABLES.shares,
              oldShares,
              planned.shares.map((share) => shareColumns(row, share)),
              teamRead(existing.groupId),
            ),
            activityWrite(
              row,
              person,
              'transaction.posted',
              `Posted “${existing.description}” (${money(planned.totalCents, membership.group)})`,
              changed,
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
