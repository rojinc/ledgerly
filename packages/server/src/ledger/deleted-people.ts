import type { TransactionKind } from '@ledgerly/core/constants/domain'
import type { Members, Persons } from '@ledgerly/core/generated/rows'
import { everyPersonId, type TransactionTemplate } from '@ledgerly/core/schemas/ledger'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import type { Tx } from '../appwrite/transaction'
import { randomId } from '../identity/random-id'
import { invalid, type Ledger } from './transactions'

// Balances with a former member can still be settled.
const EXEMPT: readonly TransactionKind[] = ['payment', 'adjustment']

/**
 * functions-api.md#ledger ("Deleted people"): VALIDATION_FAILED when `input` names a person
 * who deleted their account, in a group where they had joined, and `before` (the stored input)
 * didn't name them already. Payments and adjustments are exempt, and a placeholder is never
 * refused, so the answer can't show the deletion (D-016). Call it after `guardGroupAndMembers`.
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
    input,
    before,
    guard = false,
  }: {
    kind: TransactionKind
    input: TransactionTemplate
    before?: TransactionTemplate
    guard?: boolean
  },
): Promise<void> {
  if (EXEMPT.includes(kind)) return
  const named = new Set(before ? everyPersonId(before) : [])
  const added = [...new Set(everyPersonId(input))].filter((personId) => !named.has(personId))
  const members = await Promise.all(
    added.map((personId) =>
      db.getRow<Members>({
        databaseId: DATABASE_ID,
        transactionId: tx.id,
        tableId: TABLES.members,
        rowId: ledger.memberRows.get(personId) as string,
      }),
    ),
  )
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
  const persons = await Promise.all(
    joined.map((personId) =>
      db.getRow<Persons>({
        databaseId: DATABASE_ID,
        transactionId: tx.id,
        tableId: TABLES.persons,
        rowId: personId,
      }),
    ),
  )
  if (persons.some((person) => person.deletedAt)) {
    invalid('This names someone who has deleted their account.')
  }
}
