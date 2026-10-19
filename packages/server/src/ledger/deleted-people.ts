import type { TransactionKind } from '@ledgerly/core/constants/domain'
import type { LocalDate } from '@ledgerly/core/dates/local-date'
import type { Members, Persons } from '@ledgerly/core/generated/rows'
import type { TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import { Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import type { Tx } from '../appwrite/transaction'
import { randomId } from '../identity/random-id'
import { invalid, type Ledger, plan } from './transactions'

// Balances with a former member can still be settled.
const EXEMPT: readonly TransactionKind[] = ['payment', 'adjustment']

// Large enough that the default split gives everyone it takes at least a cent (15 people, `days`
// over a long period), far below MAX_AMOUNT_CENTS.
const NOMINAL_CENTS = 1_000_000

/**
 * functions-api.md#ledger ("Deleted people"): VALIDATION_FAILED when `people` (everyone the write
 * names, as `plan()` lists them: shares included) has a person who deleted their account, in a
 * group where they had joined, and `before` (the people the stored input names and its shares
 * hold) doesn't. An `unposted` row made before the deletion also keeps those its stored input
 * splits it to. Payments and adjustments are exempt, and a placeholder is never refused, so the
 * answer can't show the deletion (D-016). Call it after `guardGroupAndMembers`.
 *
 * With `guard`, each such person's row gets a fresh `rev` before `deletedAt` is read, so a
 * deletion racing the write fails one of the two commits. A schedule needs it: the deletion ends
 * the schedules that name them by a query, which a template saved meanwhile could miss. A
 * transaction doesn't: one that races the deletion is the same as one made just before it.
 */
export async function refuseDeletedPeople(
  tx: Tx,
  db: Db,
  ledger: Ledger,
  {
    kind,
    people,
    before = [],
    unposted,
    guard = false,
  }: {
    kind: TransactionKind
    people: readonly string[]
    before?: readonly string[]
    // A stored row not yet posted: when it was made, and its input as stored.
    unposted?: { madeAt: string; input: StoredInput }
    guard?: boolean
  },
): Promise<void> {
  if (EXEMPT.includes(kind)) return
  const named = new Set(before)
  // A shift names the group's two members, even one of no minutes that gives no shares.
  const all = kind === 'shift' ? [...people, ...ledger.memberIds] : people
  const added = [...new Set(all)].filter((personId) => !named.has(personId))
  if (added.length === 0) return
  const { rows: members } = await db.listRows<Members>({
    databaseId: DATABASE_ID,
    transactionId: tx.id,
    tableId: TABLES.members,
    queries: [
      Query.equal(
        '$id',
        added.map((personId) => ledger.memberRows.get(personId) as string),
      ),
      Query.limit(added.length),
    ],
  })
  const joined = members
    .filter((member) => member.status !== 'placeholder')
    .map((member) => member.personId)
  if (joined.length === 0) return
  if (guard) {
    await tx.write(
      ...joined.map((personId) => ({
        action: 'update' as const,
        tableId: TABLES.persons,
        rowId: personId,
        data: { rev: randomId() },
      })),
    )
  }
  const { rows: deleted } = await db.listRows<Persons>({
    databaseId: DATABASE_ID,
    transactionId: tx.id,
    tableId: TABLES.persons,
    queries: [Query.equal('$id', joined), Query.isNotNull('deletedAt'), Query.limit(joined.length)],
  })
  if (deleted.length === 0) return
  const kept = unposted ? splitTo(unposted.input, ledger) : []
  const madeBefore = (person: Persons) =>
    unposted !== undefined &&
    Date.parse(unposted.madeAt) < Date.parse(person.deletedAt as string) &&
    kept.includes(person.$id)
  if (!deleted.every(madeBefore)) invalid('This names someone who has deleted their account.')
}

type StoredInput = TransactionTemplate & { kind: TransactionKind; date: LocalDate }

// Who an unposted row's stored input splits it to, whatever its amount: a shift's two people, or
// those its default split takes. Never a payer the server fills in. An explicit split or items
// name their people already (`before`). The default split names them only through its shares,
// which a zero total, a refund or a share rounded to nothing would hide, so it's planned at a
// nominal amount, paid by the server's filled-in payer.
function splitTo(input: StoredInput, ledger: Ledger): readonly string[] {
  if (input.kind === 'shift') return ledger.memberIds
  if (input.split || input.items?.length) return []
  const nominal = { ...input, payers: undefined, totalCents: NOMINAL_CENTS }
  return plan(nominal, 'posted', ledger)
    .shares.filter((share) => share.receivedCents > 0)
    .map((share) => share.personId)
}

/**
 * functions-api.md#ledger: VALIDATION_FAILED while a schedule's creator has `deletedAt`, so an
 * edit can't reopen a schedule the deletion ended. Their row gets a fresh `rev` first: a deletion
 * that skips the schedule as already ended still fails one of the two commits.
 */
export async function refuseDeletedCreator(tx: Tx, db: Db, creator: string): Promise<void> {
  await tx.write({
    action: 'update',
    tableId: TABLES.persons,
    rowId: creator,
    data: { rev: randomId() },
  })
  const person = await db.getRow<Persons>({
    databaseId: DATABASE_ID,
    transactionId: tx.id,
    tableId: TABLES.persons,
    rowId: creator,
  })
  if (person.deletedAt) {
    invalid('Someone who has deleted their account made this schedule. End it, or add a new one.')
  }
}
