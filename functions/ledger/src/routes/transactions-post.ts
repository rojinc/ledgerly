import type { TransactionKind } from '@ledgerly/core/constants/domain'
import type { LocalDate } from '@ledgerly/core/dates/local-date'
import {
  checkKindRules,
  postTransactionBodySchema,
  type TransactionTemplate,
} from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { route } from '@ledgerly/server/http/create-handler'
import { z } from 'zod'
import type { ServicesFor } from '../services'
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
  requireMemberOf,
  requireNotFinalizing,
  requireNotTooFarAhead,
  requireUnlocked,
  shareColumns,
  storedInput,
  teamRead,
  Unchanged,
} from './transactions-shared'

export { postTransactionBodySchema }

const kindRules = (kind: TransactionKind) =>
  z.unknown().superRefine((input, ctx) => checkKindRules(kind, input as TransactionTemplate, ctx))

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
      const membership = await requireMemberOf(db, services({ headers }).teams, userId, found, {
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
          // The body's payers and shift meet the stored input only here, so the result is
          // checked as a new transaction would be: payers only where the kind has them, at most
          // 15 people. buildShares turns minutes × rate past the maximum into VALIDATION_FAILED.
          parseBody(kindRules(existing.kind), input)
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
          await guardGroupAndMembers(tx, db, membership.group, ledger, planned.people)
          await requireNotFinalizing(db, existing.groupId, [existing.date, date])
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
