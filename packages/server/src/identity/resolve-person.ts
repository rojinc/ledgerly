import type { Identities, IdentitiesType, Persons } from '@ledgerly/core/generated/rows'
import { identityKey, normalizePhone } from '@ledgerly/core/identity/normalize'
import { ID, Query } from 'node-appwrite'
import type { Db } from '../appwrite/client'
import { DATABASE_ID, TABLES } from '../appwrite/tables'
import type { Write } from '../appwrite/transaction'
import { randomId } from './random-id'

export type PersonInput = { displayName: string; email?: string; phone?: string }

/** The person to use, and the rows to stage for a new placeholder (none for a known person). */
export type ResolvedPerson = { personId: string; writes: Write[] }

/**
 * identity-and-invites.md#adding-someone-to-a-group, step 2: the person an email or phone
 * belongs to, or a new placeholder with unverified identity rows. `region` is the default
 * country for a phone typed without one. Throws a RangeError for an invalid email or phone,
 * which the route turns into VALIDATION_FAILED.
 *
 * It only reads: stage `writes` in the caller's transaction, and pass that transaction's ID to
 * see rows it already staged. If another request creates the same identity key first, the
 * commit fails with 409 (the key is unique), and resolving again finds that person.
 */
export async function resolvePerson(
  db: Db,
  input: PersonInput,
  region: string,
  transactionId?: string,
): Promise<ResolvedPerson> {
  const identities: Array<{ type: IdentitiesType; key: string }> = []
  if (input.email !== undefined) {
    identities.push({ type: 'email', key: identityKey('email', input.email) })
  }
  if (input.phone !== undefined) {
    identities.push({
      type: 'phone',
      key: identityKey('phone', normalizePhone(input.phone, region)),
    })
  }
  // Email first, so it decides when the email and phone belong to two different persons
  // (D-016). A found person is used as it is (or the person it was merged into): never merged
  // here, and an unknown key is never attached to it, so a stranger's typo can't land on
  // someone else.
  for (const { key } of identities) {
    const { rows } = await db.listRows<Identities>({
      databaseId: DATABASE_ID,
      tableId: TABLES.identities,
      queries: [Query.equal('key', key), Query.limit(1)],
      transactionId,
      total: false,
    })
    if (rows[0]) {
      return { personId: await mergedTarget(db, rows[0].personId, transactionId), writes: [] }
    }
  }
  // A placeholder has no permissions (server only) and a random ID (data-model.md#persons).
  const personId = randomId()
  const writes: Write[] = [
    {
      action: 'create',
      tableId: TABLES.persons,
      rowId: personId,
      data: { displayName: input.displayName },
      permissions: [],
    },
    ...identities.map(
      ({ type, key }): Write => ({
        action: 'create',
        tableId: TABLES.identities,
        rowId: ID.unique(),
        data: { key, type, personId, verified: false },
        permissions: [],
      }),
    ),
  ]
  return { personId, writes }
}

// Merges only ever go from a placeholder into a person with an account, so a chain is short.
// The cap only guards against a broken row.
const MAX_MERGES = 10

/**
 * identity-and-invites.md#merging-two-persons, step 1: a merge marks P with `mergedInto` before
 * it moves P's identities, so a key can still point at P while it runs. The person to use is
 * the end of the chain, so adding P's email mid-merge adds U.
 */
async function mergedTarget(db: Db, personId: string, transactionId?: string): Promise<string> {
  let current = personId
  for (let step = 0; step < MAX_MERGES; step++) {
    const person = await db.getRow<Persons>({
      databaseId: DATABASE_ID,
      tableId: TABLES.persons,
      rowId: current,
      transactionId,
    })
    if (!person.mergedInto) return current
    current = person.mergedInto
  }
  throw new Error('A person was merged too many times in a row')
}
