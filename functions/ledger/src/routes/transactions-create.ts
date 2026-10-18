import type { Items } from '@ledgerly/core/generated/rows'
import { transactionInputSchema } from '@ledgerly/core/schemas/ledger'
import { TABLES } from '@ledgerly/server/appwrite/tables'
import { withTransaction } from '@ledgerly/server/appwrite/transaction'
import { requireMember } from '@ledgerly/server/auth/require-member'
import { AppError } from '@ledgerly/server/http/app-error'
import { route } from '@ledgerly/server/http/create-handler'
import { teamsFor } from '../teams'
import {
  activityWrite,
  findTransaction,
  guardGroupAndMembers,
  invalid,
  ledgerRoute,
  listItems,
  loadLedger,
  money,
  type Plan,
  parseBody,
  plan,
  readView,
  replaceRows,
  requireNotFinalizing,
  requireNotTooFarAhead,
  shareColumns,
  teamRead,
  transactionColumns,
} from './transactions-shared'

export const createTransactionSchema = transactionInputSchema

const OCCURRENCE_ID = /_\d{8}$/

/**
 * `POST /transactions` (functions-api.md#ledger): writes the transaction, its shares, items
 * and an activity row in one TablesDB transaction. A retry with the same `id` and content
 * gets the stored transaction back; different content is a CONFLICT.
 */
export const createTransaction = route('POST', '/transactions', ({ userId, body, db, headers }) =>
  ledgerRoute(async () => {
    const input = parseBody(createTransactionSchema, body)
    // scheduling.md: `<scheduleId>_<YYYYMMDD>` belongs to a schedule occurrence. A client
    // taking one would stop the scheduler creating it.
    if (OCCURRENCE_ID.test(input.id)) invalid('This id is kept for schedule occurrences.')
    const membership = await requireMember(db, teamsFor(headers), userId, input.groupId, {
      roles: ['admin', 'member'],
    })
    const now = new Date()
    requireNotTooFarAhead(input.date, membership.group, now)
    // permissions.md#storage: each file's permissions must be checked and reset first.
    if (input.receiptFileIds?.length) {
      throw new AppError('VALIDATION_FAILED', 'Receipts can’t be attached yet.')
    }
    const status = input.kind === 'bill' && input.bill?.status === 'due' ? 'due' : 'posted'
    const ledger = await loadLedger(db, membership)
    const planned = plan(input, status, ledger)
    const columns = transactionColumns(input, planned)

    const existing = await findTransaction(db, input.id)
    if (existing) {
      const same =
        Object.entries(columns).every(
          ([column, value]) => (existing as Record<string, unknown>)[column] === value,
        ) && sameItems(await listItems(db, existing.$id), planned)
      if (!same || existing.voidReason !== null) {
        throw new AppError('CONFLICT', 'A different transaction already has this ID.')
      }
      return readView(db, existing.$id)
    }

    const person = membership.person.$id
    const row = { $id: input.id, ...columns }
    const permissions = teamRead(input.groupId)
    await withTransaction(db, async (tx) => {
      await guardGroupAndMembers(tx, db, membership.group, ledger, planned.people)
      await requireNotFinalizing(db, input.groupId, [input.date])
      await tx.write(
        {
          action: 'create',
          tableId: TABLES.transactions,
          rowId: input.id,
          data: {
            ...columns,
            scheduleId: null,
            overridden: false,
            statementId: null,
            receiptFileIds: null,
            startedAt: null,
            remindedAt: null,
            voidReason: null,
            createdBy: person,
            updatedBy: person,
          },
          permissions,
        },
        ...replaceRows(
          TABLES.shares,
          [],
          planned.shares.map((share) => shareColumns(row, share)),
          permissions,
        ),
        ...replaceRows(
          TABLES.items,
          [],
          planned.items.map((item) => ({ transactionId: input.id, ...item })),
          permissions,
        ),
        activityWrite(
          row,
          person,
          'transaction.created',
          `Added “${input.description}” (${money(planned.totalCents, membership.group)})`,
          null,
          now,
        ),
      )
    })
    return readView(db, input.id)
  }),
)

function sameItems(existing: readonly Items[], planned: Plan): boolean {
  return (
    existing.length === planned.items.length &&
    existing.every((item, index) => {
      const want = planned.items[index]
      return (
        want !== undefined &&
        item.name === want.name &&
        item.quantity === want.quantity &&
        item.amountCents === want.amountCents &&
        item.category === want.category &&
        item.splitJson === want.splitJson
      )
    })
  )
}
