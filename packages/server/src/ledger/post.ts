import type { TransactionKind } from '@ledgerly/core/constants/domain'
import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Groups, Transactions } from '@ledgerly/core/generated/rows'
import {
  checkKindRules,
  type PostTransactionBody,
  type TransactionTemplate,
} from '@ledgerly/core/schemas/ledger'
import { z } from 'zod'
import type { Db } from '../appwrite/client'
import { TABLES } from '../appwrite/tables'
import type { Tx } from '../appwrite/transaction'
import { balanceWrite } from './balances'
import { refuseDeletedPeople } from './deleted-people'
import {
  activityWrite,
  changedColumns,
  guardGroupAndMembers,
  guardTransaction,
  invalid,
  type Ledger,
  listShares,
  money,
  parseBody,
  plan,
  Raced,
  replaceRows,
  requireNotFinalizing,
  requireNotTooFarAhead,
  shareColumns,
  storedInput,
  teamRead,
  Unchanged,
} from './transactions'

const kindRules = (kind: TransactionKind) =>
  z.unknown().superRefine((input, ctx) => checkKindRules(kind, input as TransactionTemplate, ctx))

/**
 * Posts the `scheduled` or `due` transaction `rowId` in `tx`, with `changes` to its date,
 * payers and shift (functions-api.md#ledger): the ledger's `POST /transactions/{id}/post`, and
 * the scheduler's auto-post (scheduling.md#step-2-auto-post). It guards the row, reads it and
 * its stored input as they are now, plans it (`ledger`'s caller pays when the input names no
 * payers), guards the group and the people it names, and writes the shares and an activity
 * row by `actorPersonId` (null for a system job). A retry of a post that went through throws
 * `Unchanged`. `ready`, if given, must hold for the row as guarded, or it throws `Raced` so the
 * caller reads it again: the scheduler's check that the row is still due to post.
 */
export async function postInTransaction(
  tx: Tx,
  db: Db,
  {
    rowId,
    group,
    ledger,
    actorPersonId,
    updatedBy,
    changes,
    now,
    ready,
  }: {
    rowId: string
    group: Groups
    ledger: Ledger
    actorPersonId: string | null
    updatedBy: string
    changes: PostTransactionBody
    now: Date
    ready?: (staged: Transactions) => boolean
  },
): Promise<void> {
  // Everything below reads the row, its items and stored input as they are now.
  const existing = await guardTransaction(tx, db, rowId, updatedBy, ['scheduled', 'due', 'posted'])
  if (ready && !ready(existing)) throw new Raced()
  const date = (changes.date ?? existing.date) as LocalDate
  requireNotTooFarAhead(date, group, now)
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
  await guardGroupAndMembers(tx, db, group, ledger, planned.people)
  await refuseDeletedPeople(tx, db, ledger, { kind: existing.kind, input, before: stored })
  await requireNotFinalizing(db, existing.groupId, [existing.date, date])
  const oldShares = await listShares(db, existing.$id)
  const row = { ...existing, date }
  const shares = planned.shares.map((share) => shareColumns(row, share))
  const balances = await balanceWrite(db, existing.groupId, oldShares, shares)
  await tx.write(
    { action: 'update', tableId: TABLES.transactions, rowId: existing.$id, data: columns },
    // A transaction that isn't posted has no shares (I-6), so this replaces none.
    ...replaceRows(TABLES.shares, oldShares, shares, teamRead(existing.groupId)),
    activityWrite(
      row,
      actorPersonId,
      'transaction.posted',
      `Posted “${existing.description}” (${money(planned.totalCents, group)})`,
      changed,
      now,
    ),
    ...balances,
  )
}
