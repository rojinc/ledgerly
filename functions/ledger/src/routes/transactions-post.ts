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
      const existing = await getTransaction(db, params.id)
      const membership = await requireMember(db, userId, existing.groupId, {
        roles: ['admin', 'member'],
      })
      requireCreatorOrAdmin(membership, existing)
      requireUnlocked(existing)
      if (existing.status !== 'scheduled' && existing.status !== 'due') {
        invalid('Only a scheduled or due transaction can be posted.')
      }
      if (changes.shift && existing.kind !== 'shift')
        invalid('Only a shift has minutes and a rate.')
      const now = new Date()
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
      const planned = plan(input, 'posted', await loadLedger(db, membership))
      const oldShares = await listShares(db, existing.$id)
      await requireNotFinalizing(db, existing.groupId, [existing.date, date])

      const columns = {
        status: 'posted' as const,
        date,
        totalCents: planned.totalCents,
        inputJson: planned.inputJson,
      }
      const row = { ...existing, date }
      const person = membership.person.$id
      await withTransaction(db, async (tx) => {
        await guardTransaction(tx, db, existing.$id, person, ['scheduled', 'due'])
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
            changedColumns(existing as unknown as Record<string, unknown>, columns),
            now,
          ),
        )
      })
      return readView(db, existing.$id)
    }),
)
